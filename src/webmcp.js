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
 */

const notStartedError = (airhorn) => ({
  playing: false,
  error: airhorn.hasAudioContext()
    ? 'The horn could not be started.'
    : 'Web Audio is unavailable in this browser, so the horn cannot sound.',
});

/**
 * Builds the WebMCP tool definitions bound to one `AirHorn` instance.
 *
 * @param {object} airhorn an `AirHorn` instance
 * @returns {Array<object>} tool definitions for `registerTool()`
 */
export function createHornTools(airhorn) {
  return [
    {
      name: 'play_horn',
      description:
        'Sound the Air Horner. Starts audio playback, pressed state and app badge, exactly like pressing the on-screen horn button.',
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
      async execute(input = {}, { signal } = {}) {
        const loop = input?.loop === true;
        if (signal?.aborted) throw signal.reason ?? new Error('Aborted');

        await airhorn.start({ loop });
        signal?.throwIfAborted?.();

        if (!airhorn.isPlaying()) {
          return { ...notStartedError(airhorn), loop };
        }
        return { playing: true, loop };
      },
    },
    {
      name: 'stop_horn',
      description: 'Silence the Air Horner immediately.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      async execute(_input = {}, _options = {}) {
        await airhorn.stop({ immediate: true });
        return { playing: airhorn.isPlaying(), loop: false };
      },
    },
    {
      name: 'get_horn_state',
      description:
        'Reports whether the Air Horner is sounding right now, whether it is looping, and whether audio is available in this browser.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      execute() {
        return {
          playing: airhorn.isPlaying(),
          loop: airhorn.isLooping(),
          hasAudioContext: airhorn.hasAudioContext(),
        };
      },
    },
  ];
}

/**
 * Registers the horn tools with the browser's Model Context, if it has one.
 *
 * @param {object} airhorn an `AirHorn` instance
 * @param {{ target?: object, signal?: AbortSignal }} [options] `target` overrides
 *   the model context (used by tests); `signal` unregisters the tools on abort
 * @returns {Promise<{registered: boolean, names: string[], controller: AbortController|null}>}
 */
export async function registerHornTools(airhorn, { target, signal } = {}) {
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
  for (const tool of createHornTools(airhorn)) {
    await modelContext.registerTool(tool, { signal: controller.signal });
    names.push(tool.name);
  }

  return { registered: names.length > 0, names, controller };
}
