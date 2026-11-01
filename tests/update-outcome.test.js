import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  REJECTED,
  UNMEASURABLE,
  UPDATED,
  assertUpdateMeasured,
  classifyUpdateOutcome,
} from '../tools/lib/update-outcome.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// airhorn-nxuv.6. The scenario called reg.update() and threw the answer away:
// `.then(() => true).catch(() => false)` with `false` discarded, so a REJECTED update
// reported pressInterrupted:false with status OK - a failed update that looks exactly
// like an update that never happened, i.e. like a pass.

test('a REJECTED update is its own named failing outcome (airhorn-nxuv.6)', () => {
  const update = classifyUpdateOutcome({
    registrationPresent: true,
    settled: false,
    errorMessage: 'ServiceWorker update failed: 500',
  });
  assert.deepEqual(update, { outcome: REJECTED, detail: 'ServiceWorker update failed: 500' });

  // The scenario must FAIL, and the message must name the rejection - not "no update".
  assert.throws(() => assertUpdateMeasured(update), (err) => {
    assert.match(err.message, /update REJECTED/);
    assert.match(err.message, /500/);
    return true;
  });
});

test('an UNMEASURABLE update fails as itself, never as a pass (airhorn-nxuv.6)', () => {
  // No registration to update.
  const none = classifyUpdateOutcome({ registrationPresent: false, settled: false });
  assert.equal(none.outcome, UNMEASURABLE);
  assert.match(none.detail, /no service worker registration/);
  assert.throws(() => assertUpdateMeasured(none), /could not be measured/);

  // The shape the old code produced: the promise was never observed settling, and
  // `.catch(() => false)` turned that into a discarded `false` = status OK.
  const OLD_READ = () => false; // the old swallowed value
  assert.equal(OLD_READ(), false, 'the old read is a false that nothing looked at');
  const never = classifyUpdateOutcome({ registrationPresent: true });
  assert.equal(never.outcome, UNMEASURABLE);
  assert.match(never.detail, /never observed to settle/);
  assert.throws(() => assertUpdateMeasured(never), /could not be measured/);
});

test('a settled update is the only outcome that passes (airhorn-nxuv.6)', () => {
  const updated = classifyUpdateOutcome({ registrationPresent: true, settled: true });
  assert.deepEqual(updated, { outcome: UPDATED, detail: 'reg.update() settled' });
  assert.equal(assertUpdateMeasured(updated), updated, 'a settled update returns the record');

  // An unknown/garbled outcome must not pass either.
  assert.throws(() => assertUpdateMeasured({ outcome: 'weird' }), /outcome is unknown/);
  assert.throws(() => assertUpdateMeasured(undefined), /outcome is unknown/);
});

test('only "settled: true" can reach the passing outcome (airhorn-nxuv.6)', () => {
  // Exhaustive over what the page can report: measured requires a registration AND a
  // fulfilment. Everything else is a named failure.
  const presences = [true, false, undefined];
  const settledStates = [true, false, undefined];
  let passing = 0;
  for (const registrationPresent of presences) {
    for (const settled of settledStates) {
      const update = classifyUpdateOutcome({ registrationPresent, settled, errorMessage: 'boom' });
      const passes = update.outcome === UPDATED;
      if (passes) {
        passing += 1;
        assert.equal(registrationPresent, true, 'passing implies a registration existed');
        assert.equal(settled, true, 'passing implies the promise fulfilled');
      } else {
        assert.throws(() => assertUpdateMeasured(update), /update/,
          `outcome ${update.outcome} must fail the scenario`);
      }
    }
  }
  assert.equal(passing, 1, 'exactly one of the nine observed states is a real update');
});

test('the audit takes its verdict from the rule, not from an inline comparison (airhorn-nxuv.6)', () => {
  // A rule the scenario can ignore is how the swallow lived. The page must report the
  // FACTS and Node must decide, so the decision under test is the one that ships.
  const source = fs.readFileSync(path.join(root, 'tools', 'resilience-audit.mjs'), 'utf8');
  assert.ok(source.includes('classifyUpdateOutcome('), 'the scenario must classify through the rule');
  assert.ok(source.includes('assertUpdateMeasured('), 'the scenario must fail through the rule');
  // Scope the absence check to THIS scenario: two other scenarios still call
  // reg.update() (one records its outcome, one is the corrupt-row sibling under its own
  // bead), and a whole-file absence assertion would be a lie about them.
  const start = source.indexOf("state.version = '2.0.0-audit-next';");
  assert.ok(start > 0, 'the update-during-press scenario must be findable');
  const scenario = source.slice(start, source.indexOf('await sleep(3000);', start));
  assert.ok(!scenario.includes('.catch(() => false)'),
    'the update-during-press scenario must not swallow the update outcome');
  assert.ok(scenario.includes('updateFacts'), 'the page must report raw facts, not an outcome');
  assert.ok(!/outcome: 'rejected'/.test(source),
    'the page must report facts, not decide the outcome itself');
});
