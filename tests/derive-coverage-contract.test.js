import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveCoverageContract, formatCoverageContract } from '../tools/derive-coverage-contract.mjs';

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
