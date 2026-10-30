import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CACHED_LABEL,
  repeatLoadCaveat,
  repeatLoadVerdict,
} from '../tools/lib/repeat-load-verdict.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The rule this pins (airhorn-nxuv.13): the repeat load may only be described as
// worker-cached when a worker was ALSO controlling the repeat load - and when the
// worker never activated, the report must say so instead of quietly labelling the
// row "SW-cached" and letting the byte delta read as a caching win.

test('a worker that controlled both loads earns the cached label (airhorn-nxuv.13)', () => {
  const verdict = repeatLoadVerdict({ coldControlled: true, repeatControlled: true });
  assert.deepEqual(verdict, {
    cached: true,
    label: CACHED_LABEL,
    reason: 'a worker was controlling both loads',
  });
  assert.deepEqual(repeatLoadCaveat(verdict), [], 'a genuine caching measurement needs no caveat');
});

test('AN UNACTIVATED WORKER IS NOT A CACHING WIN (airhorn-nxuv.13)', () => {
  // The regression the bead describes: the old code printed "Repeat (SW-cached)
  // Load" for exactly this observation, next to "SW Controller Present: false".
  const verdict = repeatLoadVerdict({ coldControlled: false, repeatControlled: false });
  assert.equal(verdict.cached, false);
  assert.notEqual(verdict.label, CACHED_LABEL);
  assert.match(verdict.label, /NEVER ACTIVATED/);
  const caveat = repeatLoadCaveat(verdict);
  assert.equal(caveat.length, 2);
  assert.match(caveat[0], /NOT A CACHING MEASUREMENT/);
  assert.match(caveat[0], /no worker was controlling the cold load/);
});

test('the label master printed unconditionally is the one the verdict withholds (airhorn-nxuv.13)', () => {
  // The old read, pinned: tools/measure-perf.mjs hard-coded this row key for every
  // run, so an unactivated worker and a genuine worker-cache hit were reported the
  // same way. If CACHED_LABEL ever stops being that string, this test is telling the
  // reviewer that the "before" being described has moved.
  const OLD_UNCONDITIONAL_LABEL = 'Repeat (SW-cached) Load';
  assert.equal(CACHED_LABEL, OLD_UNCONDITIONAL_LABEL);
  assert.notEqual(repeatLoadVerdict({ coldControlled: false, repeatControlled: false }).label,
    OLD_UNCONDITIONAL_LABEL);
});

test('measure-perf takes the report label from the verdict instead of hard-coding it (airhorn-nxuv.13)', () => {
  // A pure-rule test cannot stop the report from ignoring the rule, which is how the
  // bug survived: the observation was made and printed, and the label above it
  // disagreed. So the wiring is pinned too - the row key must not be a literal.
  const source = fs.readFileSync(path.join(root, 'tools', 'measure-perf.mjs'), 'utf8');
  assert.ok(source.includes('repeatLoadVerdict('), 'measure-perf must call the verdict rule');
  assert.ok(source.includes('repeatLoadCaveat('), 'measure-perf must print the caveat');
  assert.ok(!source.includes("'Repeat (SW-cached) Load':"),
    'the cached label must not be hard-coded in the report table');
  assert.ok(source.includes('[repeatVerdict.label]:'),
    'the repeat row must be keyed by the verdict label');
  assert.ok(source.includes('repeat=${swActiveRepeat}'),
    'the controller line must report BOTH loads, not just the cold one');
});

test('a worker that controlled the cold load but not the repeat is not cached either (airhorn-nxuv.13)', () => {
  const verdict = repeatLoadVerdict({ coldControlled: true, repeatControlled: false });
  assert.equal(verdict.cached, false);
  assert.match(verdict.label, /LOST CONTROL/);
  assert.match(repeatLoadCaveat(verdict)[0], /not served by it/);
});

test('an unmeasured worker state is not a pass (airhorn-nxuv.13)', () => {
  // `undefined`/`null` mean "never observed" - the same disease one step earlier:
  // a missing measurement must not default to the healthy label.
  for (const observed of [undefined, null]) {
    const never = repeatLoadVerdict({ coldControlled: observed, repeatControlled: true });
    assert.equal(never.cached, false, `cold=${observed} must not read as cached`);
    assert.match(never.label, /UNMEASURED/);

    const unmeasuredRepeat = repeatLoadVerdict({ coldControlled: true, repeatControlled: observed });
    assert.equal(unmeasuredRepeat.cached, false, `repeat=${observed} must not read as cached`);
    assert.match(unmeasuredRepeat.label, /UNMEASURED on the repeat/);
  }
  // Called with nothing at all, it must still refuse rather than throw or pass.
  const empty = repeatLoadVerdict();
  assert.equal(empty.cached, false);
  assert.match(empty.label, /UNMEASURED/);
});

test('only a measured true on both loads can reach the cached label (airhorn-nxuv.13)', () => {
  // Exhaustive over the shapes the caller can actually pass: exactly one of the nine
  // combinations may be cached, and it is (true, true).
  const values = [true, false, undefined];
  let cached = 0;
  for (const cold of values) {
    for (const repeat of values) {
      const verdict = repeatLoadVerdict({ coldControlled: cold, repeatControlled: repeat });
      if (verdict.cached) {
        cached += 1;
        assert.equal(cold, true, 'cached implies a measured, controlling cold load');
        assert.equal(repeat, true, 'cached implies a measured, controlling repeat load');
        assert.equal(verdict.label, CACHED_LABEL);
      } else {
        assert.notEqual(verdict.label, CACHED_LABEL, `cold=${cold} repeat=${repeat} kept the cached label`);
        assert.ok(repeatLoadCaveat(verdict).length > 0, 'every non-cached verdict owes a caveat');
      }
    }
  }
  assert.equal(cached, 1, 'exactly one of the nine observed states is a caching measurement');
});
