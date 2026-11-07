// Pin for airhorn-olju: KNOWN_SCENARIOS and the six want('<id>') call-site literals are
// two copies of the scenario id set; a rename on one side used to desync silently (the
// selector validation would accept or reject a name no scenario answers to). Cross-asserted,
// not derived: deriving would make both sides one source that can only agree with itself -
// a typo in it would validate AND gate the wrong name and nothing would disagree. Keeping
// the literals independent and checking the sets agree is what makes each a check on the
// other (coord's instinct, confirmed by that asymmetry).
//
// The pure rule is pinned below; the WIRING (the inline call after the scenario block) is
// pinned by the agreement spawn plus the ad-hoc RED proofs on the bead: renaming an id on
// EITHER side made a RESILIENCE_ONLY=none run exit 1 naming both copies (pasted on
// airhorn-olju). Residual, stated: deleting the inline call greens this suite - the spawn
// proves the sets agree TODAY, not that the check still runs; that is the same
// one-line-call gap every inline assert has.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarioIdDrift } from '../tools/resilience-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'resilience-audit.mjs');

test('olju: the drift rule names whichever side diverged', () => {
  assert.equal(scenarioIdDrift(['a', 'b'], ['b', 'a']), null, 'agreement in any order passes');
  assert.match(scenarioIdDrift(['a', 'b'], ['a']), /only in KNOWN_SCENARIOS: b/, 'a missing want() literal is named');
  assert.match(scenarioIdDrift(['a'], ['a', 'c']), /only in want\(\): c/, 'an extra want() literal is named');
});

test('olju: the tool runs clean when the two copies agree (wiring exists and passes)', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'olju-'));
  const run = spawnSync(process.execPath, [tool], {
    env: { ...process.env, RESILIENCE_ONLY: 'none', RESILIENCE_OUT: out, CHROME_BIN: '/nonexistent-chrome' },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(run.status, 0, `the two copies agree today (got ${run.status}):\n${run.stderr}`);
  assert.doesNotMatch(run.stderr + run.stdout, /scenario-id drift/);
});
