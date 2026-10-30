import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  NO_EVENTS_INP_LABEL,
  NO_TARGET_INP_LABEL,
  interactionProblems,
  interactionVerdict,
} from '../tools/lib/interaction-verdict.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The rule this pins (airhorn-nxuv.14): when `.horn` is missing, measure-perf skipped
// the interaction and the report still printed an INP row reading
// "None (0 events >=16ms)" - so a page without the control looked exactly like a page
// whose interaction was too fast to register. A missing measurement must be its own
// failing outcome, not a value that reads as healthy.

test('a page with no .horn is a measured FAILURE, not an INP of None (airhorn-nxuv.14)', () => {
  const verdict = interactionVerdict({ targetFound: false, events: 0, inp: 'None (0 events >=16ms)' });
  assert.equal(verdict.measured, false);
  assert.equal(verdict.broken, true);
  assert.equal(verdict.inpLabel, NO_TARGET_INP_LABEL);
  assert.notEqual(verdict.inpLabel, 'None (0 events >=16ms)', 'the old value must not survive');
  assert.match(verdict.inpLabel, /NOT MEASURED/);
  const problems = interactionProblems(verdict);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /INTERACTION NOT MEASURED/);
  assert.match(problems[0], /no \.horn element/);
  assert.match(problems[1], /meaningless/);
});

test('an un-inspected page is not a pass either (airhorn-nxuv.14)', () => {
  // `undefined` means "never looked" - the same disease one step earlier.
  const verdict = interactionVerdict({ events: 12, inp: '48 ms' });
  assert.equal(verdict.measured, false);
  assert.equal(verdict.broken, true);
  assert.equal(verdict.inpLabel, NO_TARGET_INP_LABEL);
  assert.match(verdict.reason, /never inspected/);
});

test('a dispatched interaction with no slow events is measured, and says so (airhorn-nxuv.14)', () => {
  // The legitimately-fast case must stay distinguishable from the skipped one: the
  // click happened, the observer recorded zero events past the threshold.
  const verdict = interactionVerdict({ targetFound: true, events: 0 });
  assert.equal(verdict.measured, true);
  assert.equal(verdict.broken, false);
  assert.equal(verdict.inpLabel, NO_EVENTS_INP_LABEL);
  assert.match(verdict.inpLabel, /interaction dispatched/);
  assert.deepEqual(interactionProblems(verdict), []);
});

test('a dispatched interaction with a missing event count is unmeasured, not fast (airhorn-nxuv.14)', () => {
  const verdict = interactionVerdict({ targetFound: true });
  assert.equal(verdict.measured, false);
  assert.equal(verdict.broken, true);
  assert.match(verdict.reason, /no event count/);
  assert.ok(interactionProblems(verdict).length > 0);
});

test('a real INP passes through unchanged (airhorn-nxuv.14)', () => {
  const verdict = interactionVerdict({ targetFound: true, events: 3, inp: '128 ms' });
  assert.deepEqual(verdict, {
    measured: true,
    broken: false,
    inpLabel: '128 ms',
    reason: '3 event(s) recorded for the dispatched interaction',
  });
});

test('only a found target with a recorded event count can be measured (airhorn-nxuv.14)', () => {
  // Exhaustive over the shapes the caller can pass: measured requires targetFound true
  // AND a finite event count; everything else must carry a problem line.
  const targets = [true, false, undefined];
  const eventCounts = [0, 3, undefined, NaN];
  let measured = 0;
  for (const targetFound of targets) {
    for (const events of eventCounts) {
      const verdict = interactionVerdict({ targetFound, events, inp: '10 ms' });
      if (verdict.measured) {
        measured += 1;
        assert.equal(targetFound, true, 'measured implies the target was found');
        assert.ok(Number.isFinite(events), 'measured implies a recorded event count');
      } else {
        assert.equal(verdict.broken, true, 'every unmeasured verdict is a broken run');
        assert.ok(interactionProblems(verdict).length > 0, 'every unmeasured verdict owes its reason');
        assert.notEqual(verdict.inpLabel, 'None (0 events >=16ms)');
      }
    }
  }
  assert.equal(measured, 2, 'exactly the two finite event counts for a found target are measured');
});

test('measure-perf takes the INP label from the verdict instead of printing computeInp raw (airhorn-nxuv.14)', () => {
  // A pure-rule test cannot stop the report ignoring the rule, which is exactly how the
  // bug survived: the click was skipped and the column still got a plausible string.
  const source = fs.readFileSync(path.join(root, 'tools', 'measure-perf.mjs'), 'utf8');
  assert.ok(source.includes('interactionVerdict('), 'measure-perf must call the interaction rule');
  assert.ok(source.includes('interactionProblems('), 'measure-perf must print the reason when it did not measure');
  assert.ok(!source.includes("'INP (p98)': computeInp("),
    'the INP column must not print computeInp() without the interaction verdict');
  assert.ok(source.includes('const hornTarget = boxEval.result.value'),
    'the target lookup must be captured once and reused, not re-queried per click');
});
