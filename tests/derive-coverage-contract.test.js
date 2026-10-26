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
  const parsed = JSON.parse(res.stdout);
  assert.ok(parsed['src/horn.js']);
  assert.ok(parsed['src/main.js']);
});

test('validateSuiteMap returns zero_match_glob for glob matching zero files (airhorn-onz0)', () => {
  const tsv = 'src/*.nonexistent-review.js\ttests/horn.test.js\n';
  const violations = validateSuiteMap(tsv, { root });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'zero_match_glob');
  assert.equal(violations[0].token, 'src/*.nonexistent-review.js');
  assert.ok(violations[0].message.includes('src/*.nonexistent-review.js'));
});

test('validateSuiteMap returns missing_literal for nonexistent literal path (airhorn-onz0)', () => {
  const tsv = 'src/does-not-exist.js\ttests/horn.test.js\n';
  const violations = validateSuiteMap(tsv, { root });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'missing_literal');
  assert.equal(violations[0].token, 'src/does-not-exist.js');
  assert.ok(violations[0].message.includes('src/does-not-exist.js'));
});

test('validateSuiteMap returns glob_suite_token when suite token has wildcards (airhorn-onz0)', () => {
  const tsv = 'src/horn.js\tsrc/*.bad.js\n';
  const violations = validateSuiteMap(tsv, { root });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'glob_suite_token');
  assert.equal(violations[0].token, 'src/*.bad.js');
  assert.ok(violations[0].message.includes('src/*.bad.js'));
});

test('validateSuiteMap returns missing_suite when suite does not exist (airhorn-onz0)', () => {
  const tsv = 'src/horn.js\ttests/missing.test.js\n';
  const violations = validateSuiteMap(tsv, { root });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'missing_suite');
  assert.equal(violations[0].token, 'tests/missing.test.js');
  assert.ok(violations[0].message.includes('tests/missing.test.js'));
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
  assert.ok(failViolations[0].message.includes('src/[xy]orn.js'));
});
