// Pin for airhorn-nxuv.9: the sounded probe must count a start() only when playback
// actually STARTED. 18c0ad7 carried this fix and a later merge took the other side of
// the PROBE section, restoring increment-before-call - so a start() that THREW still
// read as a buffer started, and absence looked like success. These tests drive the REAL
// PROBE string the audit injects (no copy) against a mock AudioContext, browser-free.

import test from 'node:test';
import assert from 'node:assert/strict';

const runProbe = (PROBE, { throwOnStart = false } = {}) => {
  const window = { __errors: [], addEventListener() {} };
  const node = {
    start() {
      if (throwOnStart) throw new Error('InvalidStateError: cannot start twice');
    },
  };
  class MockAC {
    createBufferSource() { return { ...node, start: node.start.bind(node) }; }
    createOscillator() { return { ...node, start: node.start.bind(node) }; }
  }
  window.AudioContext = MockAC;
  const fn = new Function('window', 'navigator', `${PROBE.replace(/^`|`$/g, '')}`);
  fn(window, {});
  return window;
};

test('a successful start() increments the counter (the honest world)', async () => {
  const { PROBE } = await import('../tools/resilience-audit.mjs');
  const window = runProbe(PROBE);
  const src = new (window.AudioContext)().createBufferSource();
  src.start();
  assert.equal(window.__probe.bufferStarts, 1);
  assert.equal(window.__probe.startThrows, 0);
});

test('a start() that THROWS is not counted as a start (the nxuv.9 defect world)', async () => {
  const { PROBE } = await import('../tools/resilience-audit.mjs');
  const window = runProbe(PROBE, { throwOnStart: true });
  const src = new (window.AudioContext)().createBufferSource();
  assert.throws(() => src.start(), /InvalidStateError/);
  assert.equal(window.__probe.bufferStarts, 0,
    'a throwing start() incremented bufferStarts - the probe records intent, not playback');
  assert.equal(window.__probe.startThrows, 1, 'the throw must be an explicit outcome');
  assert.match(window.__probe.lastStartError, /InvalidStateError/);
});

test('the mutation seam makes the same world without app cooperation (RESILIENCE_START_THROWS)', async () => {
  process.env.RESILIENCE_TEST_MODE = '1';
  process.env.RESILIENCE_START_THROWS = '1';
  try {
    const { PROBE } = await import(`../tools/resilience-audit.mjs?seam=${Date.now()}`);
    const window = runProbe(PROBE); // app start() is HEALTHY here; the seam replaces it
    const src = new (window.AudioContext)().createBufferSource();
    assert.throws(() => src.start(), /forced to throw/);
    assert.equal(window.__probe.bufferStarts, 0, 'the seam world must read NOT sounded');
    assert.equal(window.__probe.startThrows, 1);
  } finally {
    delete process.env.RESILIENCE_TEST_MODE;
    delete process.env.RESILIENCE_START_THROWS;
  }
});
