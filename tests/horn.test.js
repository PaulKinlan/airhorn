/*
 *
 *  Air Horner
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
 *
 *  Unit tests for the Horn class lifecycle/state (src/horn.js).
 *
 *  The Horn class is browser code, but it only touches three browser globals —
 *  window.AudioContext, window.webkitAudioContext and fetch — so these tests
 *  run headless under `node --test` with fakes installed for the duration of
 *  each test. No network, no audio device, no DOM.
 *
 *  Everything is asserted through the public surface (constructor, start,
 *  stop, onstopped) and through observable calls on the fakes; the private
 *  fields (#sources, #bufferPromise) are deliberately reached only via
 *  behaviour.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Horn } from '../src/horn.js';

const AIRHORN_URL = '/sounds/airhorn.mp3';

/**
 * Build a fake AudioContext class plus the sources it has created.
 * opts.decodeFails  — decodeAudioData rejects (buffer load failure)
 * opts.resumeThrows — resume() rejects (context refuses to leave suspended)
 */
function makeAudioContext(opts = {}) {
  const sources = [];
  const calls = { resume: 0, decoded: [] };

  class FakeBufferSource {
    constructor() {
      this.buffer = null;
      this.loop = false;
      this.loopStart = 0;
      this.loopEnd = 0;
      this.connectedTo = [];
      this.startArgs = null;
      this.startCalls = 0;
      this.stopCalls = 0; // Horn must never call this (gradual-fade fix)
      this.onended = null;
    }
    connect(dest) {
      this.connectedTo.push(dest);
    }
    addEventListener(type, listener) {
      // Mirror the DOMEventTarget surface Horn's immediate-stop path relies on.
      if (type === 'ended') this.endedListeners = (this.endedListeners || []).concat(listener);
    }
    emitEnded() {
      for (const listener of this.endedListeners || []) listener();
      this.end(); // the onended property fires too, as in a real AudioBufferSourceNode
    }
    start(...args) {
      this.startCalls++;
      this.startArgs = args;
    }
    stop() {
      this.stopCalls++;
    }
    end() {
      // Test-side helper: simulate the media finishing.
      if (typeof this.onended === 'function') this.onended();
    }
  }

  class FakeAudioContext {
    constructor() {
      this.destination = { kind: 'destination' };
      this.state = 'running';
      this.sources = sources;
      this.calls = calls;
    }
    async resume() {
      calls.resume++;
      if (opts.resumeThrows) throw new Error('resume failed');
    }
    createBufferSource() {
      const s = new FakeBufferSource();
      sources.push(s);
      return s;
    }
    decodeAudioData(arrayBuffer) {
      calls.decoded.push(arrayBuffer);
      if (opts.decodeFails) return Promise.reject(new Error('decode failed'));
      return Promise.resolve({ kind: 'audio-buffer', arrayBuffer });
    }
  }

  return { FakeAudioContext, sources, calls };
}

/** Install browser globals; returns an undo function that restores everything. */
function withBrowserGlobals({ AudioContext, webkitAudioContext, fetchImpl }) {
  const prev = {
    hadWindow: 'window' in globalThis,
    window: globalThis.window,
    ac: [globalThis.hasOwnProperty('AudioContext'), globalThis.AudioContext],
    wac: [globalThis.hasOwnProperty('webkitAudioContext'), globalThis.webkitAudioContext],
    fetch: [globalThis.hasOwnProperty('fetch'), globalThis.fetch],
  };
  const setKey = (key, value) => {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  };

  globalThis.window = globalThis; // Horn reads bare `window.AudioContext`
  setKey('AudioContext', AudioContext);
  setKey('webkitAudioContext', webkitAudioContext);
  setKey('fetch', fetchImpl);

  return () => {
    const restore = ([had, value], key) => {
      if (had) globalThis[key] = value;
      else delete globalThis[key];
    };
    restore(prev.ac, 'AudioContext');
    restore(prev.wac, 'webkitAudioContext');
    restore(prev.fetch, 'fetch');
    if (prev.hadWindow) globalThis.window = prev.window;
    else delete globalThis.window;
  };
}

/** A fetch fake that records requested URLs and hands back a fresh ArrayBuffer. */
function makeFetch() {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      arrayBuffer: async () => new ArrayBuffer(16),
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

describe('Horn lifecycle', () => {
  test('constructor without AudioContext support is inert: start() is a no-op and nothing is fetched', async () => {
    let fetched = 0;
    const undo = withBrowserGlobals({
      AudioContext: undefined,
      webkitAudioContext: undefined,
      fetchImpl: async () => {
        fetched++;
        throw new Error('must not fetch without an AudioContext');
      },
    });
    try {
      const horn = new Horn(); // must not throw
      await horn.start({ loop: true }); // must not throw
      assert.equal(fetched, 0);
    } finally {
      undo();
    }
  });

  test('start() resumes the context, fetches the sample, decodes it and plays a connected source', async () => {
    const { FakeAudioContext, sources, calls } = makeAudioContext();
    const fetchImpl = makeFetch();
    const undo = withBrowserGlobals({
      AudioContext: FakeAudioContext,
      fetchImpl,
    });
    try {
      const horn = new Horn();
      await horn.start();

      assert.equal(calls.resume, 1, 'context resumed');
      assert.deepEqual(fetchImpl.calls, [AIRHORN_URL], 'sample fetched once');
      assert.equal(calls.decoded.length, 1, 'buffer decoded');

      assert.equal(sources.length, 1, 'one source created');
      const source = sources[0];
      assert.equal(source.startCalls, 1);
      assert.deepEqual(source.startArgs, [0], 'source started immediately');
      assert.deepEqual(source.connectedTo, [{ kind: 'destination' }], 'routed to destination');
      assert.ok(source.buffer, 'sample buffer attached');
      assert.equal(source.buffer.kind, 'audio-buffer');
      assert.equal(source.loop, false, 'one-shot by default');
      assert.equal(typeof source.onended, 'function', 'end handler registered');
    } finally {
      undo();
    }
  });

  test('start() reports support and playing state: false/inert without AudioContext, true once playing', async () => {
    const undoNone = withBrowserGlobals({
      AudioContext: undefined,
      fetchImpl: async () => {
        throw new Error('must not fetch');
      },
    });
    try {
      const inert = new Horn();
      assert.equal(inert.hasAudioContext(), false);
      assert.equal(inert.isPlaying(), false);
      assert.equal(await inert.start(), false, 'start() returns false when there is no context');
    } finally {
      undoNone();
    }

    const { FakeAudioContext, sources } = makeAudioContext();
    const undo = withBrowserGlobals({ AudioContext: FakeAudioContext, fetchImpl: makeFetch() });
    try {
      const horn = new Horn();
      assert.equal(horn.hasAudioContext(), true);
      assert.equal(horn.isPlaying(), false);
      assert.equal(await horn.start(), true, 'start() returns true when it schedules a source');
      assert.equal(horn.isPlaying(), true);
      sources[0].end();
      assert.equal(horn.isPlaying(), false, 'playing state clears when the source ends');
    } finally {
      undo();
    }
  });

  test('start({loop: true}) configures the looping region of the sample', async () => {
    const { FakeAudioContext, sources } = makeAudioContext();
    const undo = withBrowserGlobals({ AudioContext: FakeAudioContext, fetchImpl: makeFetch() });
    try {
      const horn = new Horn();
      await horn.start({ loop: true });

      const source = sources[0];
      assert.equal(source.loop, true);
      assert.equal(source.loopStart, 0.24);
      assert.equal(source.loopEnd, 0.34);
    } finally {
      undo();
    }
  });

  test('the sample buffer is fetched and decoded once and reused across starts', async () => {
    const { FakeAudioContext, calls } = makeAudioContext();
    const fetchImpl = makeFetch();
    const undo = withBrowserGlobals({ AudioContext: FakeAudioContext, fetchImpl });
    try {
      const horn = new Horn();
      await Promise.all([horn.start(), horn.start({ loop: true })]);

      assert.equal(fetchImpl.calls.length, 1, 'one fetch despite two starts');
      assert.equal(calls.decoded.length, 1, 'one decode despite two starts');
    } finally {
      undo();
    }
  });
});

describe('Horn stop', () => {
  test('stop() disables looping so the sample fades out; it never kills the source', async () => {
    const { FakeAudioContext, sources } = makeAudioContext();
    const undo = withBrowserGlobals({ AudioContext: FakeAudioContext, fetchImpl: makeFetch() });
    try {
      const horn = new Horn();
      await horn.start({ loop: true });
      const source = sources[0];

      horn.stop();

      assert.equal(source.loop, false, 'looping disabled');
      assert.equal(source.stopCalls, 0, 'source.stop() never called (gradual fade, not a hard kill)');
      assert.equal(source.startCalls, 1, 'source left playing');
    } finally {
      undo();
    }
  });

  test('stop() disables looping on every active source', async () => {
    const { FakeAudioContext, sources } = makeAudioContext();
    const undo = withBrowserGlobals({ AudioContext: FakeAudioContext, fetchImpl: makeFetch() });
    try {
      const horn = new Horn();
      await horn.start({ loop: true });
      await horn.start({ loop: true });
      assert.equal(sources.length, 2);

      horn.stop();

      for (const source of sources) {
        assert.equal(source.loop, false);
        assert.equal(source.stopCalls, 0);
      }
    } finally {
      undo();
    }
  });

  test('stop({immediate: true}) cuts playback: calls source.stop(), disables looping, resolves on ended', async () => {
    const { FakeAudioContext, sources } = makeAudioContext();
    const undo = withBrowserGlobals({ AudioContext: FakeAudioContext, fetchImpl: makeFetch() });
    try {
      const horn = new Horn();
      await horn.start({ loop: true });
      const source = sources[0];

      const stopped = horn.stop({ immediate: true });
      assert.equal(source.loop, false, 'looping disabled');
      assert.equal(source.stopCalls, 1, 'source.stop(0) called for the immediate cut');

      // The promise must not resolve before the source reports 'ended'...
      let resolved = false;
      stopped.then(() => {
        resolved = true;
      });
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(resolved, false, 'waits for the ended event');

      source.emitEnded(); // fires both the addEventListener listeners and onended
      await stopped;
      assert.equal(resolved, true, 'resolves once the source has ended');
    } finally {
      undo();
    }
  });

  test('stop() with nothing playing is a safe no-op', () => {
    const { FakeAudioContext } = makeAudioContext();
    const undo = withBrowserGlobals({ AudioContext: FakeAudioContext, fetchImpl: makeFetch() });
    try {
      const horn = new Horn();
      assert.doesNotThrow(() => horn.stop());
    } finally {
      undo();
    }
  });
});

describe('Horn onstopped', () => {
  test('onstopped fires only when the last active source ends', async () => {
    const { FakeAudioContext, sources } = makeAudioContext();
    const undo = withBrowserGlobals({ AudioContext: FakeAudioContext, fetchImpl: makeFetch() });
    try {
      const horn = new Horn();
      await horn.start();
      await horn.start();
      assert.equal(sources.length, 2);

      let stopped = 0;
      horn.onstopped = () => stopped++;

      sources[0].end();
      assert.equal(stopped, 0, 'one source still playing');
      sources[0].end(); // repeat notifications for an ended source must not re-fire
      assert.equal(stopped, 0, 'ended source stays retired');

      sources[1].end();
      assert.equal(stopped, 1, 'fires exactly once, when the last source ends');
    } finally {
      undo();
    }
  });

  test('a single source ending fires onstopped', async () => {
    const { FakeAudioContext, sources } = makeAudioContext();
    const undo = withBrowserGlobals({ AudioContext: FakeAudioContext, fetchImpl: makeFetch() });
    try {
      const horn = new Horn();
      await horn.start();

      let stopped = 0;
      horn.onstopped = () => stopped++;
      sources[0].end();

      assert.equal(stopped, 1);
    } finally {
      undo();
    }
  });
});

describe('Horn error handling', () => {
  test('a failed buffer load rejects start() and is retried on the next start', async () => {
    // First context fails to decode; after the failure a fresh Horn must be
    // able to load again — the failed promise must not be memoized forever.
    const failing = makeAudioContext({ decodeFails: true });
    const undo1 = withBrowserGlobals({ AudioContext: failing.FakeAudioContext, fetchImpl: makeFetch() });
    try {
      const horn = new Horn();
      await assert.rejects(() => horn.start(), /decode failed/);
    } finally {
      undo1();
    }

    const working = makeAudioContext();
    const undo2 = withBrowserGlobals({ AudioContext: working.FakeAudioContext, fetchImpl: makeFetch() });
    try {
      const horn = new Horn();
      await horn.start(); // retry succeeds
      assert.equal(working.sources.length, 1);
    } finally {
      undo2();
    }
  });

  test('the same horn can load successfully after a failed decode', async () => {
    let decodeFails = true;
    // makeAudioContext reads opts.decodeFails at decode time, so a getter lets
    // the test flip the failure off mid-suite for the SAME horn instance.
    const ctx = makeAudioContext({ get decodeFails() { return decodeFails; } });
    const undo = withBrowserGlobals({ AudioContext: ctx.FakeAudioContext, fetchImpl: makeFetch() });
    try {
      const horn = new Horn();
      await assert.rejects(() => horn.start(), /decode failed/);

      decodeFails = false;
      await horn.start(); // the retry path on the SAME instance
      assert.equal(ctx.sources.length, 1);
      assert.equal(ctx.calls.decoded.length, 2, 'buffer was re-fetched for the retry');
    } finally {
      undo();
    }
  });

  test('a failing resume() rejects start() and no source is created', async () => {
    const { FakeAudioContext, sources } = makeAudioContext({ resumeThrows: true });
    const undo = withBrowserGlobals({ AudioContext: FakeAudioContext, fetchImpl: makeFetch() });
    try {
      const horn = new Horn();
      await assert.rejects(() => horn.start(), /resume failed/);
      assert.equal(sources.length, 0, 'nothing scheduled when the context will not resume');
    } finally {
      undo();
    }
  });
});
