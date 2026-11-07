/*
 * airhorn-tp3g. tools/suite-map.tsv is the repo's hottest file (48 of 198 landings touched it) and two
 * cleared branches were aborted by a conflict in it. The architect rejected splitting the map because the
 * gate already UNIONs the file's rows at run time (fast-gate.sh accumulates every matching row; the deriver
 * does the same, pinned by 56dj) - so the shape is right and only the text merge fails.
 *
 * tools/merge-suite-map.mjs is the mechanical answer: union by the map's own key, never by side. This suite
 * pins what makes that safe to trust:
 *   1. the real map is CANONICAL, and normalising it reproduces it BYTE-FOR-BYTE (idempotent, so no lane's
 *      normalise run can churn the file);
 *   2. two conflicting variants union to the full set - nothing dropped, rows sorted by key, byte-stable, and
 *      the same rows whichever side is "ours";
 *   3. @importers rows, ~ pending rows, ! exemptions and a full-script-tier row survive the union as they are;
 *   4. malformed input FAILS LOUDLY (named, non-zero, no file written) instead of being resolved by preference:
 *      a line with no TAB, an empty suite list, whitespace in the pattern, the same key twice with different
 *      content in one file, and an "!" exemption on one side against a real row on the other;
 *   5. .gitattributes really points the file at the driver, and the tool documents the one-time `git config`
 *      a lane needs - because a .gitattributes entry alone does not configure a driver, and an unconfigured
 *      driver silently falls back to a text merge. That difference deserves a test, not a README line.
 *
 * Browser-free: the tool is spawned exactly as a lane would run it.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(root, 'tools', 'merge-suite-map.mjs');
const MAP = path.join(root, 'tools', 'suite-map.tsv');
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { cwd: root, encoding: 'utf8' });
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tp3g-map-'));
const write = (dir, name, text) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
};

test('the real map is canonical, and normalising it reproduces it byte-for-byte', () => {
  const before = fs.readFileSync(MAP);
  const check = run(['--check', MAP]);
  assert.equal(check.status, 0, `the committed map must be canonical: ${check.stderr}`);

  const dir = tmpdir();
  try {
    const copy = write(dir, 'suite-map.tsv', before);
    const first = run(['--normalise', copy]);
    assert.equal(first.status, 0, first.stderr);
    const once = fs.readFileSync(copy);
    assert.equal(sha(once), sha(before), 'normalise must reproduce the committed map byte-for-byte (same sha256)');
    run(['--normalise', copy]);
    assert.equal(sha(fs.readFileSync(copy)), sha(once), 'normalise must be idempotent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two conflicting variants union to the full set, sorted by key and byte-stable', () => {
  const dir = tmpdir();
  try {
    const ours = write(dir, 'ours.tsv', [
      '# the map',
      '',
      '!*.md',
      'tools/a.mjs\ttests/a.test.js',
      '~tests/future.test.mjs\ttests/future.test.mjs',
      '',
    ].join('\n'));
    const theirs = write(dir, 'theirs.tsv', [
      '# the map',
      '',
      '!*.md',
      'tools/b.mjs\ttests/b.test.js tests/b2.test.js',
      'tests/support/helper.mjs\t@importers except=tests/acceptance.mjs',
      'tools/shared.mjs\ttests/a.test.js',
      '',
    ].join('\n'));

    const first = run(['--union', ours, theirs]);
    assert.equal(first.status, 0, first.stderr);
    const second = run(['--union', ours, theirs]);
    assert.equal(second.stdout, first.stdout, 'the same inputs must produce the same bytes every run');

    const rows = first.stdout.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    assert.deepEqual(rows, [
      '!*.md',
      '~tests/future.test.mjs\ttests/future.test.mjs',
      'tests/support/helper.mjs\t@importers except=tests/acceptance.mjs',
      'tools/a.mjs\ttests/a.test.js',
      'tools/b.mjs\ttests/b.test.js tests/b2.test.js',
      'tools/shared.mjs\ttests/a.test.js',
    ], 'every row from both sides survives, sorted by the PATTERN (the key a merge is about), so the order does not depend on the !/~ prefix');

    // Swapping which side is "ours" must not change the ROWS (comment order may follow ours).
    const swapped = run(['--union', theirs, ours]);
    assert.equal(swapped.status, 0, swapped.stderr);
    const swappedRows = swapped.stdout.split('\n').filter((line) => line !== '' && !line.startsWith('#'));
    assert.deepEqual(swappedRows, rows, 'the union of rows is independent of merge order');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a key both sides add is unioned, not chosen between', () => {
  const dir = tmpdir();
  try {
    const ours = write(dir, 'ours.tsv', 'tools/shared.mjs\ttests/a.test.js\n');
    const theirs = write(dir, 'theirs.tsv', 'tools/shared.mjs\ttests/b.test.js\n');
    const result = run(['--union', ours, theirs]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^tools\/shared\.mjs\ttests\/a\.test\.js tests\/b\.test\.js$/m,
      'both suites cover the path, so both are in the row');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The row shapes the live map actually contains, taken from it rather than invented, so a union can never
// quietly "tidy" away the precision the gate depends on (x3f1's reverse check reads @importers rows; pending
// rows declare suites arriving with a sibling branch; the report hook is injected rather than imported, so it
// carries an explicit full-script-tier row).
test('@importers, ~ pending, ! exemption and the report-hook tier row survive a union unchanged', () => {
  const live = fs.readFileSync(MAP, 'utf8').split('\n');
  const fromLive = (prefix, why) => {
    const row = live.find((line) => line.startsWith(prefix));
    assert.ok(row, `the live map must still carry the row this pin needs: ${why}`);
    return row;
  };
  const wanted = [
    fromLive('tests/support/browser.mjs\t@importers', 'an @importers row (the derived set the gate scans at run time)'),
    fromLive('!LICENSE', 'an "!" exemption'),
    fromLive('tests/support/report-hook.mjs\t', 'the runner-injected helper full-script-tier row'),
    // Pending rows are a supported shape whether or not the live map happens to have one today, so this pin
    // states it rather than depending on the map's current contents.
    '~tests/future-suite.test.mjs\ttests/future-suite.test.mjs',
  ];

  const dir = tmpdir();
  try {
    const ours = write(dir, 'ours.tsv', `${wanted.slice(0, 2).join('\n')}\n`);
    const theirs = write(dir, 'theirs.tsv', `${wanted.slice(2).join('\n')}\n`);
    const result = run(['--union', ours, theirs]);
    assert.equal(result.status, 0, result.stderr);
    for (const row of wanted) {
      assert.ok(result.stdout.split('\n').includes(row), `the union must keep this row verbatim: ${row}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed input fails loudly and writes nothing - it is never resolved by preference', () => {
  const cases = [
    ['a line with no TAB', 'tools/a.mjs tests/a.test.js\n', /no TAB and not an "!" exemption/],
    ['an empty suite list', 'tools/a.mjs\t\n', /names no suites/],
    ['whitespace in the pattern', 'tools/a b.mjs\ttests/a.test.js\n', /pattern contains whitespace/],
    ['a row with a double space', 'tools/a.mjs\ttests/a.test.js  tests/b.test.js\n', /double space/],
    ['the same key twice with different content', 'tools/a.mjs\ttests/a.test.js\ntools/a.mjs\ttests/b.test.js\n', /appears twice with different suites/],
  ];
  for (const [name, text, expected] of cases) {
    const dir = tmpdir();
    try {
      const file = write(dir, 'bad.tsv', text);
      const result = run(['--union', file, file]);
      assert.notEqual(result.status, 0, `${name} must fail`);
      assert.match(result.stderr, expected, `${name} must be named, got: ${result.stderr}`);
      assert.match(result.stderr, /bad\.tsv:\d+/, `${name} must name the file and line`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // Two sides that disagree about what a key IS cannot be unioned, and the refusal writes nothing.
  const dir = tmpdir();
  try {
    const ours = write(dir, 'ours.tsv', '!preview/**\n');
    const theirsText = 'preview/**\ttests/preview.test.mjs\n';
    const theirs = write(dir, 'theirs.tsv', theirsText);
    const result = run(['--union', ours, theirs]);
    assert.notEqual(result.status, 0, 'an exemption on one side and a real row on the other must fail');
    assert.match(result.stderr, /differently/, `the refusal must say what disagrees, got: ${result.stderr}`);
    assert.equal(fs.readFileSync(ours, 'utf8'), '!preview/**\n', 'the tool must not have written anything');
    assert.equal(fs.readFileSync(theirs, 'utf8'), theirsText, 'and it must not have written anything on the other side either');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the driver mode writes the union into the ours file and exits 0', () => {
  const dir = tmpdir();
  try {
    const base = write(dir, 'base.tsv', '# the map\n!*.md\ntools/a.mjs\ttests/a.test.js\n');
    const ours = write(dir, 'ours.tsv', '# the map\n!*.md\ntools/a.mjs\ttests/a.test.js\ntools/ours.mjs\ttests/ours.test.js\n');
    const theirs = write(dir, 'theirs.tsv', '# the map\n!*.md\ntools/a.mjs\ttests/a.test.js\ntools/theirs.mjs\ttests/theirs.test.js\n');
    // Keep copies of both sides before the driver overwrites ours, so the result can be compared with the
    // union of the ORIGINAL inputs rather than with a file the driver already rewrote.
    const oursText = fs.readFileSync(ours, 'utf8');
    const theirsText = fs.readFileSync(theirs, 'utf8');

    const result = run(['--driver', base, ours, theirs]);
    assert.equal(result.status, 0, result.stderr);

    const merged = fs.readFileSync(ours, 'utf8');
    assert.match(merged, /^tools\/ours\.mjs\ttests\/ours\.test\.js$/m, 'our row survives');
    assert.match(merged, /^tools\/theirs\.mjs\ttests\/theirs\.test\.js$/m, 'their row survives');

    const oursCopy = write(dir, 'ours-original.tsv', oursText);
    const theirsCopy = write(dir, 'theirs-original.tsv', theirsText);
    const expected = run(['--union', oursCopy, theirsCopy]).stdout;
    assert.equal(merged, expected, 'the driver must write exactly the union of the two sides into the ours file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('.gitattributes points the map at the driver and the tool names the one-time git config', () => {
  const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  assert.match(attributes, /^tools\/suite-map\.tsv merge=suite-map-union$/m,
    'the map must be handed to the union driver');
  assert.match(attributes, /git config merge\.suite-map-union\.driver "node tools\/merge-suite-map\.mjs --driver %O %A %B"/,
    'the file must say the exact one-time config, because an attribute alone configures nothing');
  const tool = fs.readFileSync(TOOL, 'utf8');
  assert.match(tool, /git config merge\.suite-map-union\.driver/, 'the tool documents the same config');
  assert.match(tool, /--union \/tmp\/ours\.tsv \/tmp\/theirs\.tsv --write tools\/suite-map\.tsv/,
    'and the no-config manual path');
  // The contract is derived from the map, so a resolved map with a stale contract fails gate-map. The recipe has
  // to carry both steps or a lane does half the job and meets the same abort it was avoiding.
  assert.match(attributes, /node tools\/derive-coverage-contract\.mjs/,
    'the map recipe must regenerate the derived coverage contract');
  assert.match(tool, /derive-coverage-contract\.mjs/,
    'and the tool must say so too');
});

test('a union reports what it unioned and what it resurrected, so the result is reviewable', () => {
  // airhorn-tp3g names the hazard: a union driver takes both sides of a conflicting hunk, so a row one branch
  // deleted and the other kept comes back. On a coverage map that is over-approximation (extra suites run,
  // nothing false-greens), and it must be SAID, not discovered later.
  const dir = tmpdir();
  try {
    const base = write(dir, 'base.tsv', 'tools/a.mjs\ttests/a.test.js\ntools/shared.mjs\ttests/x.test.js\ntools/deleted.mjs\ttests/gone.test.js\n');
    const ours = write(dir, 'ours.tsv', 'tools/a.mjs\ttests/a.test.js\ntools/shared.mjs\ttests/x.test.js\n');
    const theirs = write(dir, 'theirs.tsv', 'tools/a.mjs\ttests/a.test.js\ntools/shared.mjs\ttests/y.test.js\ntools/deleted.mjs\ttests/gone.test.js\n');

    const result = run(['--driver', base, ours, theirs]);
    assert.equal(result.status, 0, result.stderr);
    // In this fixture THEIRS removed tests/x.test.js (it is in base) and added tests/y.test.js: the two are
    // different facts and the report must not blur them (airhorn-gdtr).
    assert.match(result.stderr, /RESTORED[^\n]*tools\/shared\.mjs \(tests\/x\.test\.js\)/,
      'the token a side deleted and the union kept must be named as restored');
    assert.match(result.stderr, /added suites[^\n]*tools\/shared\.mjs \(tests\/y\.test\.js\)/,
      'the token a side genuinely added must be named as added');
    assert.doesNotMatch(result.stderr, /added suites[^\n]*tools\/a\.mjs/,
      'a row both sides left identical is not reported - the report must be signal, not noise');
    assert.match(result.stderr, /RESURRECTED[^\n]*tools\/deleted\.mjs/,
      'a row deleted on one side and kept by the other must be reported as resurrected');

    const merged = fs.readFileSync(ours, 'utf8');
    assert.match(merged, /^tools\/shared\.mjs\ttests\/x\.test\.js tests\/y\.test\.js$/m, 'both sides suites are unioned');
    assert.match(merged, /^tools\/deleted\.mjs\ttests\/gone\.test\.js$/m, 'and the resurrected row is present, as reported');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// airhorn-gdtr (review finding on airhorn-tp3g). A token deleted on one side is RESTORED by the union - the safe
// direction for a coverage map, but the report claimed "no shared patterns" and named nothing, so the lane
// reviewing the merge could not see that a suite came back. The report now distinguishes an ADDITION (fine) from
// a RESTORATION (over-approximation), and it says which token.
test('a token deleted on one side is reported as RESTORED, whichever side is ours', () => {
  const dir = tmpdir();
  try {
    const base = write(dir, 'base.tsv', 'tools/a.mjs\ttests/1.test.js tests/2.test.js\n');
    const keeper = write(dir, 'keeper.tsv', 'tools/a.mjs\ttests/1.test.js tests/2.test.js\n');

    for (const oursIsKeeper of [true, false]) {
      const remover = write(dir, 'remover.tsv', 'tools/a.mjs\ttests/1.test.js\n');
      const ours = oursIsKeeper ? keeper : remover;
      const theirs = oursIsKeeper ? remover : keeper;
      const result = run(['--driver', base, ours, theirs]);
      assert.equal(result.status, 0, result.stderr);

      assert.equal(fs.readFileSync(ours, 'utf8').trim(), 'tools/a.mjs\ttests/1.test.js tests/2.test.js',
        `${oursIsKeeper ? 'theirs' : 'ours'} deleted a token; the union keeps it (over-approximation, never a false green)`);
      assert.match(result.stderr, /RESTORED[^\n]*tools\/a\.mjs \(tests\/2\.test\.js\)/,
        `the restored token must be NAMED with ours=${oursIsKeeper ? 'keeper' : 'remover'}, got: ${result.stderr}`);
      assert.doesNotMatch(result.stderr, /no pattern appears on both sides/,
        'the pattern IS shared - that message was the lie this finding is about');
      assert.doesNotMatch(result.stderr, /added suites/,
        'a restoration is not an addition; the two must not be blurred together');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a token ADDED on one side is reported as added, not as restored', () => {
  const dir = tmpdir();
  try {
    const base = write(dir, 'base.tsv', 'tools/a.mjs\ttests/1.test.js\n');
    const ours = write(dir, 'ours.tsv', 'tools/a.mjs\ttests/1.test.js\n');
    const theirs = write(dir, 'theirs.tsv', 'tools/a.mjs\ttests/1.test.js tests/2.test.js\n');
    const result = run(['--driver', base, ours, theirs]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /added suites[^\n]*tools\/a\.mjs \(tests\/2\.test\.js\)/, result.stderr);
    assert.doesNotMatch(result.stderr, /RESTORED/, 'an addition must not be reported as a restoration');
    assert.doesNotMatch(result.stderr, /no pattern appears on both sides/, 'the pattern is shared');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// airhorn-fp5q (merger finding on airhorn-tp3g). The recipe lived in .gitattributes and the tool's header, but a
// lane that hits `UU tools/suite-map.tsv` opens THE MAP first, and its header said nothing about the tool.
test('the map header itself tells a lane how to resolve a conflict', () => {
  const header = fs.readFileSync(MAP, 'utf8').split('\n').slice(0, 45).join('\n');
  assert.match(header, /merge-suite-map\.mjs --union/, 'the header carries the union command');
  assert.match(header, /derive-coverage-contract\.mjs/, 'and the regenerate step, or the resolution half-fails');
  assert.match(header, /merge\.suite-map-union\.driver/, 'and the one-time driver config');
  assert.match(header, /Do not hand-merge/i, 'and says plainly not to hand-merge it');
});
