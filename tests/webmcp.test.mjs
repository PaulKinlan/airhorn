/*
 * Unit tests for src/webmcp.js: the WebMCP tool definitions and their
 * registration against a fake Model Context (the documented
 * registerTool/getTools/executeTool surface).
 *
 * Run with: node tests/webmcp.test.mjs
 */

import assert from 'node:assert/strict';
import { createHornTools, registerHornTools } from '../src/webmcp.js';

/**
 * A fake `document.modelContext` implementing the documented API surface
 * (registerTool with an abort signal, getTools, executeTool, toolchange).
 */
class FakeModelContext extends EventTarget {
  #tools = new Map();
  registrations = [];

  async registerTool(tool, options = {}) {
    if (this.#tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered.`);
    }
    this.registrations.push({ name: tool.name, options });
    this.#tools.set(tool.name, tool);
    options?.signal?.addEventListener('abort', () => this.#tools.delete(tool.name), { once: true });
    this.dispatchEvent(new Event('toolchange'));
  }

  async getTools() {
    return [...this.#tools.values()].map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    }));
  }

  async executeTool(tool, input, options = {}) {
    const name = typeof tool === 'string' ? tool : tool?.name;
    const definition = this.#tools.get(name);
    if (!definition) throw new Error(`Unknown tool "${name}".`);
    const inputObject = typeof input === 'string' ? JSON.parse(input) : (input ?? {});
    return JSON.stringify(await definition.execute(inputObject, options));
  }
}

function createFakeAirHorn({ audioContext = true } = {}) {
  const state = { playing: false, loop: false, starts: 0, stops: 0, stopOptions: null };
  return {
    state,
    async start({ loop = false } = {}) {
      state.starts += 1;
      if (!audioContext) return false;
      state.playing = true;
      state.loop = loop;
      return true;
    },
    async stop(options = {}) {
      state.stops += 1;
      state.stopOptions = options;
      state.playing = false;
      state.loop = false;
    },
    isPlaying: () => state.playing,
    isLooping: () => state.loop && state.playing,
    hasAudioContext: () => audioContext,
  };
}

async function withDocument(modelContext, fn) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = modelContext === undefined ? {} : { modelContext };
  try {
    await fn();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  }
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('registers play_horn, stop_horn and get_horn_state when modelContext exists', async () => {
  const modelContext = new FakeModelContext();
  const airhorn = createFakeAirHorn();
  await withDocument(modelContext, async () => {
    const result = await registerHornTools(airhorn);
    assert.equal(result.registered, true);
    assert.deepEqual(result.names, ['play_horn', 'stop_horn', 'get_horn_state']);
    assert.ok(result.controller instanceof AbortController);
  });

  const tools = await modelContext.getTools();
  assert.deepEqual(tools.map((tool) => tool.name), ['play_horn', 'stop_horn', 'get_horn_state']);

  for (const tool of tools) {
    assert.ok(tool.description.length > 20, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} needs a JSON Schema inputSchema`);
    assert.equal(typeof tool.annotations, 'object', `${tool.name} needs annotations`);
  }

  // A registration signal is passed to the platform so the tools can be removed.
  for (const registration of modelContext.registrations) {
    assert.ok(registration.options?.signal, `${registration.name} registered without a signal`);
    assert.equal(registration.options.signal.aborted, false);
  }
});

test('annotations describe which tools mutate state', async () => {
  const modelContext = new FakeModelContext();
  await withDocument(modelContext, () => registerHornTools(createFakeAirHorn()));
  const tools = await modelContext.getTools();
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  assert.equal(byName.play_horn.annotations.readOnlyHint, false);
  assert.equal(byName.stop_horn.annotations.readOnlyHint, false);
  assert.equal(byName.get_horn_state.annotations.readOnlyHint, true);
  assert.deepEqual(byName.play_horn.inputSchema.properties.loop.type, 'boolean');
});

test('play_horn drives AirHorn.start and get_horn_state reports it', async () => {
  const modelContext = new FakeModelContext();
  const airhorn = createFakeAirHorn();
  await withDocument(modelContext, () => registerHornTools(airhorn));

  const played = JSON.parse(await modelContext.executeTool('play_horn', { loop: true }));
  assert.deepEqual(played, { playing: true, loop: true });
  assert.equal(airhorn.state.starts, 1);
  assert.equal(airhorn.state.playing, true);
  assert.equal(airhorn.state.loop, true);

  const state = JSON.parse(await modelContext.executeTool('get_horn_state'));
  assert.deepEqual(state, { playing: true, loop: true, hasAudioContext: true });
});

test('play_horn defaults to a single, non-looping blast', async () => {
  const modelContext = new FakeModelContext();
  const airhorn = createFakeAirHorn();
  await withDocument(modelContext, () => registerHornTools(airhorn));

  const played = JSON.parse(await modelContext.executeTool('play_horn'));
  assert.deepEqual(played, { playing: true, loop: false });
  assert.equal(airhorn.state.loop, false);
});

test('stop_horn silences the horn immediately', async () => {
  const modelContext = new FakeModelContext();
  const airhorn = createFakeAirHorn();
  await withDocument(modelContext, () => registerHornTools(airhorn));

  await modelContext.executeTool('play_horn', { loop: true });
  const stopped = JSON.parse(await modelContext.executeTool('stop_horn'));

  assert.deepEqual(stopped, { playing: false, loop: false });
  assert.equal(airhorn.state.stops, 1);
  assert.deepEqual(airhorn.state.stopOptions, { immediate: true });

  const state = JSON.parse(await modelContext.executeTool('get_horn_state'));
  assert.deepEqual(state, { playing: false, loop: false, hasAudioContext: true });
});

test('reports a structured error instead of throwing without Web Audio', async () => {
  const modelContext = new FakeModelContext();
  const airhorn = createFakeAirHorn({ audioContext: false });
  await withDocument(modelContext, () => registerHornTools(airhorn));

  const played = JSON.parse(await modelContext.executeTool('play_horn', { loop: true }));
  assert.equal(played.playing, false);
  assert.equal(played.loop, true);
  assert.match(played.error, /Web Audio is unavailable/);
});

test('honours a cancelled execution signal', async () => {
  const modelContext = new FakeModelContext();
  const airhorn = createFakeAirHorn();
  await withDocument(modelContext, () => registerHornTools(airhorn));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    modelContext.executeTool('play_horn', {}, { signal: controller.signal }),
    /Abort/,
  );
  assert.equal(airhorn.state.starts, 0, 'a cancelled call must not sound the horn');
});

test('aborting the registration controller unregisters every tool', async () => {
  const modelContext = new FakeModelContext();
  await withDocument(modelContext, async () => {
    const { controller } = await registerHornTools(createFakeAirHorn());
    assert.equal((await modelContext.getTools()).length, 3);
    controller.abort();
    assert.deepEqual(await modelContext.getTools(), []);
  });
});

test('is a silent no-op where WebMCP is unavailable', async () => {
  const airhorn = createFakeAirHorn();

  // Document without a modelContext.
  await withDocument(undefined, async () => {
    const result = await registerHornTools(airhorn);
    assert.deepEqual({ registered: result.registered, names: result.names }, { registered: false, names: [] });
    assert.equal(result.controller, null);
  });

  // No document at all (e.g. a worker or a plain Node import).
  delete globalThis.document;
  const result = await registerHornTools(airhorn);
  assert.equal(result.registered, false);
  assert.deepEqual(result.names, []);
});

test('createHornTools binds each tool to the instance it is given', async () => {
  const airhorn = createFakeAirHorn();
  const tools = createHornTools(airhorn);
  const play = tools.find((tool) => tool.name === 'play_horn');
  await play.execute({ loop: false }, {});
  assert.equal(airhorn.state.starts, 1);
  assert.equal(airhorn.state.playing, true);
});

let failures = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(err);
  }
}

console.log(`\n${tests.length - failures}/${tests.length} WebMCP unit tests passed`);
if (failures > 0) process.exit(1);
