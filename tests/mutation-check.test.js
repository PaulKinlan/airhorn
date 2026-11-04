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
  classifyPair,
  classifyRecheck,
  suitePresenceProblem,
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

test('a test file is refused as a mutation target', () => {
  assert.match(mutationTargetProblem('tests/multitab.test.mjs'), /TEST file/);
  assert.match(mutationTargetProblem('./tests/x.mjs'), /TEST file/);
  assert.equal(mutationTargetProblem('src/badge.js'), null);
  assert.equal(mutationTargetProblem('tests/x.mjs', { allowTestMutation: true }), null);
});

test('a suite that is not on disk is refused by name, before anything runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-presence-'));
  try {
    assert.match(suitePresenceProblem('nope.test.mjs', dir), /does not exist/);
    fs.writeFileSync(path.join(dir, 'here.test.mjs'), '');
    assert.equal(suitePresenceProblem('here.test.mjs', dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --- classification is the COMPARISON of two runs, not a reading of one -------- */

test('the run pair: caught needs a passing control and a failing mutant', () => {
  assert.deepEqual(classifyPair({ control: { rc: 0 }, mutant: { rc: 1 } }), { mode: 'caught', rc: 1 });
  assert.equal(classifyPair({ control: { rc: 0 }, mutant: { rc: 0 } }).mode, 'passed');
});

test('the run pair: a suite that fails the UNMUTATED source measured nothing', () => {
  const failed = classifyPair({ control: { rc: 3 }, mutant: { rc: 3 } });
  assert.equal(failed.mode, 'never-ran');
  assert.match(failed.problem, /does not pass on the UNMUTATED source/);
  // The decisive case: the mutant run failed too, and that must NOT be a green.
  assert.notEqual(classifyPair({ control: { rc: 1 }, mutant: { rc: 1 } }).mode, 'caught');
});

test('the run pair: a hang on either side is never a caught mutant', () => {
  assert.equal(classifyPair({ control: { rc: 1, timedOut: true }, mutant: { rc: 1, timedOut: true } }).mode, 'never-ran');
  assert.equal(classifyPair({ control: { rc: 0 }, mutant: { rc: 1, timedOut: true } }).mode, 'never-ran');
});

test('the run pair refuses to classify when a side is missing', () => {
  assert.equal(classifyPair({ control: { rc: 0 }, mutant: null }).mode, 'never-ran');
});

test('a catch must be reproducible: the restored source has to pass again', () => {
  assert.equal(classifyRecheck({ recheck: { rc: 0 } }).mode, 'reproduced');
  const flaky = classifyRecheck({ recheck: { rc: 1 } });
  assert.equal(flaky.mode, 'never-ran');
  assert.match(flaky.problem, /not deterministic/);
  assert.equal(classifyRecheck({ recheck: { rc: 1, timedOut: true } }).mode, 'never-ran');
  assert.equal(classifyRecheck({ recheck: null }).mode, 'never-ran');
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

/* --- end to end, in a throwaway tree -----------------------------------------
 *
 * Every world below is a real `node --test` run of a real suite against a real mutant.
 * The subject is `export const answer = 41;` and the mutation is 41 -> 42, so "the suite
 * catches it" means "the suite notices 42".
 *
 * The worlds that used to be scored as FALSE GREENS are here on purpose, and each one is
 * a shape a reviewer actually used to defeat an earlier version of this tool:
 *   - a decoy comment              (airhorn-u1v2)
 *   - an indirect node:test import (airhorn-u1v2)
 *   - a directory-qualified path   (airhorn-lnme)
 *   - an async throw after load    (airhorn-so88)
 *   - stripped crash handlers      (airhorn-a6ch)
 *   - a forged report + odd exit   (airhorn-gwcm)
 */

function world(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-check-'));
  writeAll(dir, { 'src/subject.js': 'export const answer = 41;\n', ...files });
  return dir;
}

function writeAll(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
}

function check(dir, args, extra = []) {
  const result = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', args.shift(), ...args, ...extra], {
    cwd: dir,
    encoding: 'utf8',
  });
  return result;
}

const NODE_TEST_SUITE = [
  "import test from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { answer } from './src/subject.js';",
  "test('the answer is the documented value', () => { assert.equal(answer, 41); });",
].join('\n');

test('a real assertion failure is caught, and the source is restored byte for byte', () => {
  const dir = world({ 'suite.test.mjs': NODE_TEST_SUITE });
  try {
    const before = fs.readFileSync(path.join(dir, 'src', 'subject.js'), 'utf8');
    const result = check(dir, ['suite.test.mjs']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /verdict: mutant-caught/);
    assert.match(result.stdout, /control: suite\.test\.mjs against the unmutated src\/subject\.js/);
    assert.match(result.stdout, /restored src\/subject\.js: verified/);
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'subject.js'), 'utf8'), before, 'the original is back, byte for byte');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a decoy comment naming node:test changes nothing - the invariance is the assertion', () => {
  const decoy = `// from "node:test"\n${NODE_TEST_SUITE}\n// require('node:test') and a comment are not a measurement\n`;
  for (const body of [NODE_TEST_SUITE, decoy]) {
    const dir = world({ 'suite.test.mjs': body });
    try {
      const result = check(dir, ['suite.test.mjs']);
      assert.equal(result.status, 0, `comment or no comment, the verdict is the same: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /verdict: mutant-caught/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('a throw while loading, through a DIRECT import, is refused as unmeasured', () => {
  const dir = world({
    'setup.mjs': "throw new Error('boom while booting');\n",
    'suite.test.mjs': "import './setup.mjs';\n" + NODE_TEST_SUITE,
  });
  try {
    const result = check(dir, ['suite.test.mjs']);
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stderr, /does not pass on the UNMUTATED source/);
    assert.doesNotMatch(result.stdout, /verdict: mutant-caught/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an INDIRECT node:test import with a crashing setup is refused, whatever the path spelling', () => {
  // The exact shape that defeated the basename classifier (airhorn-lnme): the suite is one
  // directory down and reaches node:test through a helper.
  const files = {
    'sub/helper.mjs': "export { default as test } from 'node:test';\n",
    'sub/setup.mjs': "throw new Error('boom while booting');\n",
    'sub/suite.mjs': "import './setup.mjs';\nimport { test } from './helper.mjs';\ntest('never reached', () => {});\n",
  };
  for (const suite of ['sub/suite.mjs', './sub/suite.mjs', 'sub/suite.mjs'.replace('sub/', 'sub//')]) {
    const dir = world(files);
    try {
      const result = check(dir, [suite]);
      assert.equal(result.status, 3, `${suite}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /did not pass on the UNMUTATED source|does not pass on the UNMUTATED source/);
      assert.doesNotMatch(result.stdout, /verdict: mutant-caught/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the decoy comment on a crashing suite changes nothing, and a passing suite is never "caught"', () => {
  const crashing = {
    'setup.mjs': "throw new Error('boom while booting');\n",
    'with-comment.test.mjs': "// from \"node:test\"\nimport './setup.mjs';\n" + NODE_TEST_SUITE,
    'without-comment.test.mjs': "import './setup.mjs';\n" + NODE_TEST_SUITE,
    'passes.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from './src/subject.js';\n// from \"node:test\"\ntest('only checks the type', () => { assert.equal(typeof answer, 'number'); });\n",
  };
  const seen = {};
  for (const suite of ['with-comment.test.mjs', 'without-comment.test.mjs', 'passes.test.mjs']) {
    const dir = world(crashing);
    try {
      const result = check(dir, [suite]);
      seen[suite] = result.status;
      if (suite === 'passes.test.mjs') {
        assert.equal(result.status, 2, `a suite that passes the mutant is fix-does-not-close: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /verdict: fix-does-not-close/);
      } else {
        assert.equal(result.status, 3, `${suite}: ${result.stdout}${result.stderr}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  assert.equal(seen['with-comment.test.mjs'], seen['without-comment.test.mjs'], 'the comment must not move the verdict');
});

test('an async throw AFTER a clean load is refused, not scored as a caught mutant (airhorn-so88)', () => {
  const dir = world({
    'async-crash.test.mjs': [
      "import test from 'node:test';",
      "import { answer } from './src/subject.js';",
      "test('reads the subject', () => { if (answer === 42) throw new Error('mutant'); });",
      "setImmediate(() => { throw new Error('async boot failure'); });",
    ].join('\n'),
  });
  try {
    const result = check(dir, ['async-crash.test.mjs']);
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /verdict: mutant-caught/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stripping the crash handlers cannot buy a caught mutant (airhorn-a6ch)', () => {
  // The suite never fails a test - it crashes asynchronously. The old tool counted the
  // runner's file-level wrapper event as the failing test and printed "mutant-caught".
  const body = (strip) => [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { answer } from './src/subject.js';",
    ...(strip ? ["process.removeAllListeners('uncaughtException');", "process.removeAllListeners('unhandledRejection');", "process.on('uncaughtException', () => process.exit(0));"] : []),
    "test('only checks the type', () => { assert.equal(typeof answer, 'number'); });",
    "setImmediate(() => { throw new Error('async boot failure'); });",
  ].join('\n');
  const dir = world({ 'plain-crash.test.mjs': body(false), 'handler-strip.test.mjs': body(true) });
  try {
    const plain = check(dir, ['plain-crash.test.mjs']);
    assert.equal(plain.status, 3, `the crash fails the control run: ${plain.stdout}${plain.stderr}`);
    const stripped = check(dir, ['handler-strip.test.mjs']);
    assert.notEqual(stripped.status, 0, `a suite that swallows its own crash measured nothing: ${stripped.stdout}${stripped.stderr}`);
    assert.doesNotMatch(stripped.stdout, /verdict: mutant-caught/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a forged report file or a hand-picked exit code cannot buy a green (airhorn-gwcm)', () => {
  // The old tool read a report file the suite itself wrote. Nothing writes anything now:
  // the verdict is the difference between two exits, so a forged report is inert and a
  // suite that exits 0 without running a test simply does not catch the mutant.
  const forged = (rc) => [
    "import fs from 'node:fs';",
    "fs.writeFileSync(process.env.MUTATION_SUITE_REPORT || 'report.json', JSON.stringify({ driver: { importFailed: false }, realTests: 1, realFailed: 1, failing: ['x'] }));",
    `process.exit(${rc});`,
  ].join('\n');
  const dir = world({ 'forged-zero.test.mjs': forged(0), 'forged-two.test.mjs': forged(2) });
  try {
    const zero = check(dir, ['forged-zero.test.mjs']);
    assert.equal(zero.status, 2, `a suite that runs nothing does not catch the mutant: ${zero.stdout}${zero.stderr}`);
    assert.match(zero.stdout, /verdict: fix-does-not-close/);
    const two = check(dir, ['forged-two.test.mjs']);
    assert.equal(two.status, 3, `a suite that fails the unmutated source measured nothing: ${two.stdout}${two.stderr}`);
    assert.doesNotMatch(two.stdout, /verdict: mutant-caught/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a zero-test suite is fix-does-not-close, never a false green (airhorn-3wth)', () => {
  const dir = world({ 'empty.test.mjs': "// nothing registered, nothing asserted\n" });
  try {
    const result = check(dir, ['empty.test.mjs']);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout, /verdict: fix-does-not-close/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a script suite is judged the same way, with or without --suite-mode script', () => {
  const dir = world({
    'script.mjs': "import { answer } from './src/subject.js';\nif (answer !== 41) throw new Error(`expected 41, saw ${answer}`);\n",
  });
  try {
    for (const extra of [[], ['--suite-mode', 'script']]) {
      const result = check(dir, ['script.mjs'], extra);
      assert.equal(result.status, 0, `${extra.join(' ') || 'default'}: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /verdict: mutant-caught/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a suite that hangs is refused under --timeout-ms instead of being called a catch', () => {
  const dir = world({ 'hangs.test.mjs': "import test from 'node:test';\ntest('never ends', () => new Promise(() => {}));\n" });
  try {
    const result = check(dir, ['hangs.test.mjs'], ['--timeout-ms', '500']);
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.match(result.stderr, /did not finish|timeout/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--dry-run runs the control and mutates NOTHING (airhorn-lpgh)', () => {
  const dir = world({ 'suite.test.mjs': NODE_TEST_SUITE });
  try {
    const before = fs.readFileSync(path.join(dir, 'src', 'subject.js'), 'utf8');
    const result = check(dir, ['suite.test.mjs'], ['--dry-run']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /--dry-run, so nothing was mutated/);
    assert.doesNotMatch(result.stdout, /mutant applied/);
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'subject.js'), 'utf8'), before, 'the file was never touched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a suite that is not deterministic is refused, not called a caught mutant', () => {
  // Fails on its SECOND run: control passes, the mutant run fails (a false catch), and the
  // re-check - which runs against the restored source - fails again. Nothing was measured.
  const dir = world({
    'flaky.test.mjs': [
      "import fs from 'node:fs';",
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "const counter = new URL('./runs.txt', import.meta.url);",
      "const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;",
      "fs.writeFileSync(counter, String(seen + 1));",
      "test('only passes the first time', () => { assert.equal(seen, 0, `run ${seen + 1} fails`); });",
    ].join('\n'),
  });
  try {
    const result = check(dir, ['flaky.test.mjs']);
    assert.equal(result.status, 3, `a flaky suite cannot prove a catch: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /not deterministic/);
    assert.doesNotMatch(result.stdout, /verdict: mutant-caught/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--build: every phase is built from the source it measures, so the catch is real and no mutant bytes are left in dist/ (airhorn-br28)', () => {
  // The suite reads dist/, so a run that is not rebuilt for the phase it measures is
  // measuring stale bytes. Before the fix the re-check ran against the MUTANT build and a
  // genuine catch was refused as "not deterministic".
  const files = {
    'dist/product.js': 'export const answer = 41;\n',
    'distsuite.test.mjs': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { answer } from './dist/product.js';",
      "test('dist says 41', () => { assert.equal(answer, 41); });",
    ].join('\n'),
  };
  const dir = world(files);
  try {
    const build = 'cp src/subject.js dist/product.js';
    const first = check(dir, ['distsuite.test.mjs', '--build', build]);
    assert.equal(first.status, 0, `a catch against a rebuilt dist is a catch: ${first.stdout}${first.stderr}`);
    assert.match(first.stdout, /verdict: mutant-caught/);
    assert.match(first.stdout, /build \(restored\)/, 'the restore is followed by a build from the restored source');
    assert.equal(fs.readFileSync(path.join(dir, 'dist', 'product.js'), 'utf8'), 'export const answer = 41;\n', 'dist/ holds the restored build, not the mutant');
    // The decisive part: run it again immediately. Before the fix the leftover mutant build
    // made the NEXT invocation refuse its own control run.
    const second = check(dir, ['distsuite.test.mjs', '--build', build]);
    assert.equal(second.status, 0, `a second check is not poisoned by the first: ${second.stdout}${second.stderr}`);
    assert.match(second.stdout, /verdict: mutant-caught/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--suite-old gets its own control, so a crashed OLD suite is refused instead of reading as not-reproducible', () => {
  const dir = world({
    'suite.test.mjs': NODE_TEST_SUITE,
    'broken-old.test.mjs': "import './missing-module.mjs';\n",
  });
  try {
    const result = check(dir, ['suite.test.mjs', '--suite-old', 'broken-old.test.mjs']);
    assert.equal(result.status, 3, `an OLD suite that cannot run is not a baseline: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /OLD suite .* does not pass the unmutated/);
    assert.doesNotMatch(result.stdout, /verdict: not-reproducible/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an interrupt between the write and the restore exits 130/143 and scores no verdict (airhorn-rf0u round 2)', async () => {
  // The round-1 handler was dead code: spawnSync blocked the event loop, so a SIGTERM during
  // a run was ignored and the check could go on to print "verdict: mutant-caught". This is the
  // reviewer's shape - the run would otherwise END IN A CATCH, so a green here proves the
  // signal was swallowed. The child processes are asynchronous for exactly this reason.
  const slowSuite = [
    "import fs from 'node:fs';",
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "const body = fs.readFileSync(new URL('./dist/product.js', import.meta.url), 'utf8');",
    "test('dist says 41', async () => { await new Promise((r) => setTimeout(r, 1200)); assert.equal(body.includes('42'), false, 'dist carries the mutant'); });",
  ].join('\n');
  const dir = world({ 'dist/product.js': 'export const answer = 41;\n', 'slow.test.mjs': slowSuite });
  const subject = path.join(dir, 'src', 'subject.js');
  const dist = path.join(dir, 'dist', 'product.js');
  const original = fs.readFileSync(subject, 'utf8');
  const { spawn } = await import('node:child_process');
  try {
    const child = spawn(process.execPath, [tool, '--file', 'src/subject.js', '--from', '41', '--to', '42', '--suite', 'slow.test.mjs', '--build', 'cp src/subject.js dist/product.js', '--timeout-ms', '30000'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    // Interrupt only once BOTH artefacts hold the mutant: the source and the build output.
    const deadline = Date.now() + 20000;
    let both = false;
    while (Date.now() < deadline) {
      const srcMutated = fs.readFileSync(subject, 'utf8') !== original;
      const distMutated = fs.existsSync(dist) && fs.readFileSync(dist, 'utf8') !== original;
      if (srcMutated && distMutated) {
        both = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(both, true, `the mutant is on disk (source and build output) before the signal: ${out}`);
    child.kill('SIGTERM');
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 143, `SIGTERM exits 143, not a verdict: ${out}${err}`);
    assert.match(err, /interrupted by SIGTERM - no verdict was scored/);
    assert.doesNotMatch(out, /verdict:/, 'a cancelled check scores nothing');
    assert.equal(out.match(/restored src\/subject\.js/g)?.length, 1, `exactly one restore, not a race: ${out}`);
    assert.equal(fs.readFileSync(subject, 'utf8'), original, 'the interrupted run leaves the original, byte for byte');
    assert.equal(fs.readFileSync(dist, 'utf8'), original, 'and rebuilds dist/ from the restored source');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--build on a REFUSAL path still rebuilds from the restored source: dist/ never keeps the mutant (airhorn-br28 round 2)', () => {
  // The reviewer's adversarial shape: the mutant run times out, so the tool refuses from
  // inside the try block. Before the fix the restored build sat after the try, so every
  // early refusal returned past it and left the MUTANT build in dist/.
  const hangOn42 = [
    "import fs from 'node:fs';",
    "import test from 'node:test';",
    "const body = fs.readFileSync(new URL('./dist/product.js', import.meta.url), 'utf8');",
    "test('hangs only when dist carries the mutant', async () => { if (body.includes('42')) await new Promise(() => {}); });",
  ].join('\n');
  const dir = world({ 'dist/product.js': 'export const answer = 41;\n', 'hangs.test.mjs': hangOn42 });
  const dist = path.join(dir, 'dist', 'product.js');
  try {
    const result = check(dir, ['hangs.test.mjs', '--build', 'cp src/subject.js dist/product.js', '--timeout-ms', '1500']);
    assert.equal(result.status, 3, `the mutant run times out, so the check is refused: ${result.stdout}${result.stderr}`);
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'subject.js'), 'utf8'), 'export const answer = 41;\n', 'the source is restored');
    assert.equal(fs.readFileSync(dist, 'utf8'), 'export const answer = 41;\n', 'and dist/ is rebuilt from the restored source, not left holding the mutant');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the tool refuses a mutation that does not apply, and touches nothing', () => {
  const dir = world({ 'suite.test.mjs': NODE_TEST_SUITE });
  try {
    const before = fs.readFileSync(path.join(dir, 'src', 'subject.js'), 'utf8');
    const result = spawnSync(process.execPath, [tool, '--file', 'src/subject.js', '--from', 'nothing like this', '--to', '42', '--suite', 'suite.test.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /does not occur/);
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'subject.js'), 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the tool refuses to mutate a test file, because that proves nothing about the product', () => {
  const dir = world({ 'suite.test.mjs': NODE_TEST_SUITE });
  try {
    writeAll(dir, { 'tests/thing.test.mjs': 'export const answer = 41;\n' });
    const result = spawnSync(process.execPath, [tool, '--file', 'tests/thing.test.mjs', '--from', '41', '--to', '42', '--suite', 'suite.test.mjs'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /TEST file/);
    assert.match(fs.readFileSync(path.join(dir, 'tests', 'thing.test.mjs'), 'utf8'), /41/, 'the test file is untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--suite-old separates hole-proven from not-reproducible', () => {
  const dir = world({
    'suite.test.mjs': NODE_TEST_SUITE,
    'old-suite.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from './src/subject.js';\ntest('old: accepts anything', () => { assert.equal(typeof answer, 'number'); });\n",
  });
  try {
    const result = check(dir, ['suite.test.mjs', '--suite-old', 'old-suite.test.mjs']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /verdict: hole-proven/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
