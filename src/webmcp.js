/*
 *
 *  Air Horner - WebMCP tool exposure
 *  Copyright 2015 Google Inc. All rights reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the 'License');
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an 'AS IS' BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License
 *
 */

/**
 * Declares the Air Horner's tools for in-page AI agents via WebMCP
 * (`document.modelContext.registerTool()`), so an assistant can sound and
 * silence the horn the same way a person pressing the button does.
 *
 * The tools route through the public `AirHorn` API, so the button's
 * `aria-pressed` state, the `.horning` class, the app badge and the analytics
 * event all stay correct whichever way the horn was triggered.
 *
 * Registration is a no-op in browsers without WebMCP.
 *
 * ## Hostile callers (airhorn-9e9)
 *
 * Anything on the page can call these tools, with anything: the wrong types, a
 * megabyte of text, arguments that never arrive, or a thousand calls a second.
 * So every `execute()` obeys one contract, and the fuzz suite
 * (`tests/webmcp-fuzz.test.mjs`) asserts it for each hostile shape:
 *
 *  - It resolves. Nothing a caller can pass turns into an unhandled rejection.
 *    Unexpected failures come back as `{ ..., code, error }`.
 *  - The only rejection is a real cancellation (`AbortSignal`), because the
 *    platform is retracting the call, not the tool failing.
 *  - Input is validated, never coerced: `loop: 'true'` is refused rather than
 *    silently treated as false, because an agent that asked to loop and got a
 *    single blast has been lied to.
 *  - Errors name the *type* they got, never the payload: repeating a hostile
 *    megabyte string back is itself the attack.
 *  - `play_horn` supersedes whatever is already sounding and is rate limited,
 *    so repeated calls cannot stack buffers or oscillators; `stop_horn` is
 *    never queued, rate limited or cancelled (silence must always be possible);
 *    and a start that never reports back is abandoned and silenced rather than
 *    wedging the tool.
 */

// A start that has not reported back in this long is abandoned and silenced, so
// one stuck `AudioContext.resume()`/fetch cannot block every later call.
const DEFAULT_START_TIMEOUT_MS = 5000;
// Starts accepted per rolling window. Generous for a horn, bounded for a flood:
// the tool can never be made to allocate unbounded audio nodes.
const DEFAULT_RATE_LIMIT = { max: 20, windowMs: 1000 };

const CODE = {
  invalidInput: 'invalid_input',
  audioUnavailable: 'audio_unavailable',
  notStarted: 'not_started',
  rateLimited: 'rate_limited',
  timeout: 'timeout',
  internal: 'internal',
};

/** The JSON type of a value, for an error message that names no payload. */
const typeName = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const isObjectInput = (value) =>
  value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value));

const abortError = (signal) => {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' && reason ? reason : 'Aborted');
  err.name = 'AbortError';
  return err;
};

const isAbort = (err) => err?.name === 'AbortError';

/**
 * The horn's public state, read so that a broken instance cannot throw here.
 * `degraded` records that an accessor threw, so `get_horn_state` can say the
 * values are fallbacks instead of reporting a broken instance as healthy.
 */
function readState(airhorn) {
  let playing = false;
  let loop = false;
  let hasAudioContext = false;
  let degraded = false;
  try {
    playing = airhorn.isPlaying() === true;
  } catch {
    degraded = true;
  }
  try {
    loop = airhorn.isLooping() === true;
  } catch {
    degraded = true;
  }
  try {
    hasAudioContext = airhorn.hasAudioContext() === true;
  } catch {
    degraded = true;
  }
  return { playing, loop, hasAudioContext, degraded };
}

/**
 * A structured refusal: the horn's current state plus a machine-readable code
 * and a message that never echoes the caller's payload.
 */
const refusal = (airhorn, code, error) => {
  const { playing, loop } = readState(airhorn);
  return { playing, loop, code, error };
};

/** Best-effort silence; used when a start is abandoned or a call is cancelled. */
const quietStop = async (airhorn) => {
  try {
    await airhorn.stop({ immediate: true });
  } catch {}
};

/**
 * Rejects with `{code: 'timeout'}` if `promise` has not settled in `ms`.
 * The listener is always cleared so an abandoned operation leaves no timer.
 */
function withTimeout(promise, ms) {
  let timer = null;
  const bound = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Timed out after ${ms}ms`);
      err.code = CODE.timeout;
      reject(err);
    }, ms);
    timer?.unref?.();
  });
  return Promise.race([promise, bound]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * Builds the WebMCP tool definitions bound to one `AirHorn` instance.
 *
 * @param {object} airhorn an `AirHorn` instance
 * @param {{ startTimeoutMs?: number, rateLimit?: { max: number, windowMs: number } }} [options]
 *   tuning hooks (used by the fuzz suite); the defaults are the contract
 * @returns {Array<object>} tool definitions for `registerTool()`
 */
export function createHornTools(airhorn, options = {}) {
  const startTimeoutMs = Number.isFinite(options.startTimeoutMs) && options.startTimeoutMs > 0
    ? options.startTimeoutMs
    : DEFAULT_START_TIMEOUT_MS;
  const max = Number.isInteger(options.rateLimit?.max) && options.rateLimit.max > 0
    ? options.rateLimit.max
    : DEFAULT_RATE_LIMIT.max;
  const windowMs = Number.isFinite(options.rateLimit?.windowMs) && options.rateLimit.windowMs > 0
    ? options.rateLimit.windowMs
    : DEFAULT_RATE_LIMIT.windowMs;

  // Starts admitted in the current window, oldest first.
  const startTimes = [];
  const takeStartSlot = (now = Date.now()) => {
    while (startTimes.length > 0 && now - startTimes[0] >= windowMs) startTimes.shift();
    if (startTimes.length >= max) return false;
    startTimes.push(now);
    return true;
  };

  // Starts run one at a time: two concurrent starts would each pass the
  // "nothing is playing yet" check and leave two horns sounding at once.
  // Stops deliberately do not queue behind this - see stop_horn.
  let queue = Promise.resolve();
  const serialise = (task) => {
    const run = queue.then(task, task);
    queue = run.then(() => {}, () => {});
    return run;
  };

  return [
    {
      name: 'play_horn',
      description:
        'Sound the Air Horner. Starts audio playback, pressed state and app badge, exactly like pressing the on-screen horn button. A call replaces anything already sounding (restarting the blast), and calls are rate limited, so repeated or concurrent invocations leave exactly one horn playing. Pass `loop: true` to keep it sounding until stop_horn is called, `loop: false` (the default) for a single blast. `loop` must be a real boolean: strings, numbers and objects are refused with a structured error rather than guessed at. Returns {playing, loop} when this call started the horn. A refused call returns {playing, loop, code, error} and changes nothing: code is one of invalid_input, audio_unavailable, not_started, rate_limited, timeout or internal, so treat a present code as the refusal and playing as the current state of the horn (it can already be sounding from an earlier call).',
      inputSchema: {
        type: 'object',
        properties: {
          loop: {
            type: 'boolean',
            description:
              'Keep the horn sounding until stop_horn is called. Defaults to false: a single blast.',
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      async execute(input = {}, callOptions = {}) {
        try {
          if (!isObjectInput(input)) {
            return refusal(
              airhorn,
              CODE.invalidInput,
              `play_horn: input must be an object, received a ${typeName(input)}. Nothing was started.`,
            );
          }
          if (input?.loop !== undefined && typeof input.loop !== 'boolean') {
            return refusal(
              airhorn,
              CODE.invalidInput,
              `play_horn: "loop" must be a boolean, received a ${typeName(input.loop)}. Nothing was started.`,
            );
          }

          const signal = callOptions?.signal;
          if (signal?.aborted) throw abortError(signal);

          if (!takeStartSlot()) {
            return refusal(
              airhorn,
              CODE.rateLimited,
              `play_horn: too many calls; at most ${max} starts per ${windowMs}ms. Nothing was changed: read get_horn_state, then retry.`,
            );
          }

          const loop = input?.loop === true;

          return await serialise(async () => {
            if (signal?.aborted) throw abortError(signal);

            // One horn: a new blast replaces the old one instead of stacking on it.
            if (readState(airhorn).playing) await quietStop(airhorn);
            if (signal?.aborted) throw abortError(signal);

            let started = false;
            try {
              started = await withTimeout(Promise.resolve(airhorn.start({ loop })), startTimeoutMs);
            } catch (err) {
              if (err?.code === CODE.timeout) {
                // Abandoning the start would otherwise play a delayed blast.
                await quietStop(airhorn);
                return refusal(
                  airhorn,
                  CODE.timeout,
                  `play_horn: the horn did not start within ${startTimeoutMs}ms, so it was stopped. Nothing is playing.`,
                );
              }
              return refusal(airhorn, CODE.internal, 'play_horn: the horn failed to start. Nothing is playing.');
            }

            if (signal?.aborted) {
              await quietStop(airhorn);
              throw abortError(signal);
            }

            const state = readState(airhorn);
            if (started !== true || state.playing !== true) {
              if (!state.hasAudioContext) {
                return {
                  playing: false,
                  loop,
                  code: CODE.audioUnavailable,
                  error: 'Web Audio is unavailable in this browser, so the horn cannot sound.',
                };
              }
              return {
                playing: false,
                loop,
                code: CODE.notStarted,
                error: 'The horn could not be started: audio is blocked, or stop_horn arrived before it began.',
              };
            }

            return { playing: true, loop };
          });
        } catch (err) {
          if (isAbort(err)) throw err;
          return refusal(airhorn, CODE.internal, 'play_horn: unexpected failure. Nothing is playing.');
        }
      },
    },
    {
      name: 'stop_horn',
      description:
        'Silence the Air Horner immediately. Always honoured: it is never queued behind a start, rate limited, cancelled by an aborted call, or refused for bad arguments - silence must always be possible - so it is also safe to call when nothing is sounding. Takes no arguments; anything provided is ignored. Returns {playing: false, loop: false}.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      async execute(_input = {}, _callOptions = {}) {
        try {
          // Deliberately not serialised, not rate limited, not abortable and not
          // argument-validated: a start still waiting on audio, or a hostile
          // caller, must not be able to hold silence hostage.
          await airhorn.stop({ immediate: true });
          return { playing: readState(airhorn).playing, loop: false };
        } catch (err) {
          return refusal(airhorn, CODE.internal, 'stop_horn: the horn could not be silenced cleanly.');
        }
      },
    },
    {
      name: 'get_horn_state',
      description:
        'Reports whether the Air Horner is sounding right now, whether it is looping, and whether audio is available in this browser. Read-only and side-effect free; safe to call at any time, including while stopped or mid-start, and it answers whatever the caller sends (arguments are ignored). Returns {playing, loop, hasAudioContext}.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute(_input = {}, _callOptions = {}) {
        try {
          const { playing, loop, hasAudioContext, degraded } = readState(airhorn);
          if (degraded) {
            return {
              playing,
              loop,
              hasAudioContext,
              code: CODE.internal,
              error: 'get_horn_state: part of the horn state is unreadable, so these are safe fallback values.',
            };
          }
          return { playing, loop, hasAudioContext };
        } catch (err) {
          return {
            playing: false,
            loop: false,
            hasAudioContext: false,
            code: CODE.internal,
            error: 'get_horn_state: the horn state is unreadable.',
          };
        }
      },
    },
  ];
}

/**
 * Registers the horn tools with the browser's Model Context, if it has one.
 *
 * @param {object} airhorn an `AirHorn` instance
 * @param {{ target?: object, signal?: AbortSignal, startTimeoutMs?: number }} [options]
 *   `target` overrides the model context (used by tests); `signal` unregisters
 *   the tools on abort
 * @returns {Promise<{registered: boolean, names: string[], controller: AbortController|null}>}
 */
export async function registerHornTools(airhorn, { target, signal, startTimeoutMs } = {}) {
  // Browsers without WebMCP must not break: the horn keeps working as a button.
  // TODO(baseline/model-context): Remove fallback check when document.modelContext is Baseline Widely Available.
  const modelContext =
    target ?? (typeof document === 'undefined' ? undefined : document.modelContext);

  if (!modelContext || typeof modelContext.registerTool !== 'function') {
    return { registered: false, names: [], controller: null };
  }

  const controller = new AbortController();
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  const names = [];
  for (const tool of createHornTools(airhorn, { startTimeoutMs })) {
    await modelContext.registerTool(tool, { signal: controller.signal });
    names.push(tool.name);
  }

  return { registered: names.length > 0, names, controller };
}
