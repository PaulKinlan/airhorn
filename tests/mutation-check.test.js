import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { exportedSameFile } from '../tools/lib/suite-mode-reporter.mjs';
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
    assert.equal(stripped.status, 3, `a suite that strips the handlers then crashes must be never-ran, got ${stripped.status}: ${stripped.stdout}${stripped.stderr}`);
    // Named either way: with the airhorn-p0dg watcher the strip itself is reported at strip
    // time, so this world refuses as report-not-trustworthy (the strip is named) rather than
    // only via the crash's exit code.
    assert.match(stripped.stderr + stripped.stdout, /report-not-trustworthy|exited 1 with no failing test|registered no tests|crashed/i);

    // The rejection path has no monitor, so it is checked by POSITION at exit - which covers the plain prepend and cannot
    // cover a prepended once or a self-removing listener. That boundary is asserted, not glossed: the first is refused, and
    // the second is recorded here as the known residual so nobody reads the trust line as covering it.
    write('k-prepend-rejection-swallow.mjs', "import test from 'node:test';\ntest('one', () => {});\nsetTimeout(() => { process.prependListener('unhandledRejection', () => process.exit(0)); Promise.reject(new Error('swallowed rejection')); }, 5);\n");

    for (const world of ['k-prepend-swallow.mjs', 'k-prepend-once-swallow.mjs', 'k-self-removing-swallow.mjs']) {
      const laundered = runWorld(['--suite', world]);
      assert.equal(laundered.status, 3, `${world} must be a named refusal, got ${laundered.status}: ${laundered.stdout}${laundered.stderr}`);
      assert.match(laundered.stderr + laundered.stdout, /threw-outside-a-test|uncaught exception after the suite loaded/,
        `${world} must be reported as the crash it is (the monitor sees it first), not as a pass`);
    }

    // airhorn-39yh, the two shapes this change closes: (a) patch the record channel so the crash line is never written, and
    // (b) strip the driver's EXIT listeners so the rejection position check never runs. Both scored rc 2 before.
    write('k-patch-channel-swallow.mjs', "import test from 'node:test';\nimport fs from 'node:fs';\ntest('one', () => {});\nsetTimeout(() => { const real = fs.writeSync; fs.writeSync = (...args) => (String(args[1]).includes('crashedOutsideTest') ? 0 : real.apply(fs, args)); process.prependListener('uncaughtException', () => process.exit(0)); throw new Error('swallowed after patching the channel'); }, 5);\n");
    write('k-strip-exit-swallow.mjs', "import test from 'node:test';\ntest('one', () => {});\nsetTimeout(() => { for (const fn of process.listeners('exit')) process.removeListener('exit', fn); process.prependListener('unhandledRejection', () => process.exit(0)); Promise.reject(new Error('swallowed after stripping exit listeners')); }, 5);\n");

    for (const world of ['k-patch-channel-swallow.mjs', 'k-strip-exit-swallow.mjs']) {
      const closed = runWorld(['--suite', world]);
      assert.equal(closed.status, 3, `${world} must be a named refusal, got ${closed.status}: ${closed.stdout}${closed.stderr}`);
    }

    const rejectionLaunder = runWorld(['--suite', 'k-prepend-rejection-swallow.mjs']);
    assert.equal(rejectionLaunder.status, 3, `a prepended rejection swallow must be a named refusal, got ${rejectionLaunder.status}: ${rejectionLaunder.stdout}${rejectionLaunder.stderr}`);
    assert.match(rejectionLaunder.stderr + rejectionLaunder.stdout, /AHEAD of the driver's/,
      'the rejection refusal must name the listener ahead of the driver, since there is no monitor for rejections');

    for (const world of ['h-async-no-test.mjs', 'i-async-decoy.mjs', 'j-indirect-async.mjs']) {
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
    assert.match(asyncCrash.stderr + asyncCrash.stdout, /after the suite loaded/);

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

test('the driver scrubs its record secrets before the suite loads (airhorn-y3d6)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-scrub-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
  // A suite whose ONLY assertion is that the record path and nonce are gone from its
  // environment - if the scrub is removed, this suite fails and the mutant is "caught"
  // for the wrong reason; either way the change cannot pass unnoticed.
  fs.writeFileSync(path.join(tmp, 'suite.test.js'), `
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('record secrets are absent from the suite environment', () => {
  assert.equal(process.env.MUTATION_RUN_NONCE, undefined, 'the suite can see the run nonce');
  assert.equal(process.env.MUTATION_DRIVER_REPORT, undefined, 'a record file path must not exist at all (airhorn-y3d6 round 2: the record travels by stdout now)');
});
`);
  const run = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'suite.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 2,
    `expected the mutant NOT caught (the suite passes: secrets scrubbed) - rc=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
});


test('a forged driver-record line on stdout is DETECTED and refused by name, never scored (airhorn-y3d6 round 2)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-forge-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
  fs.writeFileSync(path.join(tmp, 'suite.test.js'), `
import { test } from 'node:test';
import fs from 'node:fs';
// The atomic-rename forgery of round 1, translated to the channel that exists now: a second
// driver-record line. It cannot suppress the real one, so the sequence must be invalid.
fs.writeSync(1, 'MUTATION-DRIVER-RECORD {"importFailed":false}\\n');
test('a real test that passes', () => {});
`);
  const run = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'suite.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 3,
    `a forged record must be a named refusal (rc 3), never a verdict - rc=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.match(run.stderr, /report-not-trustworthy|forged or broken/);
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
    assert.doesNotMatch(said, /verdict:/, 'an interrupted run scores no verdict');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('SUPPRESSION: strip + swallow-with-exit-0 + crash is refused by name (airhorn-p0dg)', () => {
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
  assert.equal(run.status, 3,
    `a suppressed crash must be a named refusal (rc 3), never fix-does-not-close - rc=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.match(run.stderr, /report-not-trustworthy/);
});

test('SUPPRESSION, the reviewer world: strip AND swallow AND throw in ONE timer callback (airhorn-p0dg round 2)', () => {
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
  assert.equal(run.status, 3,
    `the one-timer suppression must be a named refusal - rc=${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  // airhorn-5qdd: this world strips the uncaughtException LISTENERS, which no longer decides anything - the driver records
  // crashes from 'uncaughtExceptionMonitor', which the strip does not touch, so the crash is now named as the crash it is
  // instead of being inferred from the strip. Both are named refusals; the strip is still what catches a suite that removes
  // the MONITOR (the world below).
  assert.match(run.stderr, /report-not-trustworthy|threw-outside-a-test/);

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
  assert.equal(monitorStrip.status, 3,
    `removing the crash monitor must still be a named refusal - rc=${monitorStrip.status}\nstdout:\n${monitorStrip.stdout}\nstderr:\n${monitorStrip.stderr}`);
  assert.match(monitorStrip.stderr + monitorStrip.stdout, /report-not-trustworthy|handlersStripped|removed the driver/,
    'a suite that removes the monitor must be reported at strip time, not silently swallowed');
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

test('the tool prints its trust boundary (the watcher-first evasion) once per invocation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-p0dg-line-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
  fs.writeFileSync(path.join(tmp, 'suite.test.js'), `
import { test } from 'node:test';
test('passes', () => {});
`);
  const run = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'suite.test.js'], { cwd: tmp, encoding: 'utf8', timeout: 60000 });
  assert.match(run.stdout, /trust: driver records are grammar-checked/);
  assert.match(run.stdout, /removeListener watcher first/, 'the watcher-first evasion must still be named');
  // airhorn-rnj5/5qdd: the line must separate what is seen BY PRECEDENCE (uncaught exceptions, via the monitor), what is seen
  // BY POSITION (rejection listeners, since node has no rejection monitor) and what is not seen at all - a boundary that does
  // not enumerate its own gaps reads as closure.
  assert.match(run.stdout, /uncaughtExceptionMonitor/);
  assert.match(run.stdout, /no rejection monitor/);
  assert.match(run.stdout, /prepended once or self-removing unhandledRejection listener/);
  assert.match(run.stdout, /crash that runs no JS at all/);
  // airhorn-39yh: the reviewer's three shapes, two of which this change CLOSES and one of which remains - the line must name
  // the remaining one (reallyExit) rather than leaving the list looking exhaustive.
  assert.match(run.stdout, /process\.reallyExit\(\)/);
  assert.match(run.stdout, /patches the record write path/);
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
    // airhorn-vqgp: normalise the './' spelling - an exact match let './tools/...' bypass.
    const tokens = cells.slice(1).join(' ').split(/\s+/).map((t) => t.replace(/^\.\//, ''));
    assert.ok(!tokens.includes('tools/mutation-check.mjs'),
      `the tool must never be a map's SUITE column (right-hand side): ${line}`);
  }
});
