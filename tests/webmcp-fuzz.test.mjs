/*
 * tests/webmcp-fuzz.test.mjs - hostile-caller fuzzing for the WebMCP tools
 * (airhorn-9e9).
 *
 * Anything on the page can call `play_horn` / `stop_horn` / `get_horn_state`
 * with anything at all. These tests are the contract the tools promise in
 * `src/webmcp.js`: every call RESOLVES (never an unhandled rejection) to either
 * a structured `{code, error}` refusal or a safe no-op; hostile input is never
 * coerced into a different behaviour; repeated invocation can never stack
 * playback (`play_horn` supersedes, and is rate limited); silence is never
 * blocked; and no `AudioContext`, buffer source or oscillator is leaked.
 *
 * Run with: node tests/webmcp-fuzz.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHornTools } from '../src/webmcp.js';
import { Horn } from '../src/horn.js';

// --- harness -----------------------------------------------------------------

/**
 * A fake `document.modelContext` with the documented surface. `executeTool`
 * deliberately does NOT swallow rejections: a throwing tool must fail the test
 * exactly as it would reach an agent as an unhandled rejection.
 */
class FakeModelContext {
  #tools = new Map();

  async registerTool(tool, options = {}) {
    if (this.#tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered.`);
    this.#tools.set(tool.name, tool);
    options?.signal?.addEventListener('abort', () => this.#tools.delete(tool.name), { once: true });
  }

  async getTools() {
    return [...this.#tools.values()].map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    }));
  }

  async executeTool(name, input, options = {}) {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Unknown tool "${name}".`);
    const raw = await tool.execute(input ?? {}, options ?? {});
    return JSON.parse(JSON.stringify(raw));
  }
}

/**
 * A hostile-caller-resistant fake horn that records how many playbacks are
 * sounding AT THE SAME TIME (the "stacked horn" failure) and can be told to
 * misbehave the way a real audio graph can.
 */
function createFakeAirHorn({ audioContext = true, startImpl = null } = {}) {
  const state = {
    playing: false,
    loop: false,
    starts: 0,
    stops: 0,
    active: 0,
    maxActive: 0,
    stopOptions: null,
  };

  return {
    state,
    async start({ loop = false } = {}) {
      state.starts += 1;
      if (startImpl) return startImpl({ loop, state });
      if (!audioContext) return false;
      state.playing = true;
      state.loop = loop;
      state.active += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      return true;
    },
    async stop(options = {}) {
      state.stops += 1;
      state.stopOptions = options;
      state.playing = false;
      state.loop = false;
      state.active = 0;
    },
    isPlaying: () => state.playing,
    isLooping: () => state.loop && state.playing,
    hasAudioContext: () => audioContext,
  };
}

async function withTools(airhorn, options, fn) {
  const modelContext = new FakeModelContext();
  for (const tool of createHornTools(airhorn, options)) {
    await modelContext.registerTool(tool);
  }
  return fn(modelContext);
}

const hex = (length) => 'x'.repeat(length);

// --- input validation: refusals name the type, never the payload -------------

test('play_horn refuses wrong-typed input with a structured error instead of coercing it', async () => {
  const cases = [
    ['loop as a string', { loop: 'true' }, /"loop" must be a boolean, received a string/],
    ['loop as a number', { loop: 1 }, /"loop" must be a boolean, received a number/],
    ['loop as a negative number', { loop: -1 }, /"loop" must be a boolean, received a number/],
    ['loop as a huge number', { loop: 1e308 }, /"loop" must be a boolean, received a number/],
    ['loop as an object', { loop: { value: true } }, /"loop" must be a boolean, received a object/],
    ['loop as an array', { loop: [true] }, /"loop" must be a boolean, received a array/],
    ['loop as null', { loop: null }, /"loop" must be a boolean, received a null/],
    ['input as a JSON string', '{"loop":true}', /input must be an object, received a string/],
    ['input as a number', 42, /input must be an object, received a number/],
    ['input as a boolean', true, /input must be an object, received a boolean/],
    ['input as an array', [true], /input must be an object, received a array/],
    ['input as a function', () => true, /input must be an object, received a function/],
  ];

  for (const [label, input, expected] of cases) {
    const airhorn = createFakeAirHorn();
    await withTools(airhorn, {}, async (modelContext) => {
      const result = await modelContext.executeTool('play_horn', input);
      assert.equal(result.code, 'invalid_input', `${label}: expected an invalid_input refusal`);
      assert.match(result.error, expected, `${label}: error should name the received type`);
      assert.equal(result.playing, false);
      assert.equal(result.loop, false);
      assert.equal(airhorn.state.starts, 0, `${label}: a refused call must not sound the horn`);
    });
  }
});

test('a hostile megabyte payload is refused quickly and never echoed back', async () => {
  const payload = hex(1_000_000);
  const airhorn = createFakeAirHorn();
  await withTools(airhorn, {}, async (modelContext) => {
    const started = Date.now();
    const result = await modelContext.executeTool('play_horn', { loop: payload });
    const elapsed = Date.now() - started;

    assert.equal(result.code, 'invalid_input');
    assert.ok(result.error.length < 200, `error message must stay small, got ${result.error.length} chars`);
    assert.ok(!result.error.includes(payload.slice(0, 32)), 'the payload must not be repeated in the error');
    assert.ok(elapsed < 100, `a megabyte of junk must be refused promptly, took ${elapsed}ms`);
    assert.equal(airhorn.state.starts, 0);
  });
});

test('a huge argument object with a valid loop flag is a safe no-op on the extra data', async () => {
  const airhorn = createFakeAirHorn();
  const noisy = { loop: true };
  for (let i = 0; i < 5000; i += 1) noisy[`extra_${i}`] = hex(64);

  await withTools(airhorn, {}, async (modelContext) => {
    const result = await modelContext.executeTool('play_horn', noisy);
    assert.deepEqual(result, { playing: true, loop: true }, 'extra properties are ignored, not obeyed');
    assert.equal(airhorn.state.starts, 1);
  });
});

test('unknown properties and prototype-shaped keys cannot change behaviour or pollute', async () => {
  const airhorn = createFakeAirHorn();
  await withTools(airhorn, {}, async (modelContext) => {
    const input = JSON.parse('{"loop":false,"__proto__":{"polluted":true},"constructor":"x"}');
    const result = await modelContext.executeTool('play_horn', input);
    assert.deepEqual(result, { playing: true, loop: false });
    assert.equal({}.polluted, undefined, 'Object.prototype must not be touched');
  });
});

test('missing arguments are a single, non-looping blast', async () => {
  const airhorn = createFakeAirHorn();
  await withTools(airhorn, {}, async (modelContext) => {
    assert.deepEqual(await modelContext.executeTool('play_horn'), { playing: true, loop: false });
    airhorn.state.playing = false;
    assert.deepEqual(await modelContext.executeTool('play_horn', null), { playing: true, loop: false });
    assert.equal(airhorn.state.starts, 2);
  });
});

test('stop_horn silences the horn whatever the caller sends, and state is always readable', async () => {
  const airhorn = createFakeAirHorn();
  await withTools(airhorn, {}, async (modelContext) => {
    for (const junk of ['please', [1, 2, 3], 42, true, () => {}, null]) {
      await modelContext.executeTool('play_horn', { loop: true });
      const stopped = await modelContext.executeTool('stop_horn', junk);
      assert.deepEqual(stopped, { playing: false, loop: false });
      assert.equal(airhorn.state.playing, false, 'silence is never refused');

      const state = await modelContext.executeTool('get_horn_state', junk);
      assert.deepEqual(state, { playing: false, loop: false, hasAudioContext: true });
    }
  });
});

test('stop_horn and get_horn_state ignore extra properties', async () => {
  const airhorn = createFakeAirHorn();
  await withTools(airhorn, {}, async (modelContext) => {
    await modelContext.executeTool('play_horn', { loop: true });
    const state = await modelContext.executeTool('get_horn_state', { verbose: true, n: 1e9 });
    assert.deepEqual(state, { playing: true, loop: true, hasAudioContext: true });
    const stopped = await modelContext.executeTool('stop_horn', { immediate: false, volume: 0 });
    assert.deepEqual(stopped, { playing: false, loop: false });
    assert.deepEqual(airhorn.state.stopOptions, { immediate: true }, 'stop is always immediate');
  });
});

// --- floods, stacking and rates ---------------------------------------------

test('a concurrent flood never stacks playback and every call resolves', async () => {
  const airhorn = createFakeAirHorn();
  const rateLimit = { max: 5, windowMs: 60_000 };

  await withTools(airhorn, { rateLimit }, async (modelContext) => {
    const results = await Promise.all(
      Array.from({ length: 60 }, () => modelContext.executeTool('play_horn', { loop: true })),
    );

    const accepted = results.filter((r) => r.code === undefined);
    const refused = results.filter((r) => r.code === 'rate_limited');
    assert.equal(accepted.length, 5, 'exactly the rate limit is admitted');
    assert.equal(refused.length, 55, 'the rest are refused with a structured error');
    assert.ok(accepted.every((r) => r.playing === true), 'an admitted call reports the horn sounding');
    assert.equal(airhorn.state.maxActive, 1, 'only one playback may ever be sounding');
    for (const result of results) {
      assert.equal(typeof result.playing, 'boolean');
      assert.equal(typeof result.loop, 'boolean');
    }
    assert.equal((await modelContext.executeTool('get_horn_state')).playing, true);

    await modelContext.executeTool('stop_horn');
    assert.equal(airhorn.state.active, 0);
  });
});

test('repeated accepted calls supersede each other rather than accumulating', async () => {
  const airhorn = createFakeAirHorn();
  // Rate limit wide enough that every call is admitted: only superseding can
  // keep one horn sounding.
  await withTools(airhorn, { rateLimit: { max: 1000, windowMs: 1000 } }, async (modelContext) => {
    for (let i = 0; i < 50; i += 1) {
      const result = await modelContext.executeTool('play_horn', { loop: true });
      assert.equal(result.playing, true);
    }
    assert.equal(airhorn.state.starts, 50);
    assert.equal(airhorn.state.maxActive, 1, 'play_horn restarts the horn instead of stacking it');
    assert.equal(airhorn.state.active, 1);
  });
});

test('an interleaved play/stop/state storm leaves the horn stopped and consistent', async () => {
  const airhorn = createFakeAirHorn();
  await withTools(airhorn, { rateLimit: { max: 10_000, windowMs: 1000 } }, async (modelContext) => {
    const calls = [];
    // Deterministic pseudo-random mix: nothing here may reject.
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    for (let i = 0; i < 120; i += 1) {
      const r = next();
      const tool = r < 0.6 ? 'play_horn' : r < 0.85 ? 'stop_horn' : 'get_horn_state';
      calls.push(modelContext.executeTool(tool, tool === 'play_horn' ? { loop: next() < 0.5 } : {}));
    }
    const results = await Promise.all(calls);
    assert.equal(results.length, 120);
    assert.ok(airhorn.state.maxActive <= 1, `stacked ${airhorn.state.maxActive} playbacks`);

    await modelContext.executeTool('stop_horn');
    const finalState = await modelContext.executeTool('get_horn_state');
    assert.deepEqual(finalState, { playing: false, loop: false, hasAudioContext: true });
    assert.equal(airhorn.state.active, 0);
  });
});

test('the shipped defaults are the documented ones: 20 starts per second', async () => {
  // docs/webmcp-tools.md states the default rate limit and says a refusal
  // reports the horn's CURRENT state. Both are asserted here, on the tool as
  // createHornTools() builds it with no options - not on an injected limit,
  // which would only prove the knob works.
  const airhorn = createFakeAirHorn();
  await withTools(airhorn, {}, async (modelContext) => {
    const results = [];
    for (let i = 0; i < 20; i += 1) {
      results.push(await modelContext.executeTool('play_horn', { loop: true }));
    }
    assert.ok(results.every((r) => r.code === undefined), 'the first 20 starts in the window are admitted');
    assert.equal(airhorn.state.starts, 20);

    // The 21st is refused inside the same 1000 ms window - while the horn is
    // still sounding, which is what makes "playing is the current state, not
    // this call's outcome" observable.
    const refused = await modelContext.executeTool('play_horn', { loop: true });
    assert.equal(refused.code, 'rate_limited');
    assert.match(refused.error, /20 starts per 1000ms/);
    assert.equal(refused.playing, true, 'a refusal reports the horn as it is right now, which can be playing');
    assert.equal(refused.loop, true);
    assert.equal(airhorn.state.starts, 20, 'a refused call must not start anything');
    assert.equal(airhorn.state.maxActive, 1, 'and it must not stack playback');
  });
});

test('stop_horn is never rate limited and answers immediately during a play flood', async () => {
  const airhorn = createFakeAirHorn();
  await withTools(airhorn, { rateLimit: { max: 1, windowMs: 60_000 } }, async (modelContext) => {
    await modelContext.executeTool('play_horn', { loop: true });
    const results = await Promise.all(Array.from({ length: 20 }, () => modelContext.executeTool('stop_horn')));
    for (const result of results) assert.equal(result.playing, false);
    assert.equal(airhorn.state.playing, false);
  });
});

// --- audio graph not ready, unreachable, or slow ----------------------------

test('a start that never settles times out as a structured error and is silenced', async () => {
  const airhorn = createFakeAirHorn({ startImpl: () => new Promise(() => {}) });
  await withTools(airhorn, { startTimeoutMs: 25 }, async (modelContext) => {
    const started = Date.now();
    const result = await modelContext.executeTool('play_horn', { loop: true });
    const elapsed = Date.now() - started;

    assert.equal(result.code, 'timeout');
    assert.match(result.error, /did not start/);
    assert.ok(elapsed < 1000, `the tool must not hang on a stuck start, took ${elapsed}ms`);
    assert.ok(airhorn.state.stops >= 1, 'the abandoned start must be stopped, not left to blast later');
  });
});

test('invocation before the audio graph is ready still resolves', async () => {
  // AudioContext exists but is still resuming, and the sample has not decoded:
  // start() reports false rather than playing.
  const airhorn = createFakeAirHorn({ startImpl: async () => false });
  await withTools(airhorn, {}, async (modelContext) => {
    const result = await modelContext.executeTool('play_horn', { loop: true });
    assert.equal(result.playing, false);
    assert.equal(result.loop, true);
    assert.equal(result.code, 'not_started');
    assert.equal((await modelContext.executeTool('get_horn_state')).playing, false);
  });
});

test('a broken horn instance yields structured errors, never rejections', async () => {
  const airhorn = createFakeAirHorn({
    startImpl: () => {
      throw new Error('resume() exploded');
    },
  });
  airhorn.isPlaying = () => {
    throw new Error('this instance is broken');
  };
  await withTools(airhorn, {}, async (modelContext) => {
    const played = await modelContext.executeTool('play_horn', { loop: true });
    assert.equal(played.code, 'internal');
    assert.equal(played.playing, false);

    const state = await modelContext.executeTool('get_horn_state');
    assert.deepEqual(
      { playing: state.playing, loop: state.loop, hasAudioContext: state.hasAudioContext },
      { playing: false, loop: false, hasAudioContext: true },
    );
    assert.equal(state.code, 'internal');
  });
});

// --- cancellation -----------------------------------------------------------

test('an aborted call rejects and never starts the horn', async () => {
  const airhorn = createFakeAirHorn();
  await withTools(airhorn, {}, async (modelContext) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      modelContext.executeTool('play_horn', {}, { signal: controller.signal }),
      (err) => err.name === 'AbortError' || /Abort/.test(err.message),
    );
    assert.equal(airhorn.state.starts, 0);
  });
});

test('a call cancelled mid-start is silenced instead of left looping', async () => {
  let release;
  let reachedStart;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const startedGate = new Promise((resolve) => {
    reachedStart = resolve;
  });
  const airhorn = createFakeAirHorn({
    startImpl: async ({ loop, state }) => {
      reachedStart();
      await gate;
      state.playing = true;
      state.loop = loop;
      return true;
    },
  });

  await withTools(airhorn, {}, async (modelContext) => {
    const controller = new AbortController();
    const pending = modelContext.executeTool('play_horn', { loop: true }, { signal: controller.signal });
    await startedGate;
    controller.abort();
    release();
    await assert.rejects(pending, (err) => err.name === 'AbortError' || /Abort/.test(err.message));
    assert.equal(airhorn.state.playing, false, 'a cancelled call must not leave a looping horn');
    assert.ok(airhorn.state.stops >= 1);
  });
});

test('stop_horn still silences the horn when its own call is aborted', async () => {
  const airhorn = createFakeAirHorn();
  await withTools(airhorn, {}, async (modelContext) => {
    await modelContext.executeTool('play_horn', { loop: true });
    const controller = new AbortController();
    controller.abort();
    const result = await modelContext.executeTool('stop_horn', {}, { signal: controller.signal });
    assert.equal(result.playing, false);
    assert.equal(airhorn.state.playing, false);
  });
});

// --- no leaked audio nodes or contexts, against the REAL Horn ---------------

class FakeAudioParam {
  value = 1;
  setValueAtTime(value) { this.value = value; }
  exponentialRampToValueAtTime(value) { this.value = value; }
  cancelScheduledValues() {}
}

class FakeAudioNode {
  connect() {}
  disconnect() {}
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}

class FakeOscillatorNode extends FakeAudioNode {
  type = 'sine';
  frequency = new FakeAudioParam();
  started = false;
  stopped = false;
  start() { if (this.started) throw new Error('already started'); this.started = true; }
  stop() { this.stopped = true; }
}

class FakeBufferSourceNode extends EventTarget {
  buffer = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  started = false;
  stopped = false;
  onended = null;
  connect() {}
  disconnect() {}
  start() { if (this.started) throw new Error('already started'); this.started = true; }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.dispatchEvent(new Event('ended'));
    if (this.onended) this.onended();
  }
}

class CountingAudioContext {
  static created = 0;
  currentTime = 0;
  destination = new FakeAudioNode();
  sources = [];
  oscillators = [];
  gains = [];

  constructor() {
    CountingAudioContext.created += 1;
  }

  async resume() {}

  createBufferSource() {
    const source = new FakeBufferSourceNode();
    this.sources.push(source);
    return source;
  }

  createGain() {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  }

  createOscillator() {
    const osc = new FakeOscillatorNode();
    this.oscillators.push(osc);
    return osc;
  }

  decodeAudioData(_arrayBuffer, success) {
    const buffer = { duration: 1.5, length: 66150, sampleRate: 44100 };
    if (success) success(buffer);
    return Promise.resolve(buffer);
  }
}

/** A minimal AirHorn-shaped wrapper so the tools drive the real Horn class. */
function wrapHorn(horn) {
  let loop = false;
  return {
    horn,
    async start({ loop: next = false } = {}) {
      loop = next;
      const started = await horn.start({ loop: next });
      if (!started) loop = false;
      return started;
    },
    async stop(options = {}) {
      loop = false;
      return horn.stop(options);
    },
    isPlaying: () => horn.isPlaying(),
    isLooping: () => loop && horn.isPlaying(),
    hasAudioContext: () => horn.hasAudioContext(),
    get usingFallback() {
      return horn.usingFallback;
    },
  };
}

test('fuzzing the real Horn leaks no AudioContext, buffer sources or oscillators', async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  CountingAudioContext.created = 0;

  try {
    const context = new CountingAudioContext();
    const airhorn = wrapHorn(new Horn({ audioContext: context }));
    const countingSounding = () =>
      context.sources.filter((source) => source.started && !source.stopped).length +
      context.oscillators.filter((osc) => osc.started && !osc.stopped).length;

    await withTools(airhorn, { rateLimit: { max: 10_000, windowMs: 1000 } }, async (modelContext) => {
      for (let i = 0; i < 60; i += 1) {
        const played = await modelContext.executeTool('play_horn', { loop: i % 2 === 0 });
        assert.equal(played.playing, true, `call ${i} should sound the horn`);
        assert.ok(countingSounding() <= 1, `call ${i} left ${countingSounding()} playbacks sounding`);
      }
      await modelContext.executeTool('stop_horn');
      assert.deepEqual(
        await modelContext.executeTool('get_horn_state'),
        { playing: false, loop: false, hasAudioContext: true },
      );
    });

    assert.equal(CountingAudioContext.created, 1, 'exactly one AudioContext for the whole fuzz run');
    assert.equal(fetches, 1, 'the sample is fetched and decoded once, not per call');
    assert.equal(airhorn.horn.isPlaying(), false, 'no playback survives the final stop');
    assert.equal(countingSounding(), 0, 'every buffer source and oscillator was stopped');
    assert.equal(
      context.sources.filter((source) => source.started).length > 0,
      true,
      'the fuzz run must actually exercise the audio path',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// --- schema and description accuracy ---------------------------------------

test('the published schemas and descriptions match what the tools actually do', async () => {
  const airhorn = createFakeAirHorn();
  await withTools(airhorn, {}, async (modelContext) => {
    const tools = Object.fromEntries((await modelContext.getTools()).map((tool) => [tool.name, tool]));

    const play = tools.play_horn;
    assert.equal(play.inputSchema.type, 'object');
    assert.deepEqual(Object.keys(play.inputSchema.properties), ['loop'], 'the only accepted argument is loop');
    assert.equal(play.inputSchema.properties.loop.type, 'boolean');
    assert.equal(play.inputSchema.additionalProperties, false);
    assert.equal(play.inputSchema.properties.loop.description, 'Keep the horn sounding until stop_horn is called. Defaults to false: a single blast.');
    assert.match(play.description, /loop: true/);
    assert.match(play.description, /replaces anything already sounding/, 'the superseding behaviour is documented');
    assert.match(play.description, /rate limited/, 'the rate limit is documented');
    assert.match(play.description, /\{playing, loop, code, error\}/, 'the refusal shape is documented');

    for (const name of ['stop_horn', 'get_horn_state']) {
      assert.equal(tools[name].inputSchema.additionalProperties, false, `${name} rejects unknown properties`);
      assert.deepEqual(tools[name].inputSchema.properties, {}, `${name} takes no arguments`);
    }
    assert.match(tools.stop_horn.description, /always honoured/i);
    assert.match(tools.stop_horn.description, /silence must always be possible/i);
    assert.match(tools.get_horn_state.description, /\{playing, loop, hasAudioContext\}/);
    assert.equal(tools.get_horn_state.annotations.readOnlyHint, true);
    assert.equal(tools.play_horn.annotations.readOnlyHint, false);
    assert.equal(tools.stop_horn.annotations.readOnlyHint, false);
  });
});
