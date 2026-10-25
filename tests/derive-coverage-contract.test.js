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
