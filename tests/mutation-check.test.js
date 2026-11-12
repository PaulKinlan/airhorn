import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { exportedSameFile } from '../tools/lib/suite-mode-reporter.mjs';
import { normalizeSuiteToken } from '../tools/derive-coverage-contract.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyMutation,
  mutationApplied,
  mutationTargetProblem,
  restoreVerified,
  classifyRun,
  readChannel,
  suiteLoadProblem,
  suitePresenceProblem,
  verdictFor,
} from '../tools/mutation-check.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'mutation-check.mjs');

/* --- a refusal that would otherwise be unobservable is pinned (airhorn-1vfh, airhorn-lpgh) ---- */

test('no start, but failures reported: never a caught mutant (airhorn-1vfh)', () => {
  // The reporter can see a run where failures were reported but no test ever STARTED. That is the exact combination
  // that produced false "caught" verdicts before the rule existed, and until now the refusal was LIVE but UNPINNED:
  // deleting it left every test green, because no real suite produces the shape by accident. So it is driven here
  // against the classifier that makes the decision, with the honest pair as a control so this cannot pass vacuously.
  const noStart = classifyRun({
    report: { driver: { importFailed: false }, realTests: 2, realFailed: 1, startedTests: 0, wrapperEvents: 0, failing: ['x'] },
    exitCode: 1,
  });
  assert.equal(noStart.mode, 'threw-outside-a-test',
    `a failure with no started test must never be scored caught, got ${JSON.stringify(noStart)}`);
  assert.match(noStart.problem, /no test ever STARTED/);
  assert.notEqual(noStart.rc, 1, 'and it must not carry the caught exit code');

  // Control: the same counts WITH a started test are a caught mutant - else the assertion above could be satisfied
  // by refusing every failure.
  const caught = classifyRun({
    report: { driver: { importFailed: false }, realTests: 2, realFailed: 1, startedTests: 1, wrapperEvents: 0, failing: ['x'] },
    exitCode: 1,
  });
  assert.equal(caught.mode, 'caught');
  assert.equal(caught.rc, 1);
});

test('--dry-run writes nothing and runs nothing, and the same command without it does mutate (airhorn-lpgh)', () => {
  // The flag was parsed and stored and then never read, so a caller asking for a rehearsal got the real mutation, the
  // real suite run and the real restore. This pins the plan-only contract end to end, and the control run proves the
  // fixture is otherwise capable of mutating - otherwise "the file did not change" would be satisfied by a broken tool.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lpgh-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    const subject = path.join(tmp, 'src', 'subject.js');
    const original = 'export const f = (n) => n + 1;\n';
    fs.writeFileSync(subject, original);
    fs.writeFileSync(path.join(tmp, 'green.mjs'), "import test from 'node:test';\ntest('green', () => {});\n");
    const run = (...extra) => spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', 'n + 1', '--to', 'n + 2', '--suite', 'green.mjs', ...extra], { cwd: tmp, encoding: 'utf8', timeout: 60000 });

    const dry = run('--dry-run');
    assert.equal(dry.status, 0, `a clean dry run exits 0: ${dry.stdout}${dry.stderr}`);
    assert.match(dry.stdout, /dry run - nothing was written and no suite was run/);
    assert.match(dry.stdout, /would mutate src\/subject\.js/);
    assert.match(dry.stdout, /would then run green\.mjs/);
    assert.match(dry.stdout, /would restore src\/subject\.js/);
    assert.doesNotMatch(dry.stdout, /mutant applied/, 'a dry run must not claim it applied anything');
    assert.doesNotMatch(dry.stdout, /verdict:/, 'and must not produce a verdict - it measured nothing');
    assert.equal(fs.readFileSync(subject, 'utf8'), original, 'the file must be byte-identical after a dry run');

    const real = run();
    assert.match(real.stdout, /mutant applied/, 'the control run must really mutate, or the check above proves nothing');
    assert.equal(fs.readFileSync(subject, 'utf8'), original, 'and it restores the file afterwards');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('--dry-run refuses what the run would refuse, and plans every step the run takes (airhorn-qf30)', () => {
  // The rehearsal's own contract is 'a dry run cannot print a plan a real run would refuse'. It printed one anyway:
  // suite presence is a pure stat the run abandons on before writing anything, so a nonexistent --suite or
  // --suite-old rehearsed green, and --build - a step that can refuse after the mutant is on disk - was never
  // mentioned. Both halves are pinned here against the REAL run, so the plan cannot drift from the run silently.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-qf30-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    const subject = path.join(tmp, 'src', 'subject.js');
    const original = 'export const f = (n) => n + 1;\n';
    fs.writeFileSync(subject, original);
    fs.writeFileSync(path.join(tmp, 'green.mjs'), "import test from 'node:test';\ntest('green', () => {});\n");
    const base = ['--file', 'src/subject.js', '--from', 'n + 1', '--to', 'n + 2'];
    const run = (...args) => spawnSync(process.execPath, [tool, ...base, ...args], { cwd: tmp, encoding: 'utf8', timeout: 60000 });

    // (a) a missing --suite is refused at PLAN time, not rehearsed. Control: the identical command without --dry-run
    // refuses too, with the same clause - that equality is the contract, so both are read.
    const dryMissing = run('--suite', 'tests/does-not-exist.mjs', '--dry-run');
    assert.equal(dryMissing.status, 3, `a dry run over a missing suite must refuse, got ${dryMissing.status}: ${dryMissing.stdout}${dryMissing.stderr}`);
    assert.match(dryMissing.stderr, /the suite tests\/does-not-exist\.mjs does not exist/);
    assert.doesNotMatch(dryMissing.stdout, /dry run - nothing was written/, 'no plan may be printed for a command that cannot run');
    assert.doesNotMatch(dryMissing.stdout, /would mutate/, 'and it must not describe steps it would never reach');
    const realMissing = run('--suite', 'tests/does-not-exist.mjs');
    assert.equal(realMissing.status, 3, `control: the real run refuses the same command: ${realMissing.stdout}${realMissing.stderr}`);
    assert.match(realMissing.stderr, /the suite tests\/does-not-exist\.mjs does not exist/);

    // (b) the same for the BASELINE suite: a missing --suite-old refuses the rehearsal too.
    const dryMissingOld = run('--suite', 'green.mjs', '--suite-old', 'tests/missing-old.mjs', '--dry-run');
    assert.equal(dryMissingOld.status, 3, `a dry run over a missing --suite-old must refuse, got ${dryMissingOld.status}: ${dryMissingOld.stdout}${dryMissingOld.stderr}`);
    assert.match(dryMissingOld.stderr, /the suite tests\/missing-old\.mjs does not exist/);
    assert.doesNotMatch(dryMissingOld.stdout, /would then run green\.mjs/);

    // (c) --build is a step, and the plan states it. Control: the real run prints the build it performs, so the plan
    // line and the run line name the same command.
    const dryBuild = run('--suite', 'green.mjs', '--build', 'echo build-step', '--dry-run');
    assert.equal(dryBuild.status, 0, `a buildable plan still rehearses cleanly: ${dryBuild.stdout}${dryBuild.stderr}`);
    assert.match(dryBuild.stdout, /would then build: echo build-step/);
    const realBuild = run('--suite', 'green.mjs', '--build', 'echo build-step');
    assert.match(realBuild.stdout, /building: echo build-step/, 'control: the run really takes that step');

    // (d) and nothing above wrote anything: the rehearsal's other promise is untouched.
    assert.equal(fs.readFileSync(subject, 'utf8'), original, 'no dry run may touch the product file');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* --- the guards: a mutation that did not apply is an error, never a result ---- */

test('applyMutation replaces exactly one occurrence', () => {
  const result = applyMutation('const a = 1;\nconst b = 2;\n', 'const b = 2;', 'const b = 3;');
  assert.equal(result.ok, true);
  assert.match(result.content, /const b = 3;/);
  assert.match(result.content, /const a = 1;/, 'untouched text survives');
});

test('applyMutation refuses text that does not occur, so a stale mutation cannot be scored', () => {
  const result = applyMutation('const a = 1;\n', 'const z = 9;', 'const z = 0;');
  assert.equal(result.ok, false);
  assert.match(result.error, /does not occur/);
});

test('applyMutation refuses an ambiguous occurrence rather than picking one', () => {
  const result = applyMutation('go();\ngo();\n', 'go();', 'stop();');
  assert.equal(result.ok, false);
  assert.match(result.error, /occurs 2 times/);
});

test('applyMutation refuses a no-op', () => {
  assert.equal(applyMutation('x', 'x', 'x').ok, false);
  assert.equal(applyMutation('x', '', 'y').ok, false, 'an empty --from would match everywhere');
});

/* --- the compare-and-discard guard: the defect airhorn-f41e is about ---------- */

test('mutationApplied fails when the file on disk is unchanged', () => {
  const check = mutationApplied({ original: 'a', onDisk: 'a', to: 'b' });
  assert.equal(check.applied, false);
  assert.match(check.reason, /identical to the original/);
});

test('mutationApplied fails when the write landed but something rewrote it', () => {
  const check = mutationApplied({ original: 'a', onDisk: 'a FORMATTED', to: 'b' });
  assert.equal(check.applied, false);
  assert.match(check.reason, /does not contain the mutant text/);
});

test('mutationApplied accepts a landed deletion, where there is no mutant text to look for', () => {
  assert.equal(mutationApplied({ original: 'keep\ndrop\n', onDisk: 'keep\n' }).applied, true);
});

test('restoreVerified is a byte comparison, not a hopeful true', () => {
  assert.equal(restoreVerified({ original: 'a', onDisk: 'a' }), true);
  assert.equal(restoreVerified({ original: 'a', onDisk: 'a ' }), false);
});

/* --- the product/test target guard: the shape of two falsified sweeps --------- */

test('a test file is refused as a mutation target by default', () => {
  assert.match(mutationTargetProblem('tests/multitab.test.mjs'), /TEST file/);
  assert.match(mutationTargetProblem('./tests/x.mjs'), /TEST file/);
  assert.equal(mutationTargetProblem('src/badge.js'), null);
  assert.equal(mutationTargetProblem('tests/x.mjs', { allowTestMutation: true }), null);
});

/* --- the triad --------------------------------------------------------------- */

test('the verdict is a triad, and a missing measurement is not a pass', () => {
  assert.equal(verdictFor({ oldRc: 0, newRc: 1 }).verdict, 'hole-proven');
  assert.equal(verdictFor({ oldRc: 1, newRc: 1 }).verdict, 'not-reproducible');
  assert.equal(verdictFor({ oldRc: 0, newRc: 0 }).verdict, 'fix-does-not-close');
  assert.equal(verdictFor({ oldRc: null, newRc: 1 }).verdict, 'mutant-caught', 'without a baseline the tool still says the suite catches it');
  assert.equal(verdictFor({ oldRc: null, newRc: 1 }).exit, 0);
  assert.equal(verdictFor({ oldRc: 0, newRc: null }).verdict, 'unmeasured');
  assert.equal(verdictFor({ oldRc: 0, newRc: 1 }).exit, 0);
  assert.equal(verdictFor({ oldRc: 1, newRc: 1 }).exit, 1);
  assert.equal(verdictFor({ oldRc: 0, newRc: 0 }).exit, 2);
});

/* --- end to end: the file is always restored, and a non-applying mutation is refused
       before anything runs ------------------------------------------------------ */

function tempTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-check-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'subject.js'), 'export const answer = 41;\n');
  // A "suite" that FAILS while the mutant is in place (and passes on the original), so the
  // tool can be driven through a full run without a browser or a build. It is a SCRIPT suite
  // (no node:test, it exits non-zero), so the cases below declare --suite-mode script - the tool
  // refuses to guess that from source text (airhorn-u1v2).
  fs.writeFileSync(
    path.join(dir, 'suite.mjs'),
    "import fs from 'node:fs';\nconst body = fs.readFileSync(new URL('./src/subject.js', import.meta.url), 'utf8');\nprocess.exit(body.includes('42') ? 1 : 0);\n",
  );
  return dir;
}

test('a full run restores the file and reports that the suite catches the mutant', () => {
  const dir = tempTree();
  try {
    const before = fs.readFileSync(path.join(dir, 'src', 'subject.js'), 'utf8');
    const result = spawnSync(process.execPath, [
      tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'suite.mjs', '--suite-mode', 'script',
    ], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, 'the suite fails the mutant, so the check under test is live');
    assert.match(result.stdout, /verdict: mutant-caught/);
    assert.match(result.stdout, /--suite-old/);
    assert.match(result.stdout, /restored src\/subject\.js: verified/);
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'subject.js'), 'utf8'), before, 'the original is back, byte for byte');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the tool refuses a mutation that does not apply, and touches nothing', () => {
  const dir = tempTree();
  try {
    const before = fs.readFileSync(path.join(dir, 'src', 'subject.js'), 'utf8');
    const result = spawnSync(process.execPath, [
      tool, '--file', 'src/subject.js', '--from', 'nothing like this', '--to', '42', '--suite', 'suite.mjs',
    ], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /does not occur/);
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'subject.js'), 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the tool refuses to mutate a test file, because that proves nothing about the product', () => {
  const dir = tempTree();
  try {
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'tests', 'thing.test.mjs'), 'assert.equal(1, 1);\n');
    const result = spawnSync(process.execPath, [
      tool, '--file', 'tests/thing.test.mjs', '--from', '1, 1', '--to', '1, 2', '--suite', 'suite.mjs',
    ], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /TEST file/);
    assert.match(fs.readFileSync(path.join(dir, 'tests', 'thing.test.mjs'), 'utf8'), /1, 1/, 'the test file is untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// airhorn-cmr1: a suite that cannot run must never be scored as a suite that caught the
// mutant. node exits non-zero when it cannot find or parse the file, and the tool used to
// read that as "the suite fails the mutant" -> "mutant-caught" exit 0.
test('a suite that does not exist is refused as unmeasured, not scored as mutant-caught', () => {
  const problem = suitePresenceProblem('tests/does-not-exist.test.mjs', process.cwd());
  assert.match(problem, /does not exist/);
  assert.match(problem, /nothing was measured/);
  assert.equal(suitePresenceProblem('tests/mutation-check.test.js', process.cwd()), null,
    'a suite that is really there raises no presence problem');
});

test('a suite that cannot load is unmeasured - a loader error is not a caught mutant', () => {
  assert.match(suiteLoadProblem("Error: Cannot find module '/tmp/x/tests/missing.mjs'"), /could not run/);
  assert.match(suiteLoadProblem('node:internal/modules/esm/resolve:1 Error [ERR_MODULE_NOT_FOUND]'), /could not run/);
  assert.match(suiteLoadProblem('SyntaxError: Unexpected token'), /could not run/);
  // A REAL test failure has none of those markers and must stay a failure: that is the shape
  // the verdict reads as "the suite caught the mutant".
  assert.equal(suiteLoadProblem('not ok 1 - the horn blasts\n  AssertionError [ERR_ASSERTION]'), null);
  assert.equal(suiteLoadProblem(''), null);
});

test('the verdict is unreachable for an unmeasured suite: only a real failure becomes mutant-caught', () => {
  // The triad is unchanged; what changed is which inputs reach it. null (not measured) can
  // never produce a pass.
  assert.equal(verdictFor({ oldRc: null, newRc: null }).verdict, 'unmeasured');
  assert.equal(verdictFor({ oldRc: null, newRc: null }).exit, 3);
  assert.equal(verdictFor({ oldRc: null, newRc: 1 }).verdict, 'mutant-caught');
});

// airhorn-u1v2: the classification must come from what EXECUTED, never from source text. The
// previous attempt scanned the file for `node:test`, and a reviewer defeated it twice: an
// indirect import escaped it, and adding the comment `// from "node:test"` to a script flipped a
// real assertion failure into "nothing was measured". These cases pin the mode, not the text.
test('classifyRun decides from execution evidence only: the driver record and the runner counts', () => {
  const loaded = { importFailed: false, suite: '/x/suite.mjs' };
  const threw = { importFailed: true, reason: 'boom' };
  const caught = { driver: loaded, realTests: 3, realPassed: 2, realFailed: 1, failing: ['answer'] };
  const passed = { driver: loaded, realTests: 3, realPassed: 3, realFailed: 0, failing: [] };

  assert.deepEqual(classifyRun({ report: caught, exitCode: 1 }), { mode: 'caught', rc: 1, failing: ['answer'] });
  assert.deepEqual(classifyRun({ report: passed, exitCode: 0 }), { mode: 'passed', rc: 0 });
  // the one case a comment cannot fake: the import threw
  for (const report of [{ driver: threw, realTests: 0, realFailed: 0 }, { driver: threw, realTests: 4, realFailed: 1 }]) {
    const never = classifyRun({ report, exitCode: 1 });
    assert.equal(never.mode, 'never-ran', 'a suite that threw while loading never ran, whatever events were seen');
    assert.match(never.problem, /threw while loading/);
  }
  assert.equal(classifyRun({ report: null, exitCode: 7 }).mode, 'never-ran');
  assert.match(classifyRun({ report: null, exitCode: 7 }).problem, /no record/);
  // no driver record at all is not a measurement either
  assert.equal(classifyRun({ report: { realTests: 2, realFailed: 1 }, exitCode: 1 }).mode, 'never-ran');

  // airhorn-so88: a failure AFTER a clean import is not a test failing - no test ran
  const crashed = classifyRun({ report: { driver: { importFailed: false, crashedOutsideTest: true, reason: 'uncaught exception after the suite loaded: Error: async boom' }, realTests: 1, realFailed: 1 }, exitCode: 0 });
  assert.equal(crashed.mode, 'threw-outside-a-test', 'a crash outside any test is its own named state, never a caught mutant');
  assert.match(crashed.problem, /after the suite loaded/);
  // counts missing entirely is also not a measurement
  assert.equal(classifyRun({ report: { driver: { importFailed: false } }, exitCode: 0 }).mode, 'never-ran');

  // airhorn-a6ch: the driver's own file-level event is separated by data.file (the driver path),
  // so a suite that strips the driver's handlers and then crashes cannot be scored as a caught
  // mutant; and a run that exits non-zero with no failing test measured nothing.
  const stripped = classifyRun({ report: { driver: { importFailed: false }, realTests: 1, realPassed: 1, realFailed: 0, wrapperEvents: 1, fileLevelFailed: true }, exitCode: 1 });
  assert.equal(stripped.mode, 'threw-outside-a-test', 'a run that died outside its tests is a named state, never a caught mutant');
  assert.match(stripped.problem, /exited 1 with no failing test/);
  const noTests = classifyRun({ report: { driver: { importFailed: false }, realTests: 0, realFailed: 0, wrapperEvents: 1, fileLevelFailed: true }, exitCode: 1 });
  assert.equal(noTests.mode, 'never-ran');
  assert.match(noTests.problem, /registered no tests/);

  // a declared script suite is judged by its exit code: its top-level throw IS the failure
  assert.deepEqual(classifyRun({ report: null, exitCode: 1, suiteMode: 'script' }), { mode: 'caught', rc: 1 });
  assert.deepEqual(classifyRun({ report: null, exitCode: 0, suiteMode: 'script' }), { mode: 'passed', rc: 0 });
});

test('the five worlds, actually run: caught, direct-throw, indirect-throw, decoy comment, passing, script', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u1v2-'));
  const write = (name, body) => fs.writeFileSync(path.join(tmp, name), body);
  const runWorld = (args) => spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', ...args], { cwd: tmp, encoding: 'utf8' });
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    write('src/subject.js', 'export const answer = 41;\n');
    write('setup.mjs', "throw new Error('boom');\n");
    write('indirect.mjs', "import './setup.mjs';\n");
    write('a-catches.mjs', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { answer } from './src/subject.js';\ntest('answer', () => assert.equal(answer, 41));\n");
    write('b-direct.mjs', "import './setup.mjs';\nimport test from 'node:test';\ntest('x', () => {});\n");
    write('b-indirect.mjs', "import './indirect.mjs';\nimport test from 'node:test';\ntest('x', () => {});\n");
    // the reviewer's INDIRECT shape: the suite file never mentions node:test, a helper registers
    write('register.mjs', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { answer } from './src/subject.js';\ntest('answer', () => assert.equal(answer, 41));\n");
    write('b-indirect-registration.mjs', "import './register.mjs';\nimport './setup.mjs';\n");
    write('c-decoy.mjs', "// from \"node:test\" - a DECOY comment: it must not change the classification\nimport './indirect.mjs';\nimport test from 'node:test';\ntest('x', () => {});\n");
    write('d-passes.mjs', "import test from 'node:test';\ntest('green', () => {});\n");
    // airhorn-so88 worlds: async failure after the import registers a test that never runs,
    // plus the decoy comment and the INDIRECT-registration variant
    write('h-async-no-test.mjs', "import test from 'node:test';\nsetTimeout(() => { throw new Error('async boom'); }, 5);\ntest('never runs', () => {});\n");
    write('i-async-decoy.mjs', "// from \"node:test\" - decoy\nimport test from 'node:test';\nsetTimeout(() => { throw new Error('async boom'); }, 5);\ntest('never runs', () => {});\n");
    write('j-indirect-async.mjs', "import './register.mjs';\nsetTimeout(() => { throw new Error('async boom'); }, 5);\n");
    // airhorn-gwcm: the report channel is checked before any verdict, because the suite is handed
    // the fd and can write to it. Every forgery has to land on a NAMED refusal, never a verdict.
    const nonce = 'run-nonce';
    assert.match(readChannel('', nonce).problem, /no report/);
    assert.match(readChannel('not json\n', nonce).problem, /malformed/);
    assert.match(readChannel(JSON.stringify({ kind: 'final', nonce: 'other', realTests: 1 }) + '\n', nonce).problem, /nonce/);
    const twoFinals = [JSON.stringify({ kind: 'final', nonce, realTests: 0 }), JSON.stringify({ kind: 'final', nonce, realTests: 1, realFailed: 1 })].join('\n');
    assert.match(readChannel(twoFinals, nonce).problem, /final records/);
    assert.match(readChannel(JSON.stringify({ kind: 'mystery', nonce }) + '\n', nonce).problem, /unknown record kind/);
    // the honest single record still reads
    const honest = readChannel(JSON.stringify({ kind: 'final', nonce, driver: { importFailed: false }, startedTests: 1, realTests: 1, realFailed: 1, failing: ['x'] }) + '\n', nonce);
    assert.equal(honest.problem, null);
    assert.equal(honest.records.realFailed, 1);

    // and the same forgeries END TO END: a suite that writes a forged record to the channel,
    // forges the driver record and spawns a detached sibling to keep rewriting it must NOT be
    // scored as a caught mutant (it is a green suite that measured nothing).
    write('k-forge-channel.mjs', [
      "import test from 'node:test';",
      "import fs from 'node:fs';",
      "import { spawn } from 'node:child_process';",
      "test('green', () => {});",
      "const p = process.env.MUTATION_DRIVER_REPORT;",
      "const forged = JSON.stringify({ nonce: process.env.MUTATION_RUN_NONCE, importFailed: false, crashedOutsideTest: false });",
      "if (p) {",
      "  try { fs.writeFileSync(p, forged); } catch {}",
      // BOUNDED on purpose: a detached sibling that writes forever outlived the fixture and the
      // reaper had to kill one process per run, 120 minutes later. It only has to prove it cannot
      // win against the pipe, so it stops itself after ~2s.
      "  const child = spawn(process.execPath, ['-e', `const fs=require('node:fs');const t=setInterval(()=>{try{fs.writeFileSync(${JSON.stringify(p)},${JSON.stringify(forged)})}catch{}},2);setTimeout(()=>{clearInterval(t);process.exit(0);},2000)`], { detached: true, stdio: 'ignore' });",
      "  child.unref();",
      "}",
      "try { fs.writeSync(3, JSON.stringify({ kind: 'final', nonce: process.env.MUTATION_RUN_NONCE, realTests: 1, realFailed: 1 }) + '\\n'); } catch {}",
      "",
    ].join('\n'));
    const forged = runWorld(['--suite', 'k-forge-channel.mjs']);
    assert.notEqual(forged.status, 0, `a green suite that forges the channel must never be scored caught: ${forged.stdout}${forged.stderr}`);
    assert.doesNotMatch(forged.stdout, /verdict: mutant-caught/, 'forging the channel must not produce the dangerous false green');

    // a run that dies before the reporter's final record is a named refusal, not "unmeasured"
    write('l-no-report.mjs', "import test from 'node:test';\ntest('green', () => {});\nprocess.exit(0);\n");
    const noReport = runWorld(['--suite', 'l-no-report.mjs']);
    assert.equal(noReport.status, 3, `a missing final record must be refused by name: ${noReport.stdout}${noReport.stderr}`);

    // airhorn-a6ch: invoked through a SYMLINK, the tool must still do its job. It used to exit 0
    // having printed nothing at all, because main-detection compared the symlinked argv[1] to the
    // module's real path - a silent pass, the worst possible answer for a gate.
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-link-'));
    const link = path.join(linkDir, 'mutation-check.mjs');
    fs.symlinkSync(tool, link);
    const viaLink = spawnSync(process.execPath, [link, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'a-catches.mjs'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(viaLink.status, 0, 'a symlinked invocation must return the same exit code as the real path');
    assert.match(viaLink.stdout + viaLink.stderr, /verdict: mutant-caught/, 'the symlinked invocation must reach the same verdict as the real path');

    // airhorn-a6ch: the suite strips the driver's crash handlers, then crashes asynchronously -
    // the wrapper event must be attributed to the DRIVER, not counted as a failing test.
    write('g-strip-handlers.mjs', "import test from 'node:test';\ntest('one', () => {});\nprocess.removeAllListeners('uncaughtException');\nprocess.removeAllListeners('unhandledRejection');\nsetImmediate(() => { throw new Error('strip boom'); });\n");
    // airhorn-rnj5 / airhorn-5qdd: three listener-order evasions. All three work the same way - a swallow runs BEFORE the
    // driver's handler and exits 0, so nothing is removed (the strip watcher is silent), no CRASH line is written by the
    // driver's listener, and from outside the run looks like a suite that simply passed. The fix is PRECEDENCE, not
    // position: node emits 'uncaughtExceptionMonitor' before every listener and before a capture callback, so the driver
    // records the crash first and the swallow never gets to run. prependOnceListener and a self-removing listener are the
    // two shapes that an exit-time position check cannot see, which is why that check was removed rather than patched.
    write('k-prepend-swallow.mjs', "import test from 'node:test';\ntest('one', () => {});\nsetTimeout(() => { process.prependListener('uncaughtException', () => process.exit(0)); throw new Error('looks like a pass'); }, 5);\n");
    write('k-prepend-once-swallow.mjs', "import test from 'node:test';\ntest('one', () => {});\nsetTimeout(() => { process.prependOnceListener('uncaughtException', () => process.exit(0)); throw new Error('once swallow'); }, 5);\n");
    write('k-self-removing-swallow.mjs', "import test from 'node:test';\ntest('one', () => {});\nsetTimeout(() => { const swallow = () => { process.removeListener('uncaughtException', swallow); process.exit(0); }; process.prependListener('uncaughtException', swallow); throw new Error('self-removing swallow'); }, 5);\n");
    // airhorn-so88: an async throw AFTER a clean import (the reviewer's repro shape)
    write('f-async-crash.mjs', "import test from 'node:test';\ntest('one', () => {});\nsetImmediate(() => { throw new Error('async boot failure'); });\n");
    // airhorn-lnme: node names the file-level event with the path AS PASSED, so a
    // directory-qualified suite path used to read as a failed test. Same worlds, one level down.
    fs.mkdirSync(path.join(tmp, 'sub'));
    write('sub/setup-throw.mjs', "import '../setup.mjs';\nimport test from 'node:test';\ntest('x', () => {});\n");
    write('sub/catches.mjs', "import test from 'node:test';\nimport assert from 'node:assert';\nimport { answer } from '../src/subject.js';\ntest('answer', () => assert.equal(answer, 41));\n");
    write('sub/passes.mjs', "import test from 'node:test';\ntest('green', () => {});\n");
    write('e-script.mjs', "import assert from 'node:assert';\nimport { answer } from './src/subject.js';\nassert.equal(answer, 41);\n// from \"node:test\" - the same decoy, in a script\n");

    const a = runWorld(['--suite', 'a-catches.mjs']);
    assert.equal(a.status, 0, `a real assertion failure inside a test must be caught: ${a.stdout}${a.stderr}`);
    assert.match(a.stdout, /verdict: mutant-caught/);

    for (const world of ['b-direct.mjs', 'b-indirect.mjs', 'b-indirect-registration.mjs', 'c-decoy.mjs']) {
      const r = runWorld(['--suite', world]);
      assert.equal(r.status, 3, `${world} must be never-ran (exit 3), got ${r.status}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr + r.stdout, /threw while loading/, `${world} must name the mode`);
    }
    // the decoy changes NOTHING: identical classification to the indirect crash without it
    const plain = runWorld(['--suite', 'b-indirect.mjs']);
    const decoy = runWorld(['--suite', 'c-decoy.mjs']);
    assert.equal(decoy.status, plain.status, 'a comment must not move the classification');

    const d = runWorld(['--suite', 'd-passes.mjs']);
    assert.equal(d.status, 2, `a passing suite must be fix-does-not-close, not unmeasured: ${d.stdout}${d.stderr}`);
    assert.match(d.stdout, /verdict: fix-does-not-close/);

    const stripped = runWorld(['--suite', 'g-strip-handlers.mjs']);
    assert.equal(stripped.status, 3, `a suite that strips the handlers then crashes must be refused, got ${stripped.status}: ${stripped.stdout}${stripped.stderr}`);
    // airhorn-5wns: the sentinel (tools/lib/suite-guard.mjs) lives in the suite's process now, so a
    // removeAllListeners of its rejection sentinel is a strip it REFUSES - the run dies non-clean and
    // is named from outside as a suite that never finished loading cleanly.
    assert.match(stripped.stderr + stripped.stdout, /threw while loading|registered no tests|crashed/i);

    // airhorn-5wns (re-targeting airhorn-5qdd onto the supervisor design): the suite process is not
    // unwatched after all. The supervisor loads a sentinel (tools/lib/suite-guard.mjs) into the
    // suite's own process via --import, which node --test propagates to the per-file process
    // (measured). The sentinel owns FIRST position on the rejection channel and the
    // uncaughtExceptionMonitor, so all three shapes below - which the pre-14ht driver closed and
    // which 14ht had to re-declare as an rc 2 KNOWN-LIMIT - are refused again, by death: a swallow
    // registered AHEAD of the sentinel is sampled one nextTick later (before any microtask can
    // deliver the rejection), and an uncaught exception fires the monitor before any swallow can
    // exit 0. Nothing written from the suite's process is a fact the parent can trust, so the
    // sentinel's only unforgeable statement is a non-clean death, which the parent classifies as a
    // refusal (rc 3), never a verdict.
    write('k-prepend-rejection-swallow.mjs', "import test from 'node:test';\ntest('one', () => {});\nsetTimeout(() => { process.prependListener('unhandledRejection', () => process.exit(0)); Promise.reject(new Error('swallowed rejection')); }, 5);\n");

    for (const world of ['k-prepend-swallow.mjs', 'k-prepend-once-swallow.mjs', 'k-self-removing-swallow.mjs']) {
      const laundered = runWorld(['--suite', world]);
      assert.equal(laundered.status, 3, `${world} must be a named refusal (the sentinel refuses an uncaught exception), got ${laundered.status}: ${laundered.stdout}${laundered.stderr}`);
      assert.match(laundered.stderr + laundered.stdout, /threw-outside-a-test/,
        `${world}: the refusal must name the crash it now catches again (airhorn-5wns)`);
    }

    // airhorn-39yh, the two shapes this change closes: (a) patch the record channel so the crash line is never written, and
    // (b) strip the driver's EXIT listeners so the rejection position check never runs. Both scored rc 2 before.
    write('k-patch-channel-swallow.mjs', "import test from 'node:test';\nimport fs from 'node:fs';\ntest('one', () => {});\nsetTimeout(() => { const real = fs.writeSync; fs.writeSync = (...args) => (String(args[1]).includes('crashedOutsideTest') ? 0 : real.apply(fs, args)); process.prependListener('uncaughtException', () => process.exit(0)); throw new Error('swallowed after patching the channel'); }, 5);\n");
    write('k-strip-exit-swallow.mjs', "import test from 'node:test';\ntest('one', () => {});\nsetTimeout(() => { for (const fn of process.listeners('exit')) process.removeListener('exit', fn); process.prependListener('unhandledRejection', () => process.exit(0)); Promise.reject(new Error('swallowed after stripping exit listeners')); }, 5);\n");

    // airhorn-5wns: patching fs.writeSync and stripping 'exit' listeners reach nothing of the
    // supervisor's, but that no longer leaves these worlds unwatched - each of them still registers a
    // swallow the sentinel sees (an uncaught exception for the patch world, a PREPENDED rejection
    // listener for the other two), and the sentinel refuses by death regardless of what else the suite
    // patched, because its references were captured at preload before any suite code ran.
    for (const world of ['k-patch-channel-swallow.mjs', 'k-strip-exit-swallow.mjs', 'k-prepend-rejection-swallow.mjs']) {
      const closed = runWorld(['--suite', world]);
      assert.equal(closed.status, 3, `${world} must be refused by the sentinel, got ${closed.status}: ${closed.stdout}${closed.stderr}`);
      assert.doesNotMatch(closed.stdout, /verdict: mutant-caught/, `${world}: a refusal, never a catch`);
    }

    // airhorn-5qdd, the shapes an exit-time position check cannot see, re-targeted: a prepended `once`
    // is unwrapped before it fires and a self-removing listener removes itself, so neither survives to
    // exit - but both were AHEAD of the sentinel at registration, and the sampler (captured nextTick,
    // which drains before promise microtasks) sees that before a rejection registered in the same
    // synchronous block can be delivered. A microtask-registered variant is pinned too: nextTick still
    // drains first, so the sample runs before the rejection is delivered whichever queue registered it.
    write('k-prepend-once-rejection-swallow.mjs', "import test from 'node:test';\ntest('one', () => {});\nsetTimeout(() => { process.prependOnceListener('unhandledRejection', () => process.exit(0)); Promise.reject(new Error('once-swallowed rejection')); }, 5);\n");
    write('k-self-removing-rejection-swallow.mjs', "import test from 'node:test';\ntest('one', () => {});\nsetTimeout(() => { const swallow = () => { process.removeListener('unhandledRejection', swallow); process.exit(0); }; process.prependListener('unhandledRejection', swallow); Promise.reject(new Error('self-removed rejection')); }, 5);\n");
    write('k-microtask-once-rejection-swallow.mjs', "import test from 'node:test';\ntest('one', () => {});\nPromise.resolve().then(() => { process.prependOnceListener('unhandledRejection', () => process.exit(0)); Promise.reject(new Error('microtask-swallowed rejection')); });\n");
    for (const world of ['k-prepend-once-rejection-swallow.mjs', 'k-self-removing-rejection-swallow.mjs', 'k-microtask-once-rejection-swallow.mjs']) {
      const ephemeral = runWorld(['--suite', world]);
      assert.equal(ephemeral.status, 3, `${world} must be a named refusal (the sampler sees the ahead-registration), got ${ephemeral.status}: ${ephemeral.stdout}${ephemeral.stderr}`);
      assert.doesNotMatch(ephemeral.stdout, /verdict: mutant-caught/, `${world}: a refusal, never a catch`);
    }

    // airhorn-gb9y: the sampling watcher itself is an instrument - removing it deletes the check, so
    // the strip is refused like every other instrument strip.
    write('k-strip-sampling-watcher.mjs', "import test from 'node:test';\ntest('one', () => {});\nsetTimeout(() => { for (const l of process.listeners('newListener')) process.removeListener('newListener', l); process.prependOnceListener('unhandledRejection', () => process.exit(0)); Promise.reject(new Error('swallowed after stripping the sampler')); }, 5);\n");
    const watcherStrip = runWorld(['--suite', 'k-strip-sampling-watcher.mjs']);
    assert.equal(watcherStrip.status, 3, `stripping the sampling watcher must be refused (airhorn-gb9y), got ${watcherStrip.status}: ${watcherStrip.stdout}${watcherStrip.stderr}`);

    // airhorn-lg5d: a listener APPENDED at IMPORT time - the one shape 5wns' two watches could not see.
    // It is behind the sentinel, so the precedence sampler is right to say nothing; it removes nothing,
    // so the strip watcher says nothing. But it is registered before node:test's harness listener, which
    // registers lazily at run start, so `process.exit(0)` there ends the suite process before anything
    // can judge the rejection and the parent sees a CLEAN run. Measured on master 8e3c3d3b: rc 2 (a
    // verdict, "fix-does-not-close") in 5 of 5 runs, where the same suite without the swallow refuses
    // rc 3. The sentinel now refuses a clean exit after a rejection reached it; the refusal is deferred
    // to 'exit' on purpose, because a rejection the harness attributes to a test is a failed TEST rather
    // than a refusal (airhorn-812k), and the 'exit' listener is named in the strip set like every other
    // instrument. Both registration positions are pinned: before the first test(), and after it.
    write('k-import-append-exit-swallow.mjs', "import test from 'node:test';\nprocess.on('unhandledRejection', () => process.exit(0));\ntest('one', () => {});\nsetTimeout(() => { Promise.reject(new Error('import-time swallow hid the crash')); }, 5);\n");
    write('k-import-append-exit-swallow-late.mjs', "import test from 'node:test';\ntest('one', () => {});\nprocess.on('unhandledRejection', () => process.exit(0));\nsetTimeout(() => { Promise.reject(new Error('import-time swallow hid the crash')); }, 5);\n");
    for (const world of ['k-import-append-exit-swallow.mjs', 'k-import-append-exit-swallow-late.mjs']) {
      const imported = runWorld(['--suite', world]);
      assert.equal(imported.status, 3,
        `${world} must be a named refusal (a clean exit after a delivered rejection IS the manipulation), ` +
        `got ${imported.status}: ${imported.stdout}${imported.stderr}`);
      assert.match(imported.stderr + imported.stdout, /threw-outside-a-test/,
        `${world}: the refusal must name the crash it caught (airhorn-lg5d)`);
      assert.doesNotMatch(imported.stdout, /verdict:/, `${world}: a refusal, never a verdict`);
    }
    // The exit check is an instrument too: an APPENDED swallow plus a strip of the 'exit' listeners now
    // has nothing left to refuse it except the strip itself, so the strip must refuse (airhorn-gb9y's
    // rule applied to the new instrument, airhorn-lg5d).
    write('k-strip-exit-check-swallow.mjs', "import test from 'node:test';\ntest('one', () => {});\nsetTimeout(() => { for (const fn of process.listeners('exit')) process.removeListener('exit', fn); process.on('unhandledRejection', () => process.exit(0)); Promise.reject(new Error('stripped the exit check')); }, 5);\n");
    const exitCheckStrip = runWorld(['--suite', 'k-strip-exit-check-swallow.mjs']);
    assert.equal(exitCheckStrip.status, 3,
      `stripping the exit check must be refused like every other instrument strip (airhorn-lg5d), got ${exitCheckStrip.status}: ${exitCheckStrip.stdout}${exitCheckStrip.stderr}`);

    // airhorn-jzrs: process.exit(code) EMITS 'exit' (that is what the check above stands on), but
    // process.reallyExit(code) does not - so the same appended import-time swallow calling
    // reallyExit(0) laundered the crash as a verdict again (measured rc 2 at 4e366206 and on master
    // 8e3c3d3b). The preload captures reallyExit and republishes it as a NON-CONFIGURABLE accessor:
    // the getter is a wrapper that applies the same check, the setter refuses. A suite can therefore
    // not replace it, recover the original, or delete it - and a clean reallyExit after a delivered
    // rejection is the refusal.
    write('k-really-exit-swallow.mjs', "import test from 'node:test';\nprocess.on('unhandledRejection', () => process.reallyExit(0));\ntest('one', () => {});\nsetTimeout(() => { Promise.reject(new Error('reallyExit swallow')); }, 5);\n");
    const reallyExitSwallow = runWorld(['--suite', 'k-really-exit-swallow.mjs']);
    assert.equal(reallyExitSwallow.status, 3,
      `a reallyExit(0) swallow must be refused like the exit(0) one (airhorn-jzrs), got ${reallyExitSwallow.status}: ${reallyExitSwallow.stdout}${reallyExitSwallow.stderr}`);
    assert.match(reallyExitSwallow.stderr + reallyExitSwallow.stdout, /threw-outside-a-test/,
      'the reallyExit shape must name the crash it caught (airhorn-jzrs)');
    // ...and the exit path cannot be taken back from the suite: replacing the captured reallyExit
    // refuses, and a delete-then-call still reaches the wrapper (the property is non-configurable).
    write('k-really-exit-replace.mjs', "import test from 'node:test';\ntest('one', () => {});\nprocess.reallyExit = () => {};\nprocess.on('unhandledRejection', () => process.reallyExit(0));\nsetTimeout(() => { Promise.reject(new Error('replace reallyExit')); }, 5);\n");
    write('k-really-exit-delete.mjs', "import test from 'node:test';\ntest('one', () => {});\ntry { delete process.reallyExit; } catch {}\nprocess.on('unhandledRejection', () => { try { process.reallyExit(0); } catch { process.exit(0); } });\nsetTimeout(() => { Promise.reject(new Error('delete reallyExit')); }, 5);\n");
    for (const world of ['k-really-exit-replace.mjs', 'k-really-exit-delete.mjs']) {
      const tamper = runWorld(['--suite', world]);
      assert.equal(tamper.status, 3,
        `${world} must be refused (the exit path cannot be taken back, airhorn-jzrs), got ${tamper.status}: ${tamper.stdout}${tamper.stderr}`);
      assert.doesNotMatch(tamper.stdout, /verdict:/, `${world}: a refusal, never a verdict`);
    }

    // Honest churn must stay unrefused: node:test's own harness listener registers by APPEND (never
    // ahead of the preload sentinel), and a suite listener appended behind the sentinel never runs
    // ahead of it - so adding and removing one hides nothing and is not manipulation.
    write('k-honest-rejection-churn.mjs', "import test from 'node:test';\ntest('one', () => {});\nconst logger = () => {};\nprocess.on('unhandledRejection', logger);\nprocess.removeListener('unhandledRejection', logger);\n");
    const honestChurn = runWorld(['--suite', 'k-honest-rejection-churn.mjs']);
    assert.equal(honestChurn.status, 2, `honest appended churn must stay fix-does-not-close, got ${honestChurn.status}: ${honestChurn.stdout}${honestChurn.stderr}`);
    assert.doesNotMatch(honestChurn.stderr + honestChurn.stdout, /refusing/, 'honest appended rejection churn must not be refused');

    // j-indirect-async CHANGED MEANING under airhorn-14ht and the change is the right way round: that
    // world registers a REAL test ('answer') that asserts about the mutant, so the mutant is genuinely
    // caught, and its async throw is invisible from outside because node does not report a file-level
    // failure when a test already failed. The old design disqualified the whole run for the throw, which
    // was conservative but not evidence about the mutant. What must NOT change is the crash-without-an-
    // assertion direction above (h/i): those still refuse.
    for (const world of ['h-async-no-test.mjs', 'i-async-decoy.mjs']) {
      const r = runWorld(['--suite', world]);
      assert.equal(r.status, 3, `${world} must be a named refusal, got ${r.status}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr + r.stdout, /\[(never-ran|threw-outside-a-test)\]/, `${world} must NAME its state`);
      assert.doesNotMatch(r.stdout, /verdict: mutant-caught/, `${world} must never be scored as caught`);
    }
    // the decoy must not change the state
    const plainAsync = runWorld(['--suite', 'h-async-no-test.mjs']);
    const decoyAsync = runWorld(['--suite', 'i-async-decoy.mjs']);
    assert.equal(decoyAsync.status, plainAsync.status, 'a comment must not move the state');

    const asyncCrash = runWorld(['--suite', 'f-async-crash.mjs']);
    assert.equal(asyncCrash.status, 3, `an async crash after the import must be never-ran, got ${asyncCrash.status}: ${asyncCrash.stdout}${asyncCrash.stderr}`);
    // The WORDING moved with the design: the crash is now observed from outside the suite's process
    // ("the suite run failed outside its tests ... so NO test asserted anything"), because there is no
    // in-process handler left to name the moment it happened. The state and the refusal are unchanged.
    assert.match(asyncCrash.stderr + asyncCrash.stdout, /failed outside its tests|NO test asserted anything/);

    // directory-qualified paths (the tool's own documented usage) must classify identically
    const subCrash = runWorld(['--suite', 'sub/setup-throw.mjs']);
    assert.equal(subCrash.status, 3, `sub/setup-throw.mjs must be never-ran, got ${subCrash.status}: ${subCrash.stdout}${subCrash.stderr}`);
    assert.match(subCrash.stderr + subCrash.stdout, /threw while loading/);
    const subCatches = runWorld(['--suite', 'sub/catches.mjs']);
    assert.equal(subCatches.status, 0, `sub/catches.mjs must still be caught: ${subCatches.stdout}${subCatches.stderr}`);
    assert.match(subCatches.stdout, /verdict: mutant-caught/);
    const subPasses = runWorld(['--suite', 'sub/passes.mjs']);
    assert.equal(subPasses.status, 2, `sub/passes.mjs must be fix-does-not-close: ${subPasses.stdout}${subPasses.stderr}`);

    // a script suite is out of scope unless declared, and then the SAME decoy comment is inert
    const eDefault = runWorld(['--suite', 'e-script.mjs']);
    assert.equal(eDefault.status, 3, 'a script suite must be refused by default and say how to declare it');
    assert.match(eDefault.stderr + eDefault.stdout, /--suite-mode script/);
    const eScript = runWorld(['--suite', 'e-script.mjs', '--suite-mode', 'script']);
    assert.equal(eScript.status, 0, `with --suite-mode script the assertion failure is caught: ${eScript.stdout}${eScript.stderr}`);
    assert.match(eScript.stdout, /verdict: mutant-caught/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/* --- airhorn-4h8l: containment is the PID namespace, and it is measured -------- */

test('containment prefix exists on this host and propagates the inner exit code', async () => {
  const { containmentPrefix, containmentGuaranteeLine } = await import('../tools/mutation-check.mjs');
  const prefix = containmentPrefix();
  if (prefix.length === 0) {
    // The tool then runs uncontained AND SAYS SO - the guarantee line is the contract.
    assert.match(containmentGuaranteeLine(), /containment: NONE.*SURVIVES/);
    return;
  }
  assert.match(containmentGuaranteeLine(), /PID namespace/);
  const rc7 = spawnSync(prefix[0], [...prefix.slice(1), process.execPath, '-e', 'process.exit(7)'], { encoding: 'utf8' });
  assert.equal(rc7.status, 7, 'the wrapper must propagate the run\'s own exit code or verdicts lie');
});

test('an env-scrubbed, detached, setsid descendant does NOT survive a contained run (airhorn-4h8l)', async () => {
  const { containmentPrefix, containmentGuaranteeLine } = await import('../tools/mutation-check.mjs');
  // The test probes the HOST ITSELF, not the tool: whether this host can contain is an
  // independent fact, so a change that quietly drops the prefix cannot skip the assertion.
  const hostCanContain = spawnSync('unshare', ['-r', '-fp', '--kill-child', 'true'], { encoding: 'utf8' }).status === 0;

  // SELF-CHECK, always run: uncontained, the reviewer's adversary DOES survive and writes
  // its marker - so a green result later is containment, not a test that cannot tell.
  const marker1 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-escape-u-')), 'marker');
  const adversary = (marker) => `require('node:child_process').spawn('setsid', ['env', '-i', 'sh', '-c', 'sleep 0.3; touch ${marker}; sleep 30'],
    { detached: true, stdio: 'ignore' }).unref();`;
  spawnSync(process.execPath, ['-e', adversary(marker1)], { encoding: 'utf8', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(fs.existsSync(marker1), true,
    'the adversary did not survive even UNCONTAINED - this test cannot tell containment from nothing');

  if (!hostCanContain) {
    assert.equal(containmentPrefix().length, 0, 'the host cannot contain but the tool claims a containment prefix');
    assert.match(containmentGuaranteeLine(), /containment: NONE.*SURVIVES/);
    return;
  }
  const prefix = containmentPrefix();
  assert.notEqual(prefix.length, 0, 'this host can contain (unshare probe passed) but the tool runs suite runs uncontained');
  const marker2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-escape-c-')), 'marker');
  // The leader (the 'run') spawns the adversary and EXITS - containment means every descendant
  // dies WITH the run, so the marker scheduled 300 ms after the leader's death must never appear.
  spawnSync(prefix[0], [...prefix.slice(1), process.execPath, '-e', adversary(marker2)], { encoding: 'utf8', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(fs.existsSync(marker2), false,
    'an env-scrubbed detached descendant survived the contained run and wrote its marker - containment is not working');
});

/* --- airhorn-y3d6: the driver record cannot be quietly rewritten --------------- */

test('classifyRun refuses a driver record whose nonce is not this run\'s (airhorn-y3d6)', () => {
  const judged = classifyRun({
    report: { driver: { nonceMismatch: true }, startedTests: 3, realTests: 3, realPassed: 3, realFailed: 0, fileLevelFailed: 0, wrapperEvents: 0 },
    exitCode: 0,
  });
  assert.equal(judged.mode, 'report-not-trustworthy');
  assert.match(judged.problem, /forged or broken/);
});

test('classifyRun refuses a tampered driver record by name (airhorn-y3d6 round 2)', () => {
  const judged = classifyRun({
    report: { driver: { tampered: true, lines: 2 }, startedTests: 3, realTests: 3, realPassed: 3, realFailed: 0, fileLevelFailed: 0, wrapperEvents: 0 },
    exitCode: 0,
  });
  assert.equal(judged.mode, 'report-not-trustworthy');
  assert.match(judged.problem, /forged or broken/);
});

test('classifyRun words a genuine crash-handler strip as SUPPRESSION, not forgery (airhorn-co4h)', () => {
  // The strip watcher writes a handlersStripped line at strip time, and the reporter now names that
  // shape ([IMPORT, STRIP] / [IMPORT, STRIP, STRIP]) instead of letting it fall into the tampered
  // fallback. Before this, a suite that removed the driver's crash handlers was reported to the
  // operator as a suspected FORGERY, which is the wrong cause and the wrong suspicion.
  const judged = classifyRun({
    report: {
      driver: {
        importFailed: false,
        handlersStripped: true,
        strippedLines: 1,
        strippedReason: "the suite removed the driver's crash handlers - a crash outside any test would now be invisible (suppression, not a measurement)",
      },
      startedTests: 1, realTests: 1, realPassed: 1, realFailed: 0, fileLevelFailed: true, wrapperEvents: 1, unattributed: 0,
    },
    exitCode: 1,
  });
  assert.equal(judged.mode, 'report-not-trustworthy', 'a strip is still a refusal, never a verdict');
  assert.notEqual(judged.rc, 0);
  assert.match(judged.problem, /removed the driver's crash handlers/);
  assert.match(judged.problem, /invisible/);
  assert.doesNotMatch(judged.problem, /forged or broken/, 'the honest cause is suppression, not a suspected forgery');

  // A strip carried by a sequence that is ALSO invalid says both things rather than dropping the strip.
  const mixed = classifyRun({ report: { driver: { tampered: true, lines: 3, handlersStripped: true, strippedReason: null } }, exitCode: 1 });
  assert.equal(mixed.mode, 'report-not-trustworthy');
  assert.match(mixed.problem, /crash handlers/);
  assert.match(mixed.problem, /did not fit the grammar/);

  // The control: an unknown sequence with NO strip line keeps the forgery wording.
  const forged = classifyRun({ report: { driver: { tampered: true, lines: 2, handlersStripped: false } }, exitCode: 1 });
  assert.equal(forged.mode, 'report-not-trustworthy');
  assert.match(forged.problem, /forged or broken/);
  assert.doesNotMatch(forged.problem, /crash handlers/, 'a plain forgery must not be excused as suppression');
});

test('an explicit --expect-strip judges a deliberate strip on the tests that ran, and a driver DEFECT is not excusable (airhorn-co4h)', () => {
  const stripDriver = {
    importFailed: false,
    handlersStripped: true,
    strippedLines: 1,
    strippedReason: "the suite removed the driver's crash handlers - a crash outside any test would now be invisible (suppression, not a measurement)",
  };
  // The same run under two policies: refused by default, judged when the CALLER says the strip is deliberate.
  const refused = classifyRun({ report: { driver: stripDriver, startedTests: 1, realTests: 1, realPassed: 0, realFailed: 1, failing: ['answer'], wrapperEvents: 1, unattributed: 0 }, exitCode: 1 });
  assert.equal(refused.mode, 'report-not-trustworthy');
  assert.match(refused.problem, /--expect-strip/, 'a refusal must name the way to say the strip is deliberate');
  const opted = classifyRun({ report: { driver: stripDriver, startedTests: 1, realTests: 1, realPassed: 0, realFailed: 1, failing: ['answer'], wrapperEvents: 1, unattributed: 0 }, exitCode: 1, expectStrip: true });
  assert.equal(opted.mode, 'caught', 'with --expect-strip the runner\'s in-test evidence decides');
  assert.equal(opted.rc, 1);
  assert.match(opted.note, /INVISIBLE in this run/, 'the verdict must carry the limitation it accepted');
  // the other judged direction: a deliberate strip plus passing tests is 'passed', not a refusal
  const passing = classifyRun({ report: { driver: stripDriver, startedTests: 1, realTests: 1, realPassed: 1, realFailed: 0, wrapperEvents: 0, unattributed: 0 }, exitCode: 0, expectStrip: true });
  assert.equal(passing.mode, 'passed');
  assert.match(passing.note, /--expect-strip/);

  // A DRIVER DEFECT is refused BY NAME, and --expect-strip cannot excuse it. This is the direction a careless fix
  // breaks: touching only the strip policy turns a missing instrument back into a green verdict (measured on
  // master 191d5ded: a missing monitor + a swallowed crash produced `verdict: fix-does-not-close`).
  const defective = { importFailed: false, instruments: { monitor: false, rejection: true, exitCheck: true } };
  const named = classifyRun({ report: { driver: defective, startedTests: 1, realTests: 1, realPassed: 1, realFailed: 0 }, exitCode: 0 });
  assert.equal(named.mode, 'report-not-trustworthy');
  assert.match(named.problem, /never installed its monitor/);
  assert.match(named.problem, /defect in the tool/);
  const stillNamed = classifyRun({ report: { driver: defective, startedTests: 1, realTests: 1, realPassed: 1, realFailed: 0 }, exitCode: 0, expectStrip: true });
  assert.equal(stillNamed.mode, 'report-not-trustworthy', '--expect-strip is about the SUITE stripping, never about the driver failing to install');
  // control: a complete instrument set changes nothing about an honest run
  const healthy = classifyRun({ report: { driver: { importFailed: false, instruments: { monitor: true, rejection: true, exitCheck: true } }, startedTests: 1, realTests: 1, realPassed: 1, realFailed: 0 }, exitCode: 0 });
  assert.equal(healthy.mode, 'passed');
});

test('the code under test can read the run machinery and it buys nothing: the facts channel is not inherited (airhorn-14ht)', () => {
  // The nonce is NOT a secret and this test says so instead of pretending otherwise: /proc/self/environ
  // shows the exec-time environment, so a suite can read MUTATION_RUN_NONCE. What it cannot do is WRITE
  // the facts channel: the child runner's report pipe (MUTATION_SUITE_CHANNEL) lives in the runner
  // process, and the suite runs in its worker, which does not inherit it (measured here: the write
  // throws). So the suite may know everything and still cannot state a fact about the run.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-scrub-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
  fs.writeFileSync(path.join(tmp, 'suite.test.js'), `
import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { answer } from './src/subject.js';
test('try to write the facts channel, then fail the mutant for real', () => {
  let channel = null;
  let nonce = null;
  try {
    for (const kv of fs.readFileSync('/proc/self/environ', 'utf8').split('\\0')) {
      if (kv.startsWith('MUTATION_SUITE_CHANNEL=')) channel = kv.slice('MUTATION_SUITE_CHANNEL='.length);
      if (kv.startsWith('MUTATION_RUN_NONCE=')) nonce = kv.slice('MUTATION_RUN_NONCE='.length);
    }
  } catch {}
  let forged = 'no channel seen from this process at all';
  if (channel) {
    try {
      fs.writeSync(Number(channel), JSON.stringify({ kind: 'final', nonce, realTests: 0, realFailed: 0, fileLevelFailed: true }) + '\\n');
      forged = 'WROTE the facts channel';
    } catch (error) { forged = String(error && error.code); }
  }
  fs.writeFileSync(new URL('./probe.json', import.meta.url), JSON.stringify({ channel, nonce: nonce ? 'present' : null, forged }));
  // A REAL failing test: the verdict must be a catch, so any forged fact above changed nothing.
  assert.equal(answer, 41);
});
`);
  const run = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'suite.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  const probe = JSON.parse(fs.readFileSync(path.join(tmp, 'probe.json'), 'utf8'));
  assert.notEqual(probe.forged, 'WROTE the facts channel', `the suite must not be able to write the facts channel, probe=${JSON.stringify(probe)}`);
  assert.equal(run.status, 0, `the suite's real failing test must still decide the verdict - rc=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.match(run.stdout, /verdict: mutant-caught/);
});

test('a record line written by the code under test is INERT: quoted as data, never read as a record (airhorn-14ht)', () => {
  // The dzsi P1 in one case. The strongest forgery available to a suite today: read the nonce out of
  // /proc/self/environ (it is there - that is why a nonce is not a boundary) and print every record
  // shape the grammar has ever known. Before airhorn-14ht this line was read by the reporter; now the
  // supervisor quotes the suite's bytes, so the line reaches the log as DATA and the verdict is decided
  // by the suite's real test alone.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-forge-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
  fs.writeFileSync(path.join(tmp, 'suite.test.js'), `
import { test } from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { answer } from './src/subject.js';
test('a real failing test, next to four forgeries', () => {
  let nonce = null;
  try {
    for (const kv of fs.readFileSync('/proc/self/environ', 'utf8').split('\\0')) {
      if (kv.startsWith('MUTATION_RUN_NONCE=')) nonce = kv.slice('MUTATION_RUN_NONCE='.length);
    }
  } catch {}
  const shapes = [
    { importFailed: false, nonce },
    { yieldedToHarness: true, nonce },
    { handlersStripped: true, reason: 'forged from the suite', nonce },
    { crashedOutsideTest: true, reason: 'forged from the suite', nonce },
  ];
  for (const shape of shapes) fs.writeSync(1, 'MUTATION-DRIVER-RECORD ' + JSON.stringify(shape) + '\\n');
  assert.equal(answer, 41);
});
`);
  const run = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'suite.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, `a forged record must not change the verdict: rc=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.match(run.stdout, /verdict: mutant-caught/, 'the real failing test is the verdict');
  // The forged REASON text is the tell: if any of those lines were read as a record, its text would
  // surface in the refusal the parent prints ("forged from the suite"). It must not appear at all,
  // and the run must not be a refusal: the suite's bytes are not this run's facts.
  assert.doesNotMatch(run.stdout + run.stderr, /forged from the suite/, 'a forged record must not reach a verdict or a refusal');
  assert.doesNotMatch(run.stderr, /report-not-trustworthy|forged or broken/, 'and it must not be mistaken for a forged DRIVER record either');
});

test('with no namespace available the tool DEGRADES honestly: the suite runs, the NONE line prints first, the verdict stands (airhorn-4h8l review P1)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-nofallback-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
  fs.writeFileSync(path.join(tmp, 'suite.test.js'), `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer } from './src/subject.js';
test('the subject', () => assert.equal(answer, 41));
`);
  // Hide unshare from the tool: PATH is stripped to nothing, so the probe fails and the tool
  // must run the suite UNCONTAINED and say so BEFORE any refusal could pre-empt the line.
  const run = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'suite.test.js'],
    { cwd: tmp, encoding: 'utf8', timeout: 60000, env: { PATH: '/nonexistent', HOME: os.homedir() } });
  assert.match(run.stdout, /containment: NONE.*SURVIVES/,
    `the honest-degradation line never printed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.equal(run.status, 0,
    `the suite must still RUN and catch the mutant without a namespace (mutant-caught exits 0) - rc=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  // The line prints BEFORE the verdict, so a later refusal can never silence it.
  assert.ok(run.stdout.indexOf('containment: NONE') < run.stdout.indexOf('verdict:'), 'the NONE line must precede the verdict');
});

test('a suite file that registers NO tests at all is never-ran, not a scored run (airhorn-3wth)', () => {
  // The runner emits a file-level entry for every test file, and a file whose only content is the import
  // registers nothing: it used to be counted as one REAL test (realTests:1, the wrapper), so a zero-test
  // suite scored "fix-does-not-close" as if something had been measured. The guard that refuses it
  // (realTests === 0) must stay reachable through the real call path, which is what this world checks.
  // airhorn-jfb8: the SPELLING must not matter. Directory-qualified paths once bypassed name-based
  // guards because node names the file-level event with the path AS PASSED (airhorn-lnme); the guard
  // is execution-based now, so every spelling refuses identically - and this pin is what keeps a
  // future spelling-sensitive edit from resurrecting the bypass. Measured before pinning: bare,
  // ./, sub/, ./sub/ and absolute all refuse rc 3 [never-ran] on master 8b7ef0b2.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '3wth-empty-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.mkdirSync(path.join(tmp, 'sub'));
    fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
    fs.writeFileSync(path.join(tmp, 'empty.test.mjs'), "import test from 'node:test';\n");
    fs.writeFileSync(path.join(tmp, 'sub', 'empty.test.mjs'), "import test from 'node:test';\n");
    for (const spelling of ['empty.test.mjs', './empty.test.mjs', 'sub/empty.test.mjs', './sub/empty.test.mjs', path.join(tmp, 'empty.test.mjs')]) {
      const result = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', spelling], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
      assert.equal(result.status, 3, `a suite that registers no tests measured nothing and must be refused (${spelling}): ${result.stdout}${result.stderr}`);
      const said = result.stdout + result.stderr;
      assert.match(said, /never-ran/, `${spelling} must name never-ran`);
      assert.match(said, /registered no tests/, `${spelling} must name the empty guard`);
      assert.doesNotMatch(result.stdout, /verdict: (mutant-caught|fix-does-not-close)/, `nothing may be scored from a run with no tests (${spelling})`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a describe() container is not a test: a container-only suite is never-ran, not a verdict', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u1v2-container-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
    // A container with nothing inside it: it starts and passes exactly like a test does.
    fs.writeFileSync(path.join(tmp, 'container.test.mjs'), "import { describe } from 'node:test';\ndescribe('an empty group', () => {});\n");
    const result = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'container.test.mjs'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(result.status, 3, `a container is not a started test: ${result.stdout}${result.stderr}`);
    const said = result.stdout + result.stderr;
    assert.match(said, /never-ran/);
    assert.match(said, /registered no tests/);
    assert.doesNotMatch(result.stdout, /verdict: mutant-caught/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a container is never named as a failing test: only the test inside it is', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u1v2-container2-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
    fs.writeFileSync(path.join(tmp, 'grouped.test.mjs'), [
      "import { describe, it } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { answer } from './src/subject.js';",
      "describe('a group', () => { it('the real check', () => { assert.equal(answer, 41); }); });",
    ].join('\n'));
    const result = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'grouped.test.mjs'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /verdict: mutant-caught/);
    const record = /# suite-mode: (\{.*\})/.exec(result.stdout);
    assert.ok(record, `the run must report its counts: ${result.stdout}`);
    const report = JSON.parse(record[1]);
    assert.equal(report.startedTests, 1, 'exactly one TEST started; the container is not one');
    assert.deepEqual(report.failing, ['the real check'], 'the container must not appear beside the real failure');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the wrapper identity is total: symlink, ./ prefix, doubled slash and absolute all agree', () => {
  // Unit-level on the predicate the reporter uses, because the structural cases are covered end to
  // end below and node always supplies data.file there - this is the guard for when it does not.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u1v2-identity-'));
  try {
    const real = path.join(dir, 'tools', 'suite-driver.mjs');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, '// driver\n');
    fs.symlinkSync(path.join(dir, 'tools'), path.join(dir, 'toolslink'));
    assert.equal(exportedSameFile(real, real), true, 'the same string');
    assert.equal(exportedSameFile(path.join(dir, '.', 'tools', 'suite-driver.mjs'), real), true, 'a . segment');
    assert.equal(exportedSameFile(path.join(dir, 'tools', '', 'suite-driver.mjs'), real), true, 'a doubled separator');
    assert.equal(exportedSameFile(path.join(dir, 'toolslink', 'suite-driver.mjs'), real), true, 'through a symlinked directory');
    assert.equal(exportedSameFile('tools/suite-driver.mjs', real), true, 'relative against absolute');
    assert.equal(exportedSameFile('', real), false, 'nothing is not the driver');
    assert.equal(exportedSameFile(undefined, real), false, 'a missing file field is not the driver');
    // Under-claim, documented: a different file with the same basename reads as the driver.
    assert.equal(exportedSameFile('/elsewhere/suite-driver.mjs', real), true, 'same basename under-claims, which is safe');
    assert.equal(exportedSameFile('/elsewhere/other.mjs', real), false, 'different names, different files');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a suite path spelling never changes the verdict: bare, tests/, ./tests/, tests//, absolute, symlinked dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u1v2-spelling-'));
  const write = (rel, body) => {
    const target = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  try {
    write('src/subject.js', 'export const answer = 41;\n');
    write('tests/catches.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from '../src/subject.js';\ntest('the check', () => { assert.equal(answer, 41); });\n");
    fs.symlinkSync(path.join(tmp, 'tests'), path.join(tmp, 'testslink'));
    const outcomes = new Map();
    for (const suite of ['tests/catches.test.mjs', './tests/catches.test.mjs', 'tests//catches.test.mjs', path.join(tmp, 'tests', 'catches.test.mjs'), 'testslink/catches.test.mjs']) {
      const result = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', suite], { cwd: tmp, encoding: 'utf8' });
      const verdict = (/verdict: (\S+)/.exec(result.stdout) || [null, `rc${result.status}`])[1];
      outcomes.set(suite, `${result.status}:${verdict}`);
      assert.equal(result.status, 0, `${suite}: ${result.stdout}${result.stderr}`);
    }
    assert.equal(new Set(outcomes.values()).size, 1, `every spelling must give one outcome: ${[...outcomes].map(([k, v]) => `${k}=${v}`).join(', ')}`);
    // A trailing slash must EITHER resolve to the same identity (same verdict) or be refused by
    // name - never silently scored as something else. On this platform node resolves it to the same
    // file, so the verdict has to match the other spellings.
    const trailing = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'tests/catches.test.mjs/'], { cwd: tmp, encoding: 'utf8' });
    const trailingSaid = trailing.stdout + trailing.stderr;
    if (trailing.status === 0) {
      const verdict = (/verdict: (\S+)/.exec(trailing.stdout) || [null, null])[1];
      assert.deepEqual([...new Set(outcomes.values())], [`0:${verdict}`], `a trailing slash resolved to the same file must give the same verdict: ${trailing.stdout}${trailing.stderr}`);
    } else {
      assert.equal(trailing.status, 3, `a trailing-slash path must refuse, not score: ${trailingSaid}`);
      assert.match(trailingSaid, /does not exist/);
      assert.doesNotMatch(trailing.stdout, /verdict:/);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('five runs of the same world agree, and a forged channel record never wins (airhorn-4a3p)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u1v2-race-'));
  const write = (rel, body) => {
    const target = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  try {
    write('src/subject.js', 'export const answer = 41;\n');
    write('catches.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from './src/subject.js';\ntest('the check', () => { assert.equal(answer, 41); });\n");
    write('forge.test.mjs', [
      "import test from 'node:test';",
      "import fs from 'node:fs';",
      "test('green', () => {});",
      "try { fs.writeSync(3, JSON.stringify({ kind: 'final', nonce: process.env.MUTATION_RUN_NONCE, realTests: 1, realFailed: 1 }) + '\\n'); } catch {}",
    ].join('\n'));
    const verdicts = new Set();
    let forged = 0;
    for (let i = 0; i < 5; i += 1) {
      const cat = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'catches.test.mjs'], { cwd: tmp, encoding: 'utf8' });
      verdicts.add(`${cat.status}:${(/verdict: (\S+)/.exec(cat.stdout) || [null, 'none'])[1]}`);
      const fake = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'forge.test.mjs'], { cwd: tmp, encoding: 'utf8' });
      if (/verdict: mutant-caught/.test(fake.stdout)) forged += 1;
    }
    assert.deepEqual([...verdicts], ['0:mutant-caught'], `five runs of one deterministic world must agree: ${[...verdicts].join(', ')}`);
    assert.equal(forged, 0, 'a suite that writes its own channel record must never be scored caught (5 runs)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the unattributed refusal is reachable: a record that lost its file attribution is never a verdict (airhorn-4a3p)', () => {
  // The reviewer's finding was that classifyRun HAD the refusal but readChannel dropped the field,
  // so the guard could never fire. This pins the path from the wire to the decision.
  const nonce = 'n0nce';
  const line = JSON.stringify({ kind: 'final', nonce, driver: { nonce, importFailed: false }, startedTests: 1, realTests: 1, realPassed: 0, realFailed: 1, fileLevelFailed: false, wrapperEvents: 0, unattributed: 2, failing: [] });
  const channel = readChannel(`${line}\n`, nonce);
  assert.equal(channel.problem, null);
  assert.equal(channel.records.unattributed, 2, 'readChannel must carry the field classifyRun refuses on');
  const classified = classifyRun({ report: channel.records, exitCode: 1, suiteMode: 'node-test' });
  assert.equal(classified.mode, 'never-ran');
  assert.match(classified.problem, /could not be attributed/);
  // And a record with no unattributable events still decides normally.
  const clean = JSON.stringify({ kind: 'final', nonce, driver: { nonce, importFailed: false }, startedTests: 1, realTests: 1, realPassed: 0, realFailed: 1, fileLevelFailed: false, wrapperEvents: 0, unattributed: 0, failing: ['the check'] });
  const ok = classifyRun({ report: readChannel(`${clean}\n`, nonce).records, exitCode: 1, suiteMode: 'node-test' });
  assert.equal(ok.mode, 'caught');
});

test('a hanging suite is bounded: named refusal, and no process of the run outlives the check (reaper event, 2026-11-04)', () => {
  // The fleet reaper found a 120-minute-old test-runner process of mine on this VM. The cause was
  // that there was NO BOUND: suites ran through spawnSync, which blocks, so no timer could fire and
  // the check could not be interrupted. This pins the bound, the refusal that names it, and that
  // the killed run leaves nothing behind.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u1v2-reaper-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
    fs.writeFileSync(path.join(tmp, 'hangs.test.mjs'), "import test from 'node:test';\ntest('never ends', () => new Promise(() => {}));\n");
    const started = Date.now();
    const result = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'hangs.test.mjs', '--timeout-ms', '1200'], { cwd: tmp, encoding: 'utf8', timeout: 30000 });
    const elapsed = Date.now() - started;
    assert.equal(result.status, 3, `a hang is a named refusal, not a verdict: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout + result.stderr, /did not finish within 1200ms/);
    assert.match(result.stdout + result.stderr, /killed with its process group/);
    assert.doesNotMatch(result.stdout, /verdict:/, 'a killed run scores nothing');
    assert.ok(elapsed < 20000, `the bound must actually bound the run (took ${elapsed}ms)`);
    // Nothing of the run may still be running. Identified by CWD, not by argv: node's per-file child
    // runs the DRIVER, so the suite's name lives in its environment, never in its command line - an
    // argv check passes while the process it is looking for is still alive.
    const sandbox = fs.realpathSync(tmp);
    const survivors = [];
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      let cwd;
      try { cwd = fs.realpathSync(`/proc/${entry}/cwd`); } catch { continue; }
      if (cwd !== sandbox) continue;
      let args = '';
      try { args = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8'); } catch { continue; }
      survivors.push(`${entry} ${args.split('\0').slice(0, 3).join(' ')}`);
    }
    assert.deepEqual(survivors, [], `no process of the killed run may outlive the check: ${survivors.join(' | ')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('--build: success proceeds, failure refuses, a hanging build is a named refusal (rev-u1v2r7)', () => {
  // run() is asynchronous, so an un-awaited call puts a Promise where an exit code belongs - and a
  // Promise is truthy, so the build could never fail and a mutant that does not build would have
  // been scored. The old code did exactly that.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u1v2-build-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
    fs.writeFileSync(path.join(tmp, 'catches.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from './src/subject.js';\ntest('the check', () => { assert.equal(answer, 41); });\n");
    const runIt = (...extra) => spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'catches.test.mjs', ...extra], { cwd: tmp, encoding: 'utf8', timeout: 40000 });

    const ok = runIt('--build', 'true');
    assert.equal(ok.status, 0, `a successful build must let the run proceed: ${ok.stdout}${ok.stderr}`);
    assert.match(ok.stdout, /building: true/);
    assert.match(ok.stdout, /verdict: mutant-caught/);

    const bad = runIt('--build', 'node -e "process.exit(7)"');
    assert.equal(bad.status, 3, `a failed build must refuse: ${bad.stdout}${bad.stderr}`);
    assert.match(bad.stdout + bad.stderr, /the build failed \(rc=7\)/);
    assert.doesNotMatch(bad.stdout, /verdict:/, 'a mutant that does not build proves nothing');

    const hang = runIt('--build', 'sleep 30', '--timeout-ms', '1200');
    assert.equal(hang.status, 3, hang.stdout + hang.stderr);
    assert.match(hang.stdout + hang.stderr, /the build did not finish within 1200ms/);
    assert.doesNotMatch(hang.stdout, /verdict:/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a container and a test with the SAME name do not cancel out: the real start survives (airhorn-glhj)', () => {
  // The reviewer's repro: keyOf(file, name, nesting) is not unique - a top-level describe('group')
  // and a top-level test('group') share all three - so keyed subtraction erased the REAL test's
  // start, startedTests fell to 0, and a genuinely caught mutant was refused as
  // threw-outside-a-test. Containers are now subtracted by testId.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u1v2-collide-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
    fs.writeFileSync(path.join(tmp, 'collision.test.mjs'), [
      "import { describe, test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { answer } from './src/subject.js';",
      "describe('group', () => {});",
      "test('group', () => assert.equal(answer, 41));",
    ].join('\n'));
    const result = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'collision.test.mjs'], { cwd: tmp, encoding: 'utf8', timeout: 40000 });
    assert.equal(result.status, 0, `a caught mutant must not be refused because a container shares its name: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /verdict: mutant-caught/);
    const record = /# suite-mode: (\{.*\})/.exec(result.stdout);
    assert.ok(record, result.stdout);
    const report = JSON.parse(record[1]);
    assert.equal(report.startedTests, 1, 'the REAL test started exactly once');
    assert.deepEqual(report.failing, ['group']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('excluding containers does not over-subtract: a describe holding two tests counts two starts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u1v2-nested-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
    fs.writeFileSync(path.join(tmp, 'nested.test.mjs'), [
      "import { describe, it } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { answer } from './src/subject.js';",
      "describe('outer', () => {",
      "  it('one', () => assert.equal(answer, 41));",
      "  it('two', () => assert.equal(answer, 41));",
      "});",
    ].join('\n'));
    const result = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'nested.test.mjs'], { cwd: tmp, encoding: 'utf8', timeout: 40000 });
    const record = /# suite-mode: (\{.*\})/.exec(result.stdout);
    assert.ok(record, result.stdout + result.stderr);
    const report = JSON.parse(record[1]);
    assert.equal(report.startedTests, 2, 'the two tests inside the describe started; the describe itself is not a test');
    assert.equal(report.realTests, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a signal during the mutant window RESTORES the file instead of leaving the mutant on disk (airhorn-rf0u)', async () => {
  // Reproduced before the fix: SIGTERM between the mutant write and the finally left the product
  // file holding the mutant (`answer = 42`) and printed only "no verdict was scored" - the finally
  // never runs, because process.exit() in a signal handler terminates without unwinding.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u1v2-sig-'));
  const subject = path.join(tmp, 'src', 'subject.js');
  const originalText = 'export const answer = 41;\n';
  let child = null;
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(subject, originalText);
    fs.writeFileSync(path.join(tmp, 'slow.test.mjs'), "import test from 'node:test';\ntest('slow', () => new Promise((r) => setTimeout(r, 8000)));\n");
    child = spawn(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'slow.test.mjs'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    child.stdout.on('data', (chunk) => { said += String(chunk); });
    child.stderr.on('data', (chunk) => { said += String(chunk); });
    const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    // Wait (bounded) until the mutant is actually on disk, then interrupt inside that window.
    const deadline = Date.now() + 15000;
    while (!fs.readFileSync(subject, 'utf8').includes('answer = 42') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(fs.readFileSync(subject, 'utf8').includes('answer = 42'), 'the run must reach the mutated state for this test to mean anything');
    child.kill('SIGTERM');
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
    assert.notEqual(code, 'timeout', 'the tool must exit after the signal, not hang');
    assert.equal(fs.readFileSync(subject, 'utf8'), originalText, 'the signal path must restore the file, not just report');
    assert.match(said, /restored and verified/, `the interrupted run must say what it did to the file: ${said}`);
    // The exit code is part of the contract (airhorn-da6c): a handler that restored the file but let
    // the refusal path exit 3 instead of 143 would pass every other assertion here.
    assert.equal(code, 143, `SIGTERM must exit 143, not ${code}`);
    assert.doesNotMatch(said, /verdict:/, 'an interrupted run scores no verdict');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a TEST file is refused by every spelling AND by identity - symlink and hardlink included (airhorn-29nt, airhorn-7rer)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u1v2-target-'));
  const testFile = path.join(tmp, 'tests', 'answer.test.mjs');
  const body = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from '../src/subject.js';\ntest('x', () => assert.equal(answer, 41));\n";
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.mkdirSync(path.join(tmp, 'tests'));
    fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
    fs.writeFileSync(testFile, body);
    const runIt = (file, from = 'answer, 41', to = 'answer, 42', ...extra) => spawnSync(process.execPath, [tool, '--file', file, '--from', from, '--to', to, '--suite', 'tests/answer.test.mjs', ...extra], { cwd: tmp, encoding: 'utf8', timeout: 40000 });

    // Absolute spelling was the one that slipped through the old prefix check.
    const absolute = runIt(testFile);
    assert.equal(absolute.status, 3, absolute.stdout + absolute.stderr);
    assert.match(absolute.stdout + absolute.stderr, /is a TEST file/);
    assert.doesNotMatch(absolute.stdout, /mutant applied/, 'the guard must refuse before writing');
    assert.equal(fs.readFileSync(testFile, 'utf8'), body, 'the test file must be untouched');

    // The relative spelling keeps being refused, and a product file is still allowed through.
    const relative = runIt('tests/answer.test.mjs');
    assert.equal(relative.status, 3, relative.stdout + relative.stderr);
    assert.match(relative.stdout + relative.stderr, /is a TEST file/);
    const product = runIt(path.join(tmp, 'src', 'subject.js'), '41', '42');
    assert.match(product.stdout, /mutant applied/, `a product file must not be refused: ${product.stdout}${product.stderr}`);

    // A tests/ directory ANYWHERE in the resolved path, even one outside the working directory:
    // the relative form is `../tests/...` there, so only the path-SEGMENT check refuses it, and
    // that is the spelling a wrapper script outside the checkout naturally produces (airhorn-29nt).
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u1v2-outside-'));
    try {
      fs.mkdirSync(path.join(outsideDir, 'tests'));
      fs.writeFileSync(path.join(outsideDir, 'tests', 'outside.test.mjs'), body);
      const outside = runIt(path.join(outsideDir, 'tests', 'outside.test.mjs'));
      assert.equal(outside.status, 3, `an outside-cwd tests/ target must be refused: ${outside.stdout}${outside.stderr}`);
      assert.match(outside.stdout + outside.stderr, /is a TEST file/);
      assert.doesNotMatch(outside.stdout, /mutant applied/, 'the guard must refuse before writing');
      assert.equal(fs.readFileSync(path.join(outsideDir, 'tests', 'outside.test.mjs'), 'utf8'), body, 'the outside test file is untouched');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }

    // Neither of these NAMES looks like a test file, and path.resolve cannot see that they are one
    // (airhorn-7rer): a symlink to it, and a hardlink of it under a product-looking name.
    fs.symlinkSync(path.join('tests', 'answer.test.mjs'), path.join(tmp, 'link.mjs'));
    fs.linkSync(testFile, path.join(tmp, 'src', 'sneaky.js'));
    for (const spelling of ['link.mjs', 'src/sneaky.js']) {
      const linked = runIt(spelling);
      assert.equal(linked.status, 3, `${spelling} must be refused: ${linked.stdout}${linked.stderr}`);
      assert.match(linked.stdout + linked.stderr, /is a TEST file|same inode/);
      assert.doesNotMatch(linked.stdout, /mutant applied/, `${spelling} must be refused before writing`);
    }
    assert.equal(fs.readFileSync(testFile, 'utf8'), body, 'the test file is untouched by any refused spelling');

    // The flag still overrides: the test file CAN be the subject of the experiment.
    const allowed = runIt(testFile, 'answer, 41', 'answer, 42', '--allow-test-mutation');
    assert.match(allowed.stdout, /mutant applied/, allowed.stdout + allowed.stderr);
    assert.equal(fs.readFileSync(testFile, 'utf8'), body, 'the file is restored either way');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SUPPRESSION: strip + swallow-with-exit-0 + crash cannot become a catch - the sentinel refuses the strip (airhorn-p0dg, revised by airhorn-14ht, closed by airhorn-5wns)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-p0dg-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
  fs.writeFileSync(path.join(tmp, 'suite.test.js'), `
import { test } from 'node:test';
process.removeAllListeners('uncaughtException');
process.removeAllListeners('unhandledRejection');
process.on('uncaughtException', () => process.exit(0));
test('passes', () => {});
setTimeout(() => { throw new Error('the mutant crash, suppressed'); }, 50);
`);
  const run = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'suite.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  // airhorn-5wns: the strip removes the sentinel's own rejection listener from ITS process, and the
  // sentinel refuses a strip of itself - the run dies non-clean and is refused, never scored.
  assert.equal(run.status, 3,
    `a suppressed crash must be refused now that the sentinel watches the suite process - rc=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.doesNotMatch(run.stdout, /verdict: mutant-caught/, 'the one thing a suppressed crash must never do is look caught');
});

test('SUPPRESSION, the reviewer world: strip AND swallow AND throw in ONE timer callback never becomes a catch (airhorn-p0dg round 2, revised by airhorn-14ht)', () => {
  // The shape that beat the microtask deferral: everything in one tick, so no microtask ever
  // runs. The strip report must already be written - synchronously - before the exit(0).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-p0dg-b-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
  fs.writeFileSync(path.join(tmp, 'suite.test.js'), `
import { test } from 'node:test';
test('passes', () => {});
setTimeout(() => {
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');
  process.on('uncaughtException', () => process.exit(0));
  throw new Error('swallowed in the same tick');
}, 30);
`);
  const run = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'suite.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  // airhorn-5wns: the strip lists hold the sentinel's instruments again - it lives in the suite's
  // process, loaded by the supervisor's spawn. Removing the rejection sentinel (or the monitor) is a
  // strip the sentinel refuses by dying non-clean, so the one-timer shape is a refusal, never a verdict.
  assert.equal(run.status, 3,
    `the one-timer suppression must be refused now - rc=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.doesNotMatch(run.stdout, /verdict: mutant-caught/, 'the one thing a suppression must never do is look caught');
  // airhorn-5qdd, airhorn-p0dg: both halves are named - the strip trips the sentinel's own watcher and
  // the crash would fire its monitor; either alone refuses. The strip is what a suite that removes the
  // MONITOR gets caught by (the world below).
  assert.match(run.stdout + run.stderr, /\[(never-ran|threw-outside-a-test)\]/, `must be a named refusal, got: ${run.stdout}${run.stderr}`);

  // And the monitor is the thing to strip now: removing it trips the same watcher, so the attempt is reported at strip time
  // rather than succeeding.
  fs.writeFileSync(path.join(tmp, 'monitor-strip.test.js'), `
import { test } from 'node:test';
test('passes', () => {});
setTimeout(() => {
  process.removeAllListeners('uncaughtExceptionMonitor');
  process.on('uncaughtException', () => process.exit(0));
  throw new Error('swallowed after removing the monitor');
}, 30);
`);
  const monitorStrip = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'monitor-strip.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  // airhorn-5wns: the monitor IS in this process now - it is the sentinel's - so removing it is a strip
  // the sentinel refuses by dying non-clean, and the swallow never gets to run.
  assert.equal(monitorStrip.status, 3,
    `removing the sentinel's monitor must be refused (airhorn-gb9y strip discipline) - rc=${monitorStrip.status}\nstdout:\n${monitorStrip.stdout}\nstderr:\n${monitorStrip.stderr}`);
  assert.doesNotMatch(monitorStrip.stdout, /verdict: mutant-caught/, 'a stripped monitor must never look caught');
});

test('SUPPRESSION, end to end: strips are no-ops now, a crash is named from outside, and a supervisor defect is refused not judged (airhorn-co4h, airhorn-14ht)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-co4h-'));
  const write = (name, body) => fs.writeFileSync(path.join(tmp, name), body);
  const runWorld = (args, toolPath = tool) => spawnSync(process.execPath, [toolPath, '--file', 'src/subject.js', '--from', '41', '--to', '42', ...args], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    write('src/subject.js', 'export const answer = 41;\n');
    // (a) a "strip" of what used to be nobody's handlers, plus a test that genuinely catches the
    // mutant: airhorn-5wns changed the answer - the uncaughtExceptionMonitor list holds the sentinel's
    // handler now, so the strip is refused and the catch is never reached.
    write('strip-top.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from './src/subject.js';\nprocess.removeAllListeners('uncaughtExceptionMonitor');\ntest('answer', () => assert.equal(answer, 41));\n");
    // (b) the same strip and nothing that catches: refused by the sentinel all the same.
    write('strip-timer.test.js', "import test from 'node:test';\ntest('passes', () => {});\nsetTimeout(() => { process.removeAllListeners('uncaughtExceptionMonitor'); process.removeAllListeners('unhandledRejection'); }, 20);\n");
    // (c) a crash after the strip: seen from OUTSIDE now (the child exits non-zero with no failing
    // test), so it is named as the crash it is - the airhorn-14ht capability the old design lacked,
    // where a crash that runs no JS at all (abort, OOM, hard kill) recorded nothing.
    write('strip-die.test.js', "import test from 'node:test';\ntest('passes', () => {});\nsetTimeout(() => { process.removeAllListeners('uncaughtExceptionMonitor'); throw new Error('genuine strip, then a crash nothing records'); }, 30);\n");

    const top = runWorld(['--suite', 'strip-top.test.js']);
    assert.equal(top.status, 3, `a strip of the sentinel's monitor must be refused even beside a real catch (airhorn-5wns) - rc=${top.status}\n${top.stdout}${top.stderr}`);
    assert.doesNotMatch(top.stdout, /verdict: mutant-caught/, 'the catch is never reached: the strip refused the run first');

    const timer = runWorld(['--suite', 'strip-timer.test.js']);
    assert.equal(timer.status, 3, `a strip of the sentinel's instruments is refused, no catcher or not - rc=${timer.status}\n${timer.stdout}${timer.stderr}`);
    assert.doesNotMatch(timer.stdout, /verdict: mutant-caught/, 'a refused run scores no verdict');

    const died = runWorld(['--suite', 'strip-die.test.js']);
    assert.equal(died.status, 3, `a crash outside any test is refused by name - rc=${died.status}\n${died.stdout}${died.stderr}`);
    assert.match(died.stderr, /threw-outside-a-test/, 'the refusal must name the crash, which is now visible from outside the process');

    // --expect-strip no longer changes any verdict: the sentinel refuses a strip of its instruments by
    // dying non-clean, and nothing the caller passes can turn that death into a verdict (airhorn-5wns).
    // The flag is accepted for command compatibility only.
    const opted = runWorld(['--suite', 'strip-top.test.js', '--expect-strip']);
    assert.equal(opted.status, 3, `--expect-strip must not excuse a strip the sentinel refused - rc=${opted.status}\n${opted.stdout}${opted.stderr}`);
    assert.doesNotMatch(opted.stdout, /verdict: mutant-caught/, 'an excused strip must never become a catch');
    assert.match(opted.stdout, /policy: .*--expect-strip is accepted for command compatibility/, 'the policy line must say --expect-strip no longer changes anything');

    // A SUPERVISOR DEFECT is refused, not judged: with the child's wrapper identification removed the
    // child's real tests collapse into the file-level event, so realTests reads 0 and the run is
    // never-ran - a named refusal, never a quiet verdict. (This replaces the old regression that
    // deleted the driver's install line; there is no install line any more, so the pin moves to the
    // one piece of wiring the supervisor must get right.)
    const copy = path.join(tmp, 'toolcopy');
    fs.cpSync(path.dirname(tool), copy, { recursive: true });
    const badDriver = path.join(copy, 'lib', 'suite-driver.mjs');
    const text = fs.readFileSync(badDriver, 'utf8');
    const broken = text.replace("MUTATION_WRAPPER_BY_NAME: '1',", '');
    assert.notEqual(broken, text, 'the wiring line must exist for this regression to be meaningful');
    fs.writeFileSync(badDriver, broken);
    const defect = spawnSync(process.execPath, [path.join(copy, 'mutation-check.mjs'), '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'strip-top.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
    assert.equal(defect.status, 3, `a supervisor that mis-identifies the wrapper must be refused, not judged - rc=${defect.status}\n${defect.stdout}${defect.stderr}`);
    assert.doesNotMatch(defect.stdout, /verdict: mutant-caught/, 'a wiring defect must never produce a catch');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an honest crash outside any test is still threw-outside-a-test, even with the strip watcher live (the once() artifact must not read as tamper)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-p0dg-honest-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
  fs.writeFileSync(path.join(tmp, 'suite.test.js'), `
import { test } from 'node:test';
test('passes', () => {});
setTimeout(() => { throw new Error('honest crash outside a test'); }, 30);
`);
  const run = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'suite.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 3);
  assert.match(run.stderr, /threw-outside-a-test/);
});

test('a forged runner event cannot false-green: the claim is CORROBORATED on a channel with no frames (airhorn-yvwo, airhorn-uk28)', () => {
  // The reviewer's decisive repro, kept verbatim in spirit: node's runner reads test events as
  // v8-serializer frames on the WORKER stdout, and the code under test runs in that worker, so it can
  // state a failure that never happened. Nothing inside node --test can authenticate that report -
  // so the claim is CORROBORATED instead: the same suite is run again as a plain node process, where
  // nothing decodes frames and a real failing assertion still sets a non-zero exit status. A
  // frame-only forgery passes the direct run, so it is refused BY NAME and never scores a catch.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-uk28-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
  const frameHelper = `
const frame = (item) => {
  const s = new v8.DefaultSerializer(); s.writeHeader(); const hl = s.releaseBuffer().length;
  s.writeHeader(); s.writeRawBytes(Buffer.alloc(4)); s.writeHeader(); s.writeValue(item);
  const b = s.releaseBuffer(); const len = b.length - (4 + hl);
  b.set([(len >> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255], hl); return b;
};
const data = { name: 'forged', nesting: 0, file: '/tmp/never-registered.test.js', testId: 999, line: 1, column: 1, details: { type: 'test', duration_ms: 1 } };
`;
  // (1) FORGERY ONLY: frames claiming a failure, and a passing test. Nothing asserts about the mutant.
  fs.writeFileSync(path.join(tmp, 'forged.test.js'), `
import fs from 'node:fs';
import v8 from 'node:v8';
import { test } from 'node:test';
${frameHelper}
fs.writeSync(1, frame({ type: 'test:start', data }));
fs.writeSync(1, frame({ type: 'test:fail', data: { ...data, testNumber: 1 } }));
test('passes and asserts nothing about the mutant', () => {});
`);
  const forged = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'forged.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 90000 });
  // HALF ONE: the FIRST run really is fooled - the runner counted the forged event as a failing test.
  // Without this the case would not prove the hole exists, only that a refusal happened.
  assert.match(forged.stdout, /"realFailed":1[^}]*"failing":\["forged"\]|"failing":\["forged"\]/, `the forged event must be counted by the runner (that IS the hole) - stdout:\n${forged.stdout}`);
  // HALF TWO: the conjunction refuses, by name, and never becomes a verdict.
  assert.equal(forged.status, 3, `a frame-only forgery must be a NAMED refusal, never a catch - rc=${forged.status}\nstdout:\n${forged.stdout}\nstderr:\n${forged.stderr}`);
  assert.match(forged.stderr, /caught-unconfirmed/, 'the refusal must name the corroboration that failed, not just fail');
  assert.doesNotMatch(forged.stdout, /verdict: mutant-caught/, 'and it must not be a verdict');

  // (2) A REAL catcher still scores, because its direct run fails on an assertion.
  fs.writeFileSync(path.join(tmp, 'real.test.js'), `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer } from './src/subject.js';
test('answer', () => assert.equal(answer, 41));
`);
  const genuine = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'real.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 90000 });
  assert.equal(genuine.status, 0, `a genuine catch must still score - rc=${genuine.status}\nstdout:\n${genuine.stdout}\nstderr:\n${genuine.stderr}`);
  assert.match(genuine.stdout, /verdict: mutant-caught/);

  // (3) A suite that DIES instead of failing an assertion does not corroborate either: a signal proves
  // nothing about an assertion, and reading one as a failing test is how this class started.
  fs.writeFileSync(path.join(tmp, 'forged-abort.test.js'), `
import fs from 'node:fs';
import v8 from 'node:v8';
import { test } from 'node:test';
${frameHelper}
fs.writeSync(1, frame({ type: 'test:start', data }));
fs.writeSync(1, frame({ type: 'test:fail', data: { ...data, testNumber: 1 } }));
test('passes', () => {});
setTimeout(() => process.abort(), 40);
`);
  const died = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'forged-abort.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 90000 });
  assert.equal(died.status, 3, `forged frames plus a hard crash must never be a catch - rc=${died.status}\nstdout:\n${died.stdout}\nstderr:\n${died.stderr}`);
  assert.doesNotMatch(died.stdout, /verdict: mutant-caught/);

  // (4) A direct run that could not EXECUTE the suite (here: a dependency the child runner tolerates and a
  // plain node does not) proves nothing about an assertion, so it is UNCORROBORATED - never a catch.
  fs.writeFileSync(path.join(tmp, 'env-fail.test.js'), `
import fs from 'node:fs';
import v8 from 'node:v8';
import { test } from 'node:test';
${frameHelper}
if (process.env.NODE_TEST_CONTEXT === undefined) {
  // Plain node: fail to load, the way a missing browser or a native dependency does.
  throw new Error('ERR_MODULE_NOT_FOUND: the corroboration run cannot execute this suite');
}
fs.writeSync(1, frame({ type: 'test:start', data }));
fs.writeSync(1, frame({ type: 'test:fail', data: { ...data, testNumber: 1 } }));
test('passes', () => {});
`);
  const uncorroborated = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'env-fail.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 90000 });
  assert.equal(uncorroborated.status, 3, `an unexecutable corroboration run must not corroborate - rc=${uncorroborated.status}\nstdout:\n${uncorroborated.stdout}\nstderr:\n${uncorroborated.stderr}`);
  assert.match(uncorroborated.stderr, /caught-uncorroborated|could not EXECUTE/, 'the refusal must say the second run could not speak, not that it disagreed');
});

test('the tool prints its trust boundary, including the KNOWN-LIMIT it now carries (airhorn-p0dg, airhorn-14ht)', () => {
  // Printed and not just commented: an operator reading the output must be able to see where the line is.
  // The boundary itself changed with airhorn-14ht (two processes, quoted child bytes, a parent-owned fact
  // pipe), so this pins the CLAIMS that must always be stated - the structural ones and the limit.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-trust-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
  fs.writeFileSync(path.join(tmp, 'suite.test.js'), "import test from 'node:test';\ntest('green', () => {});\n");
  const run = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'suite.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  const said = run.stdout + run.stderr;
  assert.match(said, /trust: the suite runs in a CHILD/, 'the trust line must say the suite is in its own process');
  assert.match(said, /QUOTED/, 'and that the suite bytes are quoted as data');
  assert.match(said, /pipe the suite does not inherit/, 'and that the facts travel on a channel the suite cannot write');
  assert.match(said, /KNOWN-LIMIT/, 'and it must state what it has given up rather than implying closure');
  // airhorn-5wns: the swallow KNOWN-LIMIT became a sentinel refusal, so the line must claim the guard
  // and its one unforgeable fact, and keep naming the limit that remains (the event self-report).
  assert.match(said, /suite-guard\.mjs/, 'the sentinel must be named');
  assert.match(said, /SIGKILL/, 'and the refusal mechanism (a non-clean death) must be stated');
  assert.doesNotMatch(said, /indistinguishable from a passing suite/, 'the old swallow limit must not be claimed any more');
  assert.equal((said.match(/trust: the suite runs in a CHILD/g) || []).length, 1, 'printed once per invocation');
});


/* airhorn-zach: the landing-path decision, pinned. The tool is ON-DEMAND ONLY -
 * no gate surface may invoke it as a harness. If this ever goes red, the wiring
 * needs a bead and a measured budget (two browser runs do not fit the fast gate). */
test('no gate surface invokes mutation-check as a harness (airhorn-zach)', () => {
  const surfaces = {
    'tools/fast-gate.sh': /mutation-check/,
    'tools/gate.conf': /^\s*tools\/mutation-check\.mjs\s*=/m,
    'tools/check.conf': /^\s*tools\/mutation-check\.mjs\s*=/m,
    'package.json': /mutation-check/,
  };
  for (const [file, re] of Object.entries(surfaces)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(!re.test(text), `${file} must not wire mutation-check into a gate (airhorn-zach: on-demand only)`);
  }
  // The map may name the tool only as INPUTS to its unit test, never as a suite itself.
  const map = fs.readFileSync(path.join(root, 'tools', 'suite-map.tsv'), 'utf8');
  for (const line of map.split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const cells = line.split('\t');
    // airhorn-vqgp + airhorn-huud: compare via the derive tool's ONE spelling rule -
    // './', './/', 'x/./y', 'x//y', trailing '/', in-tree '..' all normalise; escapes are
    // refused by the validator (they can never name this tool, but they die loudly there).
    const tokens = cells.slice(1).join(' ').split(/\s+/).map((t) => {
      const n = normalizeSuiteToken(t);
      return (n.escape || n.absolute) ? n.raw : n.path;
    });
    assert.ok(!tokens.includes('tools/mutation-check.mjs'),
      `the tool must never be a map's SUITE column (right-hand side, any spelling): ${line}`);
    // airhorn-eff1: an absolute spelling resolves for the gate (double-slash tolerance) -
    // the pin fails on it directly; the validator also refuses it by name.
    const absolutes = cells.slice(1).join(' ').split(/\s+/).filter((t) => t.startsWith('/'));
    assert.deepEqual(absolutes, [], `absolute spellings are refused (airhorn-eff1): ${line}`);
  }
});
