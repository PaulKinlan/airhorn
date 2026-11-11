import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  main as deriveContractMain,
  deriveCoverageContract,
  formatCoverageContract,
  deriveMapOpinion,
  extractPendingSuites,
  validateSuiteMap,
  globToRegex,
  globMatchesAny,
  suiteFiles, normalizeSuiteToken,
  importersOf,
} from '../tools/derive-coverage-contract.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'derive-coverage-contract.mjs');

test('deriveCoverageContract parses basic rows and skips comments/empty lines', () => {
  const tsv = `
# Comment line
src/foo.js\ttests/foo.test.js

src/bar.js\ttests/bar.test.js
`;
  const contract = deriveCoverageContract(tsv);
  assert.deepEqual(contract, {
    'src/foo.js': ['tests/foo.test.js'],
    'src/bar.js': ['tests/bar.test.js'],
  });
});

test('deriveCoverageContract filters pending test/ spellings and deduplicates', () => {
  const tsv = `
src/foo.js\ttests/foo.test.js test/foo.test.js tests/foo.test.js tests/extra.test.mjs
`;
  const contract = deriveCoverageContract(tsv);
  assert.deepEqual(contract, {
    'src/foo.js': ['tests/foo.test.js', 'tests/extra.test.mjs'],
  });
});

test('deriveCoverageContract ignores ! exemptions and ~ pending declarations', () => {
  const tsv = `
!*.md
!LICENSE
~test/pending.test.js\ttest/pending.test.js
src/foo.js\ttests/foo.test.js
`;
  const contract = deriveCoverageContract(tsv);
  assert.deepEqual(contract, {
    'src/foo.js': ['tests/foo.test.js'],
  });
});

test('deriveCoverageContract includes alternate test/ suite once it lands on disk (airhorn-u42y)', () => {
  const tsv = `
~test/a11y.test.mjs\ttest/a11y.test.mjs
src/horn.js\ttests/horn.test.js test/a11y.test.mjs
`;
  // While absent on disk, pending suite is omitted:
  const withoutLanded = deriveCoverageContract(tsv, { existsFn: () => false });
  assert.deepEqual(withoutLanded['src/horn.js'], ['tests/horn.test.js']);

  // Once landed on disk, pending suite becomes active and is included:
  const withLanded = deriveCoverageContract(tsv, { existsFn: (p) => p === 'test/a11y.test.mjs' });
  assert.deepEqual(withLanded['src/horn.js'], ['tests/horn.test.js', 'test/a11y.test.mjs']);
});

test('deriveCoverageContract ignores ~ declared plural pending suites while absent (airhorn-x0xr)', () => {
  const tsv = `
~tests/newsuite.test.mjs\ttests/newsuite.test.mjs
src/foo.js\ttests/newsuite.test.mjs tests/foo.test.js
`;
  const contract = deriveCoverageContract(tsv, { existsFn: () => false });
  assert.deepEqual(contract, {
    'src/foo.js': ['tests/foo.test.js'],
  });
});

test('deriveCoverageContract handles multiple tabs in row (airhorn-x0xr)', () => {
  const tsv = `
src/foo.js\ttests/a.test.js\ttests/b.test.js
`;
  const contract = deriveCoverageContract(tsv, { existsFn: () => true });
  assert.deepEqual(contract, {
    'src/foo.js': ['tests/a.test.js', 'tests/b.test.js'],
  });
});

test('extractPendingSuites handles multiple tabs in ~ row (airhorn-56dj)', () => {
  const tsv = `
~tests/a.test.js\ttests/a.test.js\ttests/b.test.js
`;
  const pending = extractPendingSuites(tsv);
  assert.ok(pending.has('tests/a.test.js'));
  assert.ok(pending.has('tests/b.test.js'));
});

test('deriveCoverageContract handles self-row that also names pending suite (airhorn-56dj)', () => {
  const tsv = `
src/extra.js\tsrc/extra.js test/notyet.test.mjs
`;
  const contract = deriveCoverageContract(tsv, { existsFn: () => false });
  assert.equal(contract['src/extra.js'], undefined);
});

test('deriveMapOpinion returns Map with normalized wildcard keys (airhorn-56dj)', () => {
  const tsv = `
tools/lib/**\ttests/test-support.test.js
`;
  const opinion = deriveMapOpinion(tsv);
  assert.ok(opinion.has('tools/lib/*'));
  assert.deepEqual(opinion.get('tools/lib/*'), new Set(['tests/test-support.test.js']));
});

test('deriveCoverageContract ignores self-rows', () => {
  const tsv = `
tests/horn.test.js\ttests/horn.test.js
src/horn.js\ttests/horn.test.js
`;
  const contract = deriveCoverageContract(tsv);
  assert.deepEqual(contract, {
    'src/horn.js': ['tests/horn.test.js'],
  });
});

test('the deriver declares only what the map declares: no synthesised self-rows (airhorn-xh81)', () => {
  // The self-MAP (a suite runs itself when it changes) is a gate rule derived from the TREE - it is not
  // a row the map carries and not an entry the contract invents. Both halves are pinned here, because
  // a synthesis would be invisible in a diff of the map and a reader could no longer tell what was
  // declared from what was made up (the state airhorn-xh81 was filed about):
  //   1. a map naming nothing derives an EMPTY contract, even though this tree is full of suites;
  //   2. a suite whose row is deleted does NOT reappear in the contract by itself.
  assert.deepEqual(deriveCoverageContract('', { root }), {},
    'an empty map must derive an empty contract - the tree\'s suites are not synthesised into it');
  const map = fs.readFileSync(path.join(root, 'tools', 'suite-map.tsv'), 'utf8');
  const suite = 'tests/horn.test.js';
  assert.ok(!map.split('\n').some((line) => line.startsWith(`${suite}\t`)),
    'fixture check: the map must carry no row keyed by this suite, so the case below is the no-row case');
  const declared = deriveCoverageContract('src/elsewhere.js\ttests/a11y.test.mjs\n', { root });
  assert.equal(declared[suite], undefined,
    'the deriver must never add a self-row entry of its own - the gate derives that, the map does not');
  // And the real contract carries no self-row entry today (0 of 62 at airhorn-xh81).
  const committed = JSON.parse(fs.readFileSync(path.join(root, '.fleet', 'coverage-contract.json'), 'utf8'));
  const selfish = Object.entries(committed).filter(([p, suites]) => suites.length === 1 && suites[0] === p);
  assert.deepEqual(selfish, [],
    'the contract must not restate the self-mapping of a suite - the oracle reads that as drift (airhorn-x4l)');
});

test('deriveCoverageContract accumulates multiple rows for the same pattern additively', () => {
  const tsv = `
src/foo.js\ttests/a.test.js
src/foo.js\ttests/b.test.js tests/a.test.js
`;
  const contract = deriveCoverageContract(tsv);
  assert.deepEqual(contract, {
    'src/foo.js': ['tests/a.test.js', 'tests/b.test.js'],
  });
});

test('formatCoverageContract formats with 1-space indentation and trailing newline', () => {
  const contract = { 'a.js': ['tests/a.test.js'] };
  const formatted = formatCoverageContract(contract);
  assert.equal(formatted, '{\n "a.js": [\n  "tests/a.test.js"\n ]\n}\n');
});

test('CLI --stdout outputs formatted JSON to stdout', () => {
  const res = spawnSync(process.execPath, [tool, '--stdout'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  // The output must BE the committed contract, not merely contain a key: a truthiness
  // check passes when src/horn.js maps to [] (empty arrays are truthy) or to a broken
  // suite (the tests/ sweep, g0qr #14). .fleet/coverage-contract.json is the reviewed
  // artifact --check holds the derivation to; --stdout must print it byte for byte.
  // P3a (from g0qr.11 review): a bare assert.equal on two ~200-line strings dumps a
  // Node string diff on failure. Name the first differing line and the remedy instead.
  const committed = fs.readFileSync(path.join(root, '.fleet', 'coverage-contract.json'), 'utf8');
  if (res.stdout !== committed) {
    const got = res.stdout.split('\n');
    const want = committed.split('\n');
    const firstDiff = got.findIndex((line, i) => line !== want[i]);
    assert.fail(`--stdout drifted from .fleet/coverage-contract.json, first differing line ${firstDiff + 1}: derived ${JSON.stringify(got[firstDiff])} vs committed ${JSON.stringify(want[firstDiff])} - regenerate with \`node tools/derive-coverage-contract.mjs\` (or fix tools/suite-map.tsv if the drift is unintended)`);
  }
  // And the keys the old assertion named must be there with real rows, so a regression
  // in WHICH sources are covered is named, not hidden in a diff dump.
  const parsed = JSON.parse(res.stdout);
  // Content, not truthiness (airhorn-g0qr.11): assert.ok(parsed[...]) accepts an
  // EMPTY array or a wrong suite list - the contract could stop covering horn.js
  // and this test still passed. Pinned to the map rows (suite-map.tsv:28, :41)
  // minus the '~'-pending test/ dual-spellings, which derivation drops while
  // pending; if a row changes, this pin changes with it, deliberately.
  assert.deepStrictEqual(parsed['src/horn.js'], ['tests/horn.test.js', 'tests/a11y.test.mjs', 'tests/shortcuts.test.mjs'],
    'src/horn.js must select exactly the suites its map row names (pending test/ spellings dropped)');
  assert.deepStrictEqual(parsed['src/main.js'], ['tests/modules.test.js', 'tests/resilience-ui.test.mjs', 'tests/webmcp-browser.test.mjs'],
    'src/main.js must select exactly the suites its map row names (pending test/ spellings dropped)');
});

test('validateSuiteMap returns zero_match_glob for glob matching zero files (airhorn-onz0)', () => {
  const tsv = 'src/*.nonexistent-review.js\ttests/horn.test.js\n';
  const violations = validateSuiteMap(tsv, { root });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'zero_match_glob');
  assert.equal(violations[0].token, 'src/*.nonexistent-review.js');
  assert.ok(violations[0].message.includes('src/*.nonexistent-review.js'), 'the message names the offending token');
  assert.match(violations[0].message, /matches zero files on disk/,
    'the message names the failure MODE: a message that merely restates the token must not pass (g0qr map #24)');
});

test('a glob counts a FILE, never a symlink to a directory or a symlink loop (airhorn-nxuv.21)', (t) => {
  // The glob walk matched by NAME alone for any dirent that was not a directory, and
  // withFileTypes reports a symlink as a symlink - so `onlyalias/*.js` matched a symlink
  // pointing at an empty directory, and a symlink LOOP matched itself. Both validated
  // clean while selecting nothing. The name match now has to be confirmed by the same
  // presence predicate a literal path uses (defaultFileIsRegular: isFile, follows
  // symlinks). The four worlds are pinned so the fix cannot be swapped for a blanket
  // "refuse symlinks", which would fail an honest layout that links to a real file.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'airhorn-glob-'));
  try {
    try {
      fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
      fs.writeFileSync(path.join(fixture, 'src/index.js'), 'x\n');
      fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(fixture, 'tests/ok.test.js'), 'x\n');
      fs.mkdirSync(path.join(fixture, 'empty'));
      fs.mkdirSync(path.join(fixture, 'onlyalias'));
      fs.symlinkSync('../empty', path.join(fixture, 'onlyalias/alias.js'));
      fs.mkdirSync(path.join(fixture, 'loopdir'));
      fs.symlinkSync('self.js', path.join(fixture, 'loopdir/self.js'));
      fs.mkdirSync(path.join(fixture, 'linkdir'));
      fs.symlinkSync('../src/index.js', path.join(fixture, 'linkdir/real-link.js'));
      fs.mkdirSync(path.join(fixture, 'dirs/sub.js'), { recursive: true });
      fs.writeFileSync(path.join(fixture, 'dirs/other.txt'), 'x\n');
    } catch (err) {
      t.skip(`this filesystem cannot create the symlinks this case needs: ${err.message}`);
      return;
    }
    // Present on disk, but NOT a file: the glob must report zero matches.
    const violationsFor = (pattern) => validateSuiteMap(`${pattern}\ttests/ok.test.js\n`, { root: fixture });
    for (const [pattern, why] of [
      ['onlyalias/*.js', 'a symlink to an empty directory'],
      ['loopdir/*.js', 'a symlink loop'],
      ['dirs/*.js', 'a directory whose name matches the glob'],
    ]) {
      const violations = violationsFor(pattern);
      assert.equal(violations.length, 1,
        `${pattern} (${why}) must be a violation, got ${JSON.stringify(violations)}`);
      assert.equal(violations[0].type, 'zero_match_glob',
        `${pattern} (${why}) must read as zero_match_glob, got ${violations[0].type}`);
    }
    // Present AND a file: a real file and a symlink to a real file both match.
    for (const [pattern, why] of [
      ['src/*.js', 'a real file'],
      ['linkdir/*.js', 'a symlink to a real file'],
    ]) {
      assert.deepEqual(violationsFor(pattern), [],
        `${pattern} (${why}) must select something, got ${JSON.stringify(violationsFor(pattern))}`);
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('the EXPORTED globMatchesAny default is the regular-file predicate too (airhorn-xs2m)', (t) => {
  // The walk fix above ran inside the validator, which injects defaultFileIsRegular. The
  // exported helper's OWN default was still fs.existsSync, so a direct caller of
  // globMatchesAny() - the documented "does this glob match a file" checker - still said
  // true for a symlink to a directory. That is the same false green, one caller further
  // out, and the review of this branch filed it as a P2 with a live probe.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'airhorn-glob-default-'));
  try {
    try {
      fs.mkdirSync(path.join(fixture, 'empty'));
      fs.mkdirSync(path.join(fixture, 'aliases'));
      fs.symlinkSync('../empty', path.join(fixture, 'aliases/faux.js'));
      fs.writeFileSync(path.join(fixture, 'aliases/real.js'), 'x\n');
    } catch (err) {
      t.skip(`this filesystem cannot create the symlink this case needs: ${err.message}`);
      return;
    }
    // No predicate supplied: the default must already be file-only.
    assert.equal(globMatchesAny('aliases/*.js', { root: fixture }), true,
      'a directory containing a real file must match');
    assert.equal(globMatchesAny('aliases/nope.js', { root: fixture }), false,
      'a literal that does not exist must not match');
    fs.rmSync(path.join(fixture, 'aliases/real.js'));
    assert.equal(globMatchesAny('aliases/*.js', { root: fixture }), false,
      'with only a symlink to an empty directory left, the default must report no match');
    assert.equal(globMatchesAny('empty', { root: fixture }), false,
      'a literal directory is not a file either');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('validateSuiteMap returns missing_literal for nonexistent literal path (airhorn-onz0)', () => {
  const tsv = 'src/does-not-exist.js\ttests/horn.test.js\n';
  const violations = validateSuiteMap(tsv, { root });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'missing_literal');
  assert.equal(violations[0].token, 'src/does-not-exist.js');
  assert.ok(violations[0].message.includes('src/does-not-exist.js'), 'the message names the offending token');
  assert.match(violations[0].message, /(does not exist|is not a regular file) on disk/,
    'the message names the failure MODE: a message that merely restates the token must not pass (g0qr.21). Either wording: master says "does not exist", the cc chain says "is not a regular file ... (missing from disk)" - both name the mode');
});

test('validateSuiteMap returns glob_suite_token when suite token has wildcards (airhorn-onz0)', () => {
  const tsv = 'src/horn.js\tsrc/*.bad.js\n';
  const violations = validateSuiteMap(tsv, { root });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'glob_suite_token');
  assert.equal(violations[0].token, 'src/*.bad.js');
  assert.ok(violations[0].message.includes('src/*.bad.js'), 'the message names the offending token');
  assert.match(violations[0].message, /wildcard metacharacters/,
    'the message names the failure MODE: a message that merely restates the token must not pass (g0qr map #24)');
  assert.match(violations[0].message, /referenced by src\/horn\.js/, 'the message names the referencing source row');
});

test('validateSuiteMap returns missing_suite when suite does not exist (airhorn-onz0)', () => {
  const tsv = 'src/horn.js\ttests/missing.test.js\n';
  const violations = validateSuiteMap(tsv, { root });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'missing_suite');
  assert.equal(violations[0].token, 'tests/missing.test.js');
  assert.ok(violations[0].message.includes('tests/missing.test.js'), 'the message names the offending token');
  assert.match(violations[0].message, /(does not exist|is not a regular file) on disk/,
    'the message names the failure MODE: a message that merely restates the token must not pass (g0qr.21). Either wording: master says "does not exist", the cc chain says "is not a regular file ... (missing from disk)" - both name the mode');
  assert.match(violations[0].message, /referenced by src\/horn\.js/, 'the message names the referencing source row');
});

test('validateSuiteMap returns [] for valid map rows (airhorn-onz0)', () => {
  const tsv = `
src/horn.js\ttests/horn.test.js
tools/*\ttests/horn.test.js
!*.md
~test/a11y.test.mjs\ttest/a11y.test.mjs
`;
  const violations = validateSuiteMap(tsv, { root });
  assert.deepEqual(violations, []);
});

test('CLI --validate-map exits 0 on valid suite map (airhorn-onz0)', () => {
  const res = spawnSync(process.execPath, [tool, '--validate-map'], { encoding: 'utf8' });
  assert.equal(res.status, 0, `expected --validate-map to pass on clean map, got: ${res.stderr}`);
});

test('derive-coverage-contract.mjs --check exits nonzero and names pattern for zero-match glob (airhorn-onz0)', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-check-glob-'));
  const err = [];
  const realError = console.error;
  try {
    fs.mkdirSync(path.join(tempRoot, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, '.fleet'), { recursive: true });
    const corruptedTsv = 'src/*.nonexistent-review.js\ttests/horn.test.js\n';
    fs.writeFileSync(path.join(tempRoot, 'tools', 'suite-map.tsv'), corruptedTsv);
    // Write matching regenerated contract to prove integrity check fires regardless of contract sync
    fs.writeFileSync(path.join(tempRoot, '.fleet', 'coverage-contract.json'), '{\n "src/*.nonexistent-review.js": [\n  "tests/horn.test.js"\n ]\n}\n');
    const opts = { root: tempRoot, existsFn: (rel) => fs.existsSync(path.join(root, rel)) };

    console.error = (...args) => { err.push(args.join(' ')); };
    try {
      const exitCode = deriveContractMain(['--check'], opts);
      assert.equal(exitCode, 1, 'derive-coverage-contract.mjs --check must exit nonzero for zero-match glob');
      assert.ok(
        err.some((line) => line.includes('src/*.nonexistent-review.js')),
        `the guard must name the zero-match pattern in the failure; it logged: ${err.join(' | ')}`
      );
    } finally {
      console.error = realError;
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('derive-coverage-contract.mjs --check exits nonzero and names pattern for nonexistent literal path (airhorn-onz0)', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-check-literal-'));
  const err = [];
  const realError = console.error;
  try {
    fs.mkdirSync(path.join(tempRoot, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, '.fleet'), { recursive: true });
    const corruptedTsv = 'src/does-not-exist.js\ttests/horn.test.js\n';
    fs.writeFileSync(path.join(tempRoot, 'tools', 'suite-map.tsv'), corruptedTsv);
    // Write matching regenerated contract to prove integrity check fires regardless of contract sync
    fs.writeFileSync(path.join(tempRoot, '.fleet', 'coverage-contract.json'), '{\n "src/does-not-exist.js": [\n  "tests/horn.test.js"\n ]\n}\n');
    const opts = { root: tempRoot, existsFn: (rel) => fs.existsSync(path.join(root, rel)) };

    console.error = (...args) => { err.push(args.join(' ')); };
    try {
      const exitCode = deriveContractMain(['--check'], opts);
      assert.equal(exitCode, 1, 'derive-coverage-contract.mjs --check must exit nonzero for nonexistent literal path');
      assert.ok(
        err.some((line) => line.includes('src/does-not-exist.js')),
        `the guard must name the nonexistent literal path in the failure; it logged: ${err.join(' | ')}`
      );
    } finally {
      console.error = realError;
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('main([--validate-map], { root }) fails when root lacks mapped directory (airhorn-onz0)', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'validator-root-'));
  const err = [];
  const realError = console.error;
  try {
    fs.mkdirSync(path.join(tempRoot, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'tests', 'horn.test.js'), '// test\n');
    fs.writeFileSync(path.join(tempRoot, 'tools', 'suite-map.tsv'), 'src/*.js\ttests/horn.test.js\n');
    // tempRoot deliberately lacks src/ directory!
    console.error = (...args) => { err.push(args.join(' ')); };
    try {
      const exitCode = deriveContractMain(['--validate-map'], { root: tempRoot });
      assert.notEqual(exitCode, 0, 'main([--validate-map], {root}) must exit != 0 when root lacks src/');
      assert.ok(
        err.some((line) => line.includes('src/*.js')),
        `the failure must name the pattern; logged: ${err.join(' | ')}`
      );
      assert.ok(
        err.some((line) => line.includes('zero_match_glob')),
        `the failure must be zero_match_glob; logged: ${err.join(' | ')}`
      );
    } finally {
      console.error = realError;
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('main([--validate-map], { root }) passes with real checkout root (airhorn-onz0)', () => {
  const exitCode = deriveContractMain(['--validate-map'], { root });
  assert.equal(exitCode, 0, 'main([--validate-map], {root}) must return 0 on real checkout root');
});

test('validateSuiteMap supports bracket/character-class globs (airhorn-onz0)', () => {
  // src/horn.js exists in repo root, so src/[hm]orn.js must pass
  const passTsv = 'src/[hm]orn.js\ttests/horn.test.js\n';
  const passViolations = validateSuiteMap(passTsv, { root });
  assert.deepEqual(passViolations, [], 'expected src/[hm]orn.js to pass when src/horn.js exists');

  // Neither src/xorn.js nor src/yorn.js exists in repo root, so src/[xy]orn.js must fail
  const failTsv = 'src/[xy]orn.js\ttests/horn.test.js\n';
  const failViolations = validateSuiteMap(failTsv, { root });
  assert.equal(failViolations.length, 1);
  assert.equal(failViolations[0].type, 'zero_match_glob');
  assert.equal(failViolations[0].token, 'src/[xy]orn.js');
  assert.ok(failViolations[0].message.includes('src/[xy]orn.js'), 'the message names the offending token');
  assert.match(failViolations[0].message, /matches zero files on disk/,
    'the message names the failure MODE: a message that merely restates the token must not pass (same genre as g0qr map #24)');
});


test('an unreadable DIRECTORY fails the suite scan naming it; a MISSING one is legitimate (airhorn-31ep)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-scan-'));
  try {
    fs.mkdirSync(path.join(tmp, 'tests', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'tests', 'readable.test.js'), '// fine\n');
    fs.writeFileSync(path.join(tmp, 'tests', 'nested', 'hidden.test.js'), '// hidden\n');
    fs.chmodSync(path.join(tmp, 'tests', 'nested'), 0o000);
    // The reviewer's repro: the subtree must not vanish silently.
    assert.throws(
      () => suiteFiles('src/horn.js	tests/readable.test.js\n', { root: tmp }),
      /could not read directory 'tests\/nested'/,
      'an unreadable directory must fail the scan naming it, not drop the subtree');
    fs.chmodSync(path.join(tmp, 'tests', 'nested'), 0o700);
    // A root with no tests/ at all is a legitimate absence: quiet, empty.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'walk-empty-'));
    try {
      assert.deepEqual(suiteFiles('src/horn.js	tests/readable.test.js\n', { root: empty }), [],
        'a missing tests/ directory is a root without tests, not a failure');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    fs.chmodSync(path.join(tmp, 'tests', 'nested'), 0o700);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


/* airhorn-huud: the ONE spelling rule. The enumeration table below is the DELIVERABLE -
 * every spelling fs resolves to the same file normalises; every spelling that climbs out
 * is refused. Pinned as data so a future 'simplification' of the normaliser fails by name. */
test('normalizeSuiteToken: variants normalise, escapes refuse (airhorn-huud)', () => {
  const VARIANTS = ['tools/x.mjs', './tools/x.mjs', './/tools/x.mjs', 'tools/./x.mjs', 'tools//x.mjs', 'tools/x.mjs/', 'tests/../tools/x.mjs'];
  for (const v of VARIANTS) {
    assert.deepEqual(normalizeSuiteToken(v), { path: 'tools/x.mjs' }, `${v} is a naming variant and must normalise`);
  }
  const ESCAPES = ['../tools/x.mjs', './../x.mjs', 'tools/../../etc/x', '..'];
  for (const e of ESCAPES) {
    assert.equal(normalizeSuiteToken(e).escape, true, `${e} climbs out of the tree and must be REFUSED, not normalised`);
  }
  // airhorn-eff1: absolute spellings are a third refused class - posix.normalize keeps them
  // absolute, and the gate would run them via double-slash tolerance.
  for (const a of ['/tools/x.mjs', '//tools/x.mjs']) {
    assert.equal(normalizeSuiteToken(a).absolute, true, `${a} is absolute and must be REFUSED, not normalised`);
  }
});

test('the map validator refuses an absolute-spelled path BY NAME (airhorn-eff1)', () => {
  const tsv = '/tools/real.mjs\ttests/real.test.js\n';
  const violations = validateSuiteMap(tsv, { existsFn: () => true });
  const absolutes = violations.filter((v) => v.type === 'absolute');
  assert.equal(absolutes.length, 1, 'the absolute spelling is refused: ' + JSON.stringify(violations));
  assert.match(absolutes[0].message, /path is absolute.*real\.mjs/, 'the refusal names the path');
});

test('the map validator refuses an escape-spelled path BY NAME (airhorn-huud)', () => {
  const tsv = 'tests/../tools/real.mjs\ttests/real.test.js\n../outside.mjs\ttests/real.test.js\n';
  const violations = validateSuiteMap(tsv, { existsFn: () => true });
  const escapes = violations.filter((v) => v.type === 'escape');
  assert.equal(escapes.length, 1, 'in-tree .. is a variant (normalises); only the true escape is refused: ' + JSON.stringify(violations));
  assert.match(escapes[0].message, /escapes the tree.*outside\.mjs/, 'the refusal names the escaping path');
});

test('an unreadable LISTED suite fails the @importers derivation, named (tools/ sweep row 4)', () => {
  // The silent continue used to drop the suite from the row and report coverage it never scanned.
  // The reachable shape is the walk finding the file (it exists and is regular) while the READ fails
  // (a permission flip or a transient IO error), so that pair is injected directly in a temp root.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-scan-'));
  try {
    fs.mkdirSync(path.join(tmp, 'tests'));
    fs.writeFileSync(path.join(tmp, 'tests', 'unreadable.test.js'), '// present but unreadable\n');
    fs.chmodSync(path.join(tmp, 'tests', 'unreadable.test.js'), 0o000);
    const tsv = 'src/horn.js\ttests/unreadable.test.js\n';
    assert.throws(
      () => importersOf('src/horn.js', { root: tmp, tsvText: tsv }),
      /could not read listed suite 'tests\/unreadable\.test\.js'/,
      'an unreadable listed suite must fail the derivation naming it, not vanish from the scan');
  } finally {
    fs.chmodSync(path.join(tmp, 'tests', 'unreadable.test.js'), 0o600);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
