import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyMutation,
  mutationApplied,
  mutationTargetProblem,
  restoreVerified,
  suiteLoadProblem,
  suitePresenceProblem,
  suiteUsesNodeTest,
  verdictFor,
} from '../tools/mutation-check.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'mutation-check.mjs');

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
  // tool can be driven through a full run without a browser or a build.
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
      tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'suite.mjs',
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

// airhorn-ba6d: a node:test suite whose IMPORT throws exits non-zero, which the tool used to
// read as "the suite fails the mutant". Marker matching missed it (a plain `throw new Error
// ("boom")` matches none of them), so the failure MODE is recorded instead: a hook exits 97
// when something is thrown outside a test, and that reserves the verdict "nothing measured".
test('a node:test suite is run with the never-ran guard; a script suite is not', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suiteguard-'));
  try {
    fs.writeFileSync(path.join(tmp, 'unit.test.js'), "import test from 'node:test';\ntest('x', () => {});\n");
    fs.writeFileSync(path.join(tmp, 'script.mjs'), "import assert from 'node:assert';\nassert.equal(1, 1);\n");
    assert.equal(suiteUsesNodeTest('unit.test.js', tmp), true);
    assert.equal(suiteUsesNodeTest('script.mjs', tmp), false,
      'a script suite throws AT TOP LEVEL when it fails, so it must keep normal exit-code semantics');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an import-time throw is refused as unmeasured, while a real failure still catches the mutant', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ba6d-'));
  try {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'subject.js'), 'export const answer = 41;\n');
    fs.writeFileSync(path.join(tmp, 'setup.mjs'), "throw new Error('boom');\n");
    // the reviewer's repro: the suite file exists, imports fine as text, and dies at load
    fs.writeFileSync(path.join(tmp, 'suite.mjs'), 'import "./setup.mjs";\nimport test from "node:test";\ntest("x", () => {});\n');
    // the negative control: a suite that really runs and asserts the pre-mutation value
    fs.writeFileSync(path.join(tmp, 'catches.mjs'), 'import test from "node:test";\nimport assert from "node:assert";\nimport { answer } from "./src/subject.js";\ntest("answer", () => assert.equal(answer, 41));\n');
    // and a script suite, whose top-level throw IS a failure and must stay one
    fs.writeFileSync(path.join(tmp, 'script.mjs'), 'import assert from "node:assert";\nconst answer = 42;\nassert.equal(answer, 41);\n');

    const never = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'suite.mjs'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(never.status, 3, `an import-time throw must exit 3 (got ${never.status}): ${never.stdout}${never.stderr}`);
    assert.match(never.stderr + never.stdout, /threw outside any test|nothing was measured/);

    const real = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'catches.mjs'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(real.status, 0, `a real catching suite must still prove the hole (got ${real.status}): ${real.stdout}${real.stderr}`);
    assert.match(real.stdout, /verdict: mutant-caught/);

    const script = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'script.mjs'], { cwd: tmp, encoding: 'utf8' });
    assert.equal(script.status, 0, `a failing SCRIPT suite must stay a caught mutant (got ${script.status}): ${script.stdout}${script.stderr}`);
    assert.match(script.stdout, /verdict: mutant-caught/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
