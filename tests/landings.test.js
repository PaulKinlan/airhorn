// tests/landings.test.js — airhorn-32wa.
//
// The question the weekly review asks is "was this landing gated?", and the durable answer is the
// MERGE COMMIT MESSAGE that `fleet-land-message` writes (GATE / REVIEW blocks), not the per-tree
// verdict cache: the cache is pruned, so a week-old absence there means "no record kept", not "never
// verified". tools/landings.mjs reads the durable record back.
//
// These tests are hermetic: the parse/classify half is exercised on message fixtures, and the read
// half is exercised against a throwaway git repository built in a temp dir — never this checkout's
// history, this VM's verdict cache, or any other suite's files. Every fixture state is a shape real
// history contains (a pass on the landed tree, a batch's "no cached verdict yet" placeholder, a
// failing verdict, a pass recorded for a DIFFERENT tree, no record at all, and a non-fleet merge).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseSections,
  parseGate,
  parseReview,
  parseLandingMessage,
  classifyLandings,
  summarise,
  withinRange,
  resolveRef,
  parseArgs,
} from '../tools/landings.mjs';

const TOOL = fileURLToPath(new URL('../tools/landings.mjs', import.meta.url));

const TREE_A = 'a'.repeat(40);
const TREE_B = 'b'.repeat(40);

const passGate = (tree, kind = 'full') =>
  `PASS (${kind} gate) for tree ${tree} (cached for commit abc1234) in 12s run by merger at 2026-01-01T00:00:00Z\nLog /tmp/checks/${tree}.log`;
const placeholderGate =
  'no cached verdict yet (merge tree pending: NOT a pass). The batch gate result goes in this\nsection with\n  git commit --amend -F <(fleet-land-message --gate abc1234 airhorn-b2 fleet/batch-b)';

/** A commit message with the section shape fleet-land-message writes (BRANCH carries its first line inline). */
function fleetMessage({ bead, branch, tip = 'abc1234', gate, review, batch }) {
  const lines = [
    `Merge ${branch} (${bead}): fixture landing for ${bead}`,
    '',
    'BEAD',
    `${bead} - fixture landing`,
    `BRANCH ${branch} (tip ${tip}, 1 commit(s), 1 file changed, 1 insertion(+))`,
    'SUMMARY from comment #1 by fixture-lane at 2026-01-01T00:00:00Z',
    '',
    'WHY',
    'the fixture needs a landing',
    '',
    'WHAT CHANGED',
    'one file',
    '',
    'USER-VISIBLE EFFECT',
    'none: fixture',
    '',
    'REVIEW',
    review || 'PASS (verdict: PASS) for commit abc1234 by rev-lane at 2026-01-01T00:00:00Z [reviewer zai/glm-5.3-flash; independence: other-lane]',
  ];
  if (gate !== undefined) lines.push('', 'GATE', gate);
  lines.push('', 'RELEASE-NOTE', 'none');
  if (batch) lines.push('', 'BATCH GATE SCOPE AND HOST', batch);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Parsing: the message is the record, so its shapes are the contract.
// ---------------------------------------------------------------------------------------------

test('sections split on labels, including BRANCH whose first line is on the header line', () => {
  const sections = parseSections(fleetMessage({ bead: 'airhorn-a1', branch: 'fleet/one', gate: passGate(TREE_A) }));
  assert.match(sections.BRANCH, /^fleet\/one \(tip abc1234/);
  assert.match(sections.GATE, /^PASS \(full gate\)/);
  assert.match(sections.REVIEW, /verdict: PASS/);
  assert.equal(sections['BATCH GATE SCOPE AND HOST'], undefined);
});

test('a batch note is its own block, never read as the GATE block', () => {
  const sections = parseSections(
    fleetMessage({ bead: 'airhorn-b2', branch: 'fleet/batch-b', gate: placeholderGate, batch: 'Two branches landed: fleet/one and fleet/batch-b' })
  );
  assert.match(sections.GATE, /no cached verdict yet/);
  assert.match(sections['BATCH GATE SCOPE AND HOST'], /fleet\/one/);
});

test('a PASS is recognised structurally, and a placeholder is not read as one', () => {
  const pass = parseGate(passGate(TREE_A));
  assert.deepEqual(
    { state: pass.state, form: pass.form, kind: pass.kind, tree: pass.tree, commit: pass.commit, at: pass.at },
    { state: 'pass', form: 'verdict', kind: 'full', tree: TREE_A, commit: 'abc1234', at: '2026-01-01T00:00:00Z' }
  );
  assert.equal(pass.log, `/tmp/checks/${TREE_A}.log`);

  // The placeholder literally contains the words "NOT a pass": prose must never decide this.
  const placeholder = parseGate(placeholderGate);
  assert.equal(placeholder.state, 'unrecorded');
  assert.equal(placeholder.form, 'placeholder');
  assert.equal(placeholder.tree, null);
});

test('a message with no GATE block is "absent", which is a different absence from a placeholder', () => {
  const absent = parseGate(undefined, { present: false });
  assert.equal(absent.state, 'unrecorded');
  assert.equal(absent.form, 'absent');
});

test('a FAIL verdict is a failure, not a missing record', () => {
  const fail = parseGate(`FAIL (full gate) for tree ${TREE_A} in 12s run by merger at 2026-01-01T00:00:00Z`);
  assert.equal(fail.state, 'fail');
  assert.equal(fail.form, 'verdict');
});

test('review verdicts separate a plain pass from a pass with notes and a fail', () => {
  assert.equal(parseReview('PASS (verdict: PASS) for commit abc1234 by rev at t [reviewer qwen; independence: other-lane]').state, 'review-pass');
  const notes = parseReview('PASS (verdict: PASS-with-notes) for commit abc1234 by rev at t [reviewer qwen; independence: other-lane]');
  assert.equal(notes.state, 'review-pass-with-notes');
  assert.equal(notes.reviewer, 'qwen');
  assert.equal(notes.lane, 'rev');
  assert.equal(parseReview('FAIL (verdict: FAIL) for commit abc1234 by rev at t').state, 'review-fail');
  assert.equal(parseReview('').state, 'no-review');
});

test('a landing record carries bead, branch and tip from the message', () => {
  const landing = parseLandingMessage({
    sha: 'f'.repeat(40),
    tree: TREE_A,
    date: '2026-01-02T00:00:00+00:00',
    subject: 'Merge fleet/one (airhorn-a1): fixture landing for airhorn-a1',
    body: fleetMessage({ bead: 'airhorn-a1', branch: 'fleet/one', gate: passGate(TREE_A) }),
  });
  assert.equal(landing.bead, 'airhorn-a1');
  assert.equal(landing.branch, 'fleet/one');
  assert.equal(landing.tip, 'abc1234');
  assert.equal(landing.isFleetLanding, true);
});

test('a non-fleet merge is not a landing', () => {
  const landing = parseLandingMessage({
    sha: 'e'.repeat(40),
    tree: TREE_A,
    date: '2026-01-02T00:00:00+00:00',
    subject: "Merge branch 'scratch' into master",
    body: "Merge branch 'scratch' into master\n",
  });
  assert.equal(landing.isFleetLanding, false);
});

// ---------------------------------------------------------------------------------------------
// Classification: the states, one test each so a name cannot go hollow.
// ---------------------------------------------------------------------------------------------

function landing({ sha, tree = TREE_A, date = '2026-01-01T00:00:00+00:00', bead = 'airhorn-a1', gate, review }) {
  return parseLandingMessage({
    sha,
    tree,
    date,
    subject: `Merge fleet/${bead} (${bead}): fixture`,
    body: fleetMessage({ bead, branch: `fleet/${bead}`, gate, review }),
  });
}

const classified = (shas) => classifyLandings(shas);

test('a pass for the landed tree is "gated"', () => {
  const [row] = classified([landing({ sha: '1'.repeat(40), gate: passGate(TREE_A) })]);
  assert.equal(row.state, 'gated');
  assert.equal(row.coveredBy, null);
});

test('a pass recorded for a DIFFERENT tree does not answer for this landing', () => {
  const [row] = classified([landing({ sha: '2'.repeat(40), tree: TREE_A, gate: passGate(TREE_B) })]);
  assert.equal(row.state, 'gated-other-tree');
});

test('a recorded FAIL is "gate-failed", never "ungated"', () => {
  const [row] = classified([landing({ sha: '3'.repeat(40), gate: `FAIL (full gate) for tree ${TREE_A} in 12s run by merger at t` })]);
  assert.equal(row.state, 'gate-failed');
});

test('a batch placeholder is "gated-in-batch" when a NEWER landing gated the union that contains it', () => {
  const older = landing({ sha: '4'.repeat(40), bead: 'airhorn-a1', gate: placeholderGate, date: '2026-01-02T00:00:00+00:00' });
  const newer = landing({ sha: '5'.repeat(40), bead: 'airhorn-b2', gate: passGate(TREE_A), date: '2026-01-03T00:00:00+00:00' });
  // Newest first, as the walk produces them.
  const [newRow, oldRow] = classified([newer, older]);
  assert.equal(newRow.state, 'gated');
  assert.equal(oldRow.state, 'gated-in-batch');
  assert.equal(oldRow.coveredBy, newer.sha);
});

test('a placeholder with no newer gate is "ungated" — the truthful answer', () => {
  const older = landing({ sha: '6'.repeat(40), bead: 'airhorn-a1', gate: placeholderGate });
  const newerUngated = landing({ sha: '7'.repeat(40), bead: 'airhorn-b2', gate: placeholderGate, date: '2026-01-02T00:00:00+00:00' });
  const [newRow, oldRow] = classified([newerUngated, older]);
  assert.equal(newRow.state, 'ungated');
  assert.equal(oldRow.state, 'ungated');
});

test('the summary names the landings that need attention and counts both dimensions', () => {
  const rows = classified([
    landing({ sha: '8'.repeat(40), bead: 'airhorn-a1', gate: passGate(TREE_A) }),
    landing({ sha: '9'.repeat(40), bead: 'airhorn-b2', gate: passGate(TREE_B) }),
  ]);
  const summary = summarise(rows);
  assert.equal(summary.total, 2);
  assert.equal(summary.byState.gated, 1);
  assert.equal(summary.byState['gated-other-tree'], 1);
  assert.deepEqual(summary.needsAttention, ['9'.repeat(40)]);
  assert.equal(summary.byReview['review-pass'], 2);
});

test('date bounds are inclusive and a date-only --until covers its whole UTC day', () => {
  assert.equal(withinRange('2026-01-01T23:30:00+00:00', null, '2026-01-01'), true);
  assert.equal(withinRange('2026-01-02T00:00:01+00:00', null, '2026-01-01'), false);
  assert.equal(withinRange('2026-01-01T10:00:00+00:00', '2026-01-01', null), true);
  assert.equal(withinRange('2025-12-31T23:59:59+00:00', '2026-01-01', null), false);
});

// ---------------------------------------------------------------------------------------------
// The read path, against a throwaway repository: git is the record, so the walk over git is the
// behaviour under test. Nothing here touches this checkout or ~/.fleet.
// ---------------------------------------------------------------------------------------------

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...env },
  });
}

function fixtureRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airhorn-landings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['config', 'user.name', 'Fixture']);
  commit(dir, 'base.txt', 'base\n', 'base commit', '2026-01-01T00:00:00+00:00');
  return dir;
}

function commit(dir, file, content, message, date) {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ['add', file]);
  git(dir, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

/**
 * Land a fixture branch: a commit on `branch`, then a --no-ff merge on master. The merge message needs
 * the merge commit's OWN tree, which only exists after the merge, so it is amended in — the same two
 * steps the merger takes (merge, then amend with fleet-land-message).
 */
function land(dir, { bead, branch, gateFor, review, batch, date }) {
  git(dir, ['checkout', '-q', '-b', branch]);
  commit(dir, `${bead}.txt`, `${bead}\n`, `${bead}: branch work`, date);
  const tip = git(dir, ['rev-parse', branch]).trim();
  git(dir, ['checkout', '-q', 'master']);
  git(dir, ['merge', '--no-ff', '-q', '-m', `placeholder ${bead}`, branch], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  // The amending commit keeps the merge's parents and tree; only the message changes.
  git(dir, ['commit', '--amend', '-q', '-m', `placeholder ${bead}`]);
  const tree = git(dir, ['rev-parse', 'HEAD^{tree}']).trim();
  const message = fleetMessage({ bead, branch, tip, gate: gateFor(tree), review, batch });
  fs.writeFileSync(path.join(dir, '.git', 'FIXTURE_MESSAGE'), message);
  git(dir, ['commit', '--amend', '-q', '-F', path.join(dir, '.git', 'FIXTURE_MESSAGE')], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

function buildFixture(t) {
  const dir = fixtureRepo(t);
  const shas = {};
  // 1. own-tree pass
  shas.a1 = land(dir, { bead: 'airhorn-a1', branch: 'fleet/one', gateFor: (tree) => passGate(tree), date: '2026-01-01T10:00:00+00:00' });
  // 2. batch placeholder, covered by 3
  shas.b2 = land(dir, { bead: 'airhorn-b2', branch: 'fleet/two', gateFor: () => placeholderGate, date: '2026-01-02T10:00:00+00:00' });
  // 3. own-tree pass that names the batch (the union gate for 2)
  shas.c3 = land(dir, {
    bead: 'airhorn-c3',
    branch: 'fleet/batch-c',
    gateFor: (tree) => passGate(tree),
    batch: 'Two branches landed oldest first on this union: fleet/two@abc1234 (airhorn-b2) and fleet/batch-c@def5678 (airhorn-c3).',
    date: '2026-01-03T10:00:00+00:00',
  });
  // 4. newest placeholder: nothing newer to cover it
  shas.d4 = land(dir, { bead: 'airhorn-d4', branch: 'fleet/four', gateFor: () => placeholderGate, date: '2026-01-04T10:00:00+00:00' });
  // 5. recorded FAIL
  shas.e5 = land(dir, { bead: 'airhorn-e5', branch: 'fleet/five', gateFor: (tree) => `FAIL (full gate) for tree ${tree} in 12s run by merger at t`, date: '2026-01-05T10:00:00+00:00' });
  // 6. PASS recorded for another tree
  shas.f6 = land(dir, { bead: 'airhorn-f6', branch: 'fleet/six', gateFor: () => passGate(TREE_B), date: '2026-01-06T10:00:00+00:00' });
  // 7. a non-fleet merge, which is not a landing
  git(dir, ['checkout', '-q', '-b', 'scratch']);
  commit(dir, 'scratch.txt', 'scratch\n', 'scratch work', '2026-01-07T10:00:00+00:00');
  git(dir, ['checkout', '-q', 'master']);
  git(dir, ['merge', '--no-ff', '-q', '-m', "Merge branch 'scratch' into master", 'scratch'], {
    GIT_AUTHOR_DATE: '2026-01-07T10:00:00+00:00',
    GIT_COMMITTER_DATE: '2026-01-07T10:00:00+00:00',
  });
  return { dir, shas };
}

test('the read path classifies every fixture landing from git history alone', (t) => {
  const { dir } = buildFixture(t);
  // Read through the CLI, which is what a reviewer or the weekly sweep actually runs.
  assert.equal(resolveRef(dir), 'master', 'the trunk falls back to master when origin/master is absent');
  const json = JSON.parse(execFileSync(process.execPath, [TOOL, '--json'], { cwd: dir, encoding: 'utf8' }));
  const byBead = Object.fromEntries(json.landings.map((row) => [row.bead, row]));
  assert.deepEqual(Object.keys(byBead).sort(), ['airhorn-a1', 'airhorn-b2', 'airhorn-c3', 'airhorn-d4', 'airhorn-e5', 'airhorn-f6']);
  assert.equal(byBead['airhorn-a1'].state, 'gated');
  assert.equal(byBead['airhorn-b2'].state, 'gated-in-batch');
  assert.equal(byBead['airhorn-b2'].coveredBy, byBead['airhorn-c3'].sha);
  assert.equal(byBead['airhorn-c3'].state, 'gated');
  assert.equal(byBead['airhorn-d4'].state, 'ungated');
  assert.equal(byBead['airhorn-e5'].state, 'gate-failed');
  assert.equal(byBead['airhorn-f6'].state, 'gated-other-tree');
  assert.equal(json.skippedNonFleetMerges, 1);
  assert.equal(json.summary.total, 6);
  assert.deepEqual(json.summary.byState, { gated: 2, 'gated-in-batch': 1, 'gated-other-tree': 1, 'gate-failed': 1, ungated: 1 });
});

/** Run the CLI and report its exit code instead of throwing on a non-zero one. */
function run(cwd, args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout || ''), stderr: String(error.stderr || '') };
  }
}

test('--require-gate fails on a landing with no usable evidence and passes on one that has it', (t) => {
  const { dir } = buildFixture(t);
  assert.equal(run(dir, ['--require-gate']).code, 1, 'three fixture landings have no usable gate evidence');
  // A single gated landing satisfies the flag, so the check is usable per landing.
  assert.equal(run(dir, ['--bead', 'airhorn-a1', '--require-gate']).code, 0);
  // ... and a batch-covered landing counts as evidence, but a mismatch does not.
  assert.equal(run(dir, ['--bead', 'airhorn-b2', '--require-gate']).code, 0);
  assert.equal(run(dir, ['--bead', 'airhorn-f6', '--require-gate']).code, 1);
});

test('the date window and the bead filter select the landings they name', (t) => {
  const { dir } = buildFixture(t);
  const window = JSON.parse(
    execFileSync(process.execPath, [TOOL, '--json', '--since', '2026-01-02', '--until', '2026-01-04'], { cwd: dir, encoding: 'utf8' })
  );
  assert.deepEqual(window.landings.map((row) => row.bead), ['airhorn-d4', 'airhorn-c3', 'airhorn-b2']);

  const one = execFileSync(process.execPath, [TOOL, '--bead', 'airhorn-b2'], { cwd: dir, encoding: 'utf8' });
  assert.match(one, /airhorn-b2/);
  assert.match(one, /gated-in-batch/);
  assert.doesNotMatch(one, /airhorn-a1/);

  const text = execFileSync(process.execPath, [TOOL], { cwd: dir, encoding: 'utf8' });
  assert.match(text, /landings: gate — gated 2, gated-in-batch 1, gated-other-tree 1, gate-failed 1, ungated 1/);
  assert.match(text, /landings: review — /);
});

test('an unknown argument is refused instead of absorbed', () => {
  assert.throws(() => parseArgs(['--nonsense']), /unknown argument: --nonsense/);
  assert.throws(() => parseArgs(['--limit', '0']), /positive integer/);
  assert.throws(() => parseArgs(['--since']), /needs a value/);
});
