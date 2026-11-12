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

test('olju: the drift rule is WIRED into the audit, not merely exported', () => {
  // The residual this closes: deleting the inline call in runAudit greened every other case here, because
  // the pure rule and the spawn both still pass with the check removed. The wiring is read out of the tool:
  // the rule must be applied to the LIVE KNOWN_SCENARIOS and the selectors the want() sites actually
  // evaluated, and a drift must ABORT the run rather than be reported as an ordinary row.
  const source = fs.readFileSync(tool, 'utf8');
  assert.match(source, /scenarioIdDrift\(\s*KNOWN_SCENARIOS\s*,\s*\[\.\.\.seenSelectors\]\s*\)/,
    'runAudit must apply the drift rule to the live selector set, not to a copy of it');
  assert.match(source, /if \(drift\) throw new Error\(`resilience-audit: \$\{drift\}`\)/,
    'and a drift must abort the audit - a row would let the run report OK over a selector no scenario answers');
});

test('olju: a drift ABORTS a drifted tool for real - the pin is behavioural, not text-shaped (airhorn-peq9)', () => {
  // airhorn-peq9: the wiring pin above is text-shaped, so a mutant that keeps both matched fragments
  // intact as DEAD CODE (an early return above them, a conditional that never fires) greens this whole
  // suite while a drifted tool exits 0 - the exact hole the olju fix existed to close, resurrected under
  // a green pin. This world proves the abort by EXECUTION: copy tools/ into a tmp dir, rename one
  // want() literal in the copy (a suite-side typo, the original defect), and require the copy to exit 1
  // naming BOTH diverging sides. A dead-coded throw in the real tool is inherited by the copy, the copy
  // then exits 0 on the drifted ids, and this world goes red - measured before landing (the pin was
  // RED-proven against the dead-code mutant of the throw; the regex world above stays green on it, which
  // is precisely why this world exists).
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'olju-drift-'));
  try {
    const toolsCopy = path.join(out, 'tools');
    fs.cpSync(path.join(root, 'tools'), toolsCopy, { recursive: true });
    // The copy resolves dist/ against ITS own root (startServer shims the served sw.js even on a
    // 'none' run), so it needs the real built dist to get past server setup and reach the drift check.
    // Read-only: the shim stamps what it SERVES, never the file on disk.
    fs.symlinkSync(path.join(root, 'dist'), path.join(out, 'dist'), 'dir');
    const copyPath = path.join(toolsCopy, 'resilience-audit.mjs');
    const copy = fs.readFileSync(copyPath, 'utf8');
    assert.match(copy, /want\('quota'\)/, 'the drift target literal must exist for this world to mean anything');
    const drifted = copy.replace("want('quota')", "want('qu0ta')");
    assert.notEqual(drifted, copy, 'the drift edit must actually change the copy');
    assert.doesNotMatch(drifted, /want\('quota'\)/, 'the original literal must be gone, not duplicated');
    fs.writeFileSync(copyPath, drifted);
    const run = spawnSync(process.execPath, [copyPath], {
      env: { ...process.env, RESILIENCE_ONLY: 'none', RESILIENCE_OUT: path.join(out, 'res'), CHROME_BIN: '/nonexistent-chrome' },
      encoding: 'utf8', timeout: 60000,
    });
    const said = run.stdout + run.stderr;
    assert.equal(run.status, 1, `a drifted tool must ABORT with rc 1 (got ${run.status}):
${said}`);
    assert.match(said, /resilience-audit: scenario-id drift/, 'the abort must be the drift error, not an incidental failure');
    assert.match(said, /only in KNOWN_SCENARIOS: quota/, 'it must name the side the rename left behind');
    assert.match(said, /only in want\(\): qu0ta/, 'and the side the rename invented');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
