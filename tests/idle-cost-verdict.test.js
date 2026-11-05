import assert from 'node:assert/strict';
import test from 'node:test';

import { hiddenStopPass } from '../tools/idle-cost.mjs';

// airhorn-nxuv.2: idle-cost's verdict D ("a looping horn stops when hidden") never asserted
// the horn was PLAYING before the hide - beforeHide was captured into the report but not
// gated on - so a horn that never started "stopped" in 0 ms and D passed GREEN. These tests
// are browser-free on purpose: the verdict is Node-pure (the same extraction pattern as
// audio-parity's pitchVerdict), so the RED/GREEN pair runs without Chrome.

const QUIET_CPU = 0.4; // strictly inside BUDGET.hidden (0.5)

test('D passes when the horn was playing, stopped fast, and the hidden page is quiet', () => {
  assert.equal(hiddenStopPass({
    beforeHide: { playing: true, pressed: 'true' },
    stopLatencyMs: 120,
    afterHide: { playing: false, pressed: 'false' },
  }, QUIET_CPU), true);
});

test('D FAILS, named, when the horn was never playing before the hide (the nxuv.2 defect world)', () => {
  assert.equal(hiddenStopPass({
    beforeHide: { playing: false, pressed: 'false' },
    stopLatencyMs: 0,          // 'stopped' instantly because it never started
    afterHide: { playing: false, pressed: 'false' },
  }, QUIET_CPU), false,
    'a horn that never started must not satisfy "the looping horn stopped when hidden"');
});

test('D fails when the horn never stops', () => {
  assert.equal(hiddenStopPass({
    beforeHide: { playing: true, pressed: 'true' },
    stopLatencyMs: null,
    afterHide: { playing: true, pressed: 'true' },
  }, QUIET_CPU), false);
});

test('D fails when the hidden page is not quiet, even with a clean stop', () => {
  assert.equal(hiddenStopPass({
    beforeHide: { playing: true, pressed: 'true' },
    stopLatencyMs: 80,
    afterHide: { playing: false, pressed: 'false' },
  }, 99), false);
});

test('D fails on a missing/absent hidden report rather than passing on undefined', () => {
  assert.equal(hiddenStopPass(undefined, QUIET_CPU), false);
  assert.equal(hiddenStopPass({}, QUIET_CPU), false);
});
