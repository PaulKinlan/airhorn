import assert from 'node:assert/strict';
import test from 'node:test';

import { hiddenStopPass, readIdleCounters } from '../tools/idle-cost.mjs';

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

test('nxuv.37: the resource count is captured AT the window boundary, not after (airhorn-nxuv.37)', async () => {
  // Synthetic counter world: the page's resource count grows DURING the window (5 -> 9).
  // The fixed capture puts each read inside its boundary snapshot, so the delta is 4.
  let resources = 5;
  const evaluate = (expr) => Promise.resolve(
    expr.includes('getEntriesByType') ? resources : { rafs: 0 });
  const before = await readIdleCounters(evaluate);
  resources = 9;   // the window's activity happens between the snapshots
  const after = await readIdleCounters(evaluate);
  assert.equal(after.resourceEntries - before.resourceEntries, 4,
    'a window with known resource activity must produce a non-zero delta (was ~0 when the reads happened after the window)');
});
