// Pins for the gate.conf tier-block mode of tools/merge-suite-map.mjs (airhorn-09dr). The
// requirements are the parser evidence encoded: distinct keys are order-insensitive
// (fast-gate.sh declared_tier is an exact-match first-hit-wins line scan), so union-by-key is
// safe for appends; a duplicate path with a DIFFERING tier must fail loudly because the
// parser would silently take the first; normalise is idempotent and reproduces today's
// gate.conf byte-for-byte; comments and blank lines survive. The REAL olju collision
// (fleet/olju-xassert @1989000 vs the staged tree feb9417) was resolved with this mode and
// the output pasted on the bead - that proof is ad-hoc because it depends on git history;
// the fixtures here carry the same shapes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'merge-suite-map.mjs');
const run = (args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', timeout: 30000 });
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

const conf = (rows, { comment = '# the pinned runner design lives here\n' } = {}) =>
  `# header\nFAST_GATE_RUNNER="node --test --test-reporter=tap"\n${comment}SUITE_TIERS="\n${rows.join('\n')}\n"\n`;

test('normalise reproduces the real gate.conf byte-for-byte, and twice is a no-op', () => {
  const file = path.join(root, 'tools', 'gate.conf');
  const before = fs.readFileSync(file, 'utf8');
  const check = run(['--tiers-check', file]);
  assert.equal(check.status, 0, `today's gate.conf must be canonical: ${check.stderr}`);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-')), 'gate.conf');
  fs.writeFileSync(tmp, before);
  run(['--tiers-normalise', tmp]);
  const once = fs.readFileSync(tmp, 'utf8');
  assert.equal(sha(once), sha(before), 'normalise must reproduce the real file byte-for-byte (comments and blanks included)');
  run(['--tiers-normalise', tmp]);
  assert.equal(sha(fs.readFileSync(tmp, 'utf8')), sha(once), 'normalise must be idempotent');
});

test('union is order-independent: two orderings of the same rows produce one result', () => {
  const a = conf(['tests/a.test.js=node-test', 'tests/b.test.js=script', 'tests/c.test.js=node-test']);
  const b = conf(['tests/c.test.js=node-test', 'tests/b.test.js=script', 'tests/a.test.js=node-test']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-u-'));
  const fa = path.join(dir, 'a.conf');
  const fb = path.join(dir, 'b.conf');
  fs.writeFileSync(fa, a);
  fs.writeFileSync(fb, b);
  const ab = run(['--tiers-union', fa, fb]);
  const ba = run(['--tiers-union', fb, fa]);
  assert.equal(ab.status, 0, ab.stderr);
  assert.equal(ba.status, 0, ba.stderr);
  assert.equal(ab.stdout, ba.stdout, 'the union must not depend on which side a row came from');
  for (const row of ['tests/a.test.js=node-test', 'tests/b.test.js=script', 'tests/c.test.js=node-test']) {
    assert.ok(ab.stdout.includes(row), `union lost ${row}`);
  }
});

test('a duplicate path with a DIFFERING tier refuses, naming both rows - across sides and within one file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-x-'));
  const ours = path.join(dir, 'ours.conf');
  const theirs = path.join(dir, 'theirs.conf');
  fs.writeFileSync(ours, conf(['tests/a.test.js=script']));
  fs.writeFileSync(theirs, conf(['tests/a.test.js=node-test']));
  const across = run(['--tiers-union', ours, theirs]);
  assert.equal(across.status, 1, 'a cross-side tier disagreement must fail, not pick one');
  assert.match(across.stderr, /tests\/a\.test\.js: tier 'node-test' in .* but 'script' in .* - a suite cannot be two tiers/);

  const dup = path.join(dir, 'dup.conf');
  fs.writeFileSync(dup, conf(['tests/a.test.js=node-test', 'tests/a.test.js=script']));
  const within = run(['--tiers-check', dup]);
  assert.equal(within.status, 1, 'an in-file tier disagreement must fail loudly');
  assert.match(within.stderr, /declared with tier 'script' here but 'node-test'/);
});

test('a duplicate path with the SAME tier is a merge artifact: normalise drops the second copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-d-'));
  const dup = path.join(dir, 'dup.conf');
  fs.writeFileSync(dup, conf(['tests/a.test.js=node-test', 'tests/b.test.js=script', 'tests/a.test.js=node-test']));
  const res = run(['--tiers-normalise', dup]);
  assert.equal(res.status, 0, res.stderr);
  const out = fs.readFileSync(dup, 'utf8');
  assert.equal(out.split('\n').filter((l) => l.startsWith('tests/a.test.js=')).length, 1, 'the identical duplicate is dropped');
  assert.ok(out.includes('tests/b.test.js=script'));
});

test('everything outside the block survives a union verbatim (comments, the runner pin)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-c-'));
  const ours = path.join(dir, 'ours.conf');
  const theirs = path.join(dir, 'theirs.conf');
  fs.writeFileSync(ours, conf(['tests/a.test.js=node-test'], { comment: '# the z4cn rationale comment\n' }));
  fs.writeFileSync(theirs, conf(['tests/b.test.js=script']));
  const res = run(['--tiers-union', ours, theirs]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('# the z4cn rationale comment'), 'a comment outside the block must survive');
  assert.ok(res.stdout.includes('FAST_GATE_RUNNER="node --test --test-reporter=tap"'), 'the runner pin must survive');
});
