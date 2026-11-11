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
  assert.match(tool, /--union \/tmp\/ours\.tsv \/tmp\/theirs\.tsv \/tmp\/base\.tsv --write tools\/suite-map\.tsv/,
    'and the no-config manual path, with the merge BASE - a union without it cannot express a deletion (airhorn-famo)');
  assert.match(tool, /git show :1:tools\/suite-map\.tsv > \/tmp\/base\.tsv/,
    'the recipe must say where the base comes from, or a lane cannot follow it');
  // The contract is derived from the map, so a resolved map with a stale contract fails gate-map. The recipe has
  // to carry both steps or a lane does half the job and meets the same abort it was avoiding.
  assert.match(attributes, /node tools\/derive-coverage-contract\.mjs/,
    'the map recipe must regenerate the derived coverage contract');
  assert.match(tool, /derive-coverage-contract\.mjs/,
    'and the tool must say so too');
});

test('a union reports what it unioned and what a side DELETED - a deletion is respected, not resurrected', () => {
  // airhorn-famo. The hazard airhorn-tp3g named was that a union driver takes both sides of a conflicting hunk,
  // so a row one branch deleted and the other kept came BACK - exit 0, looking like a clean merge, over a map
  // whose author had deliberately retired it. With a base the merge is three-way, so a deletion is a DELETION;
  // the token case below stays over-approximated (an extra suite costs time, never a false green) and is named.
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
    assert.match(result.stderr, /DELETED rows[^\n]*tools\/deleted\.mjs \(deleted by ours\)/,
      'a row one side deleted must be reported as DELETED, naming the side that removed it');
    assert.doesNotMatch(result.stderr, /RESURRECTED/, 'nothing is resurrected out of a base any more - that was the bug');

    const merged = fs.readFileSync(ours, 'utf8');
    assert.match(merged, /^tools\/shared\.mjs\ttests\/x\.test\.js tests\/y\.test\.js$/m, 'both sides suites are unioned');
    assert.doesNotMatch(merged, /^tools\/deleted\.mjs/m,
      'the deleted row must be GONE from the result - putting it back silently inverts the branch that retired it');
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
  // airhorn-nn8g: without the `git add` the recipe leaves the index unmerged and `git merge --continue` refuses -
  // a resolution the lane cannot finish is not a resolution.
  assert.match(header, /git add tools\/suite-map\.tsv \.fleet\/coverage-contract\.json/,
    'and ends with the git add that actually stages the resolution, both files');
  // airhorn-famo: a recipe without the merge base silently resurrects every row the branch deleted, so the header
  // a lane reads first has to hand it the base too.
  assert.match(header, /git show :1:tools\/suite-map\.tsv > \/tmp\/base\.tsv/,
    'and says where the merge BASE comes from - without it a DELETION cannot be expressed');
  assert.match(header, /--union \/tmp\/ours\.tsv \/tmp\/theirs\.tsv \/tmp\/base\.tsv/,
    'and passes that base to the tool');
});

// ---------------------------------------------------------------- airhorn-famo: deletions are real
// The bead: fleet/impl-rows deleted 47 tautological self-rows (airhorn-xh81) and a rebase put ALL of them back,
// exit 0, "merged by key ... (118 rows)". Union is additive, so "ours has the row, theirs deleted it" was
// indistinguishable from "theirs never had it". These pins hold the three-way behaviour that replaced it.

test('a row one side deleted is DELETED, whichever side is ours (the airhorn-xh81 shape)', () => {
  const dir = tmpdir();
  try {
    const baseText = [
      'tests/aa.test.mjs\ttests/aa.test.mjs',
      'tests/bb.test.mjs\ttests/bb.test.mjs',
      'tools/x.mjs\ttests/x.test.js',
      '',
    ].join('\n');
    // ours = the branch that retired the tautologies; theirs = a branch that meanwhile added a row.
    const adding = `${baseText}tools/y.mjs\ttests/y.test.js\n`;
    const retired = ['tools/x.mjs\ttests/x.test.js', ''].join('\n');
    for (const oursRetired of [true, false]) {
      const base = write(dir, 'base.tsv', baseText);
      const retiring = write(dir, 'retired.tsv', retired);
      const added = write(dir, 'added.tsv', adding);
      const ours = oursRetired ? retiring : added;
      const theirs = oursRetired ? added : retiring;
      const result = run(['--driver', base, ours, theirs]);
      assert.equal(result.status, 0, result.stderr);
      const merged = fs.readFileSync(ours, 'utf8');
      assert.doesNotMatch(merged, /aa\.test\.mjs|bb\.test\.mjs/,
        `the deleted self-rows must stay deleted (ours retired: ${oursRetired}) - resurrecting them inverts the branch's whole intent`);
      assert.match(merged, /^tools\/x\.mjs\ttests\/x\.test\.js$/m, 'rows neither side touched survive');
      assert.match(merged, /^tools\/y\.mjs\ttests\/y\.test\.js$/m, 'and an ADDITION from the other side is still unioned in');
      assert.match(result.stderr, /DELETED rows[^\n]*tests\/aa\.test\.mjs[^\n]*tests\/bb\.test\.mjs/,
        'the deletions must be named, not silent');
      assert.match(result.stderr, new RegExp(`deleted by ${oursRetired ? 'ours' : 'theirs'}`),
        'and they must name the side that removed them');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a row both sides deleted is dropped without a report - the deletion is already unanimous', () => {
  const dir = tmpdir();
  try {
    const base = write(dir, 'base.tsv', 'tools/gone.mjs\ttests/gone.test.js\ntools/x.mjs\ttests/x.test.js\n');
    const ours = write(dir, 'ours.tsv', 'tools/x.mjs\ttests/x.test.js\n');
    const theirs = write(dir, 'theirs.tsv', 'tools/x.mjs\ttests/x.test.js\n');
    const result = run(['--driver', base, ours, theirs]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(ours, 'utf8'), 'tools/x.mjs\ttests/x.test.js\n', 'both deleted it, so it is gone');
    assert.doesNotMatch(result.stderr, /DELETED rows|gone\.test\.js/, 'and there is nothing to report: no side disagrees');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a row deleted on one side and CHANGED on the other refuses by name and writes nothing', () => {
  // Three-way text merges call this a conflict, and so does this tool: dropping the modified row loses their
  // suites, keeping it reverts our deletion, so it takes a human - loudly, never quietly.
  const dir = tmpdir();
  try {
    const baseText = 'tools/k.mjs\ttests/k.test.js\n';
    const oursText = 'tools/other.mjs\ttests/other.test.js\n';
    const theirsText = 'tools/k.mjs\ttests/k.test.js tests/k2.test.js\ntools/other.mjs\ttests/other.test.js\n';
    const base = write(dir, 'base.tsv', baseText);
    const ours = write(dir, 'ours.tsv', oursText);
    const theirs = write(dir, 'theirs.tsv', theirsText);
    const result = run(['--driver', base, ours, theirs]);
    assert.notEqual(result.status, 0, 'delete/modify must not be resolved by preference');
    assert.match(result.stderr, /tools\/k\.mjs[^\n]*DELETED on one side and CHANGED on the other/, result.stderr);
    assert.equal(fs.readFileSync(ours, 'utf8'), oursText, 'the refusal must leave the ours file untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--union without a base keeps one-side-only rows but REFUSES a one-side-only self-row', () => {
  // Without the common ancestor an addition and a deletion are the same picture, so the tool keeps the row and
  // says so - but a self-row is the airhorn-xh81 trap, and there it refuses instead of handing back a map with a
  // branch's deletion silently reversed. With the base it deletes the row, which is the manual recipe.
  const dir = tmpdir();
  try {
    const selfRow = 'tests/zz.test.mjs\ttests/zz.test.mjs\n';
    const ours = write(dir, 'ours.tsv', `${selfRow}tools/x.mjs\ttests/x.test.js\n`);
    const theirs = write(dir, 'theirs.tsv', 'tools/x.mjs\ttests/x.test.js\n');
    const out = path.join(dir, 'out.tsv');
    const refused = run(['--union', ours, theirs, '--write', out]);
    assert.notEqual(refused.status, 0, 'a one-side-only self-row without a base must refuse');
    assert.match(refused.stderr, /self-row the other lacks[^\n]*tests\/zz\.test\.mjs/, refused.stderr);
    assert.match(refused.stderr, /git show :1:/, 'and it must say how to supply the base');
    assert.equal(fs.existsSync(out), false, 'nothing may be written when it refuses');

    const base = write(dir, 'base.tsv', `${selfRow}tools/x.mjs\ttests/x.test.js\n`);
    const resolved = run(['--union', ours, theirs, base, '--write', out]);
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), 'tools/x.mjs\ttests/x.test.js\n',
      'with the base the retired self-row is deleted by the manual path too');
    assert.match(resolved.stderr, /DELETED rows[^\n]*tests\/zz\.test\.mjs/, 'and the deletion is reported');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--union without a base keeps both sides new rows and names them as one-side-only', () => {
  // The ordinary collision is two branches adding rows for different files: both are right, the union keeps
  // both, and the report says which rows it could not classify so a lane reviewing the merge can see them.
  const dir = tmpdir();
  try {
    const ours = write(dir, 'ours.tsv', 'tools/x.mjs\ttests/x.test.js\ntools/new-a.mjs\ttests/a.test.js\n');
    const theirs = write(dir, 'theirs.tsv', 'tools/x.mjs\ttests/x.test.js\ntools/new-b.mjs\ttests/b.test.js\n');
    const result = run(['--union', ours, theirs]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^tools\/new-a\.mjs\ttests\/a\.test\.js$/m, 'a row only ours has is kept');
    assert.match(result.stdout, /^tools\/new-b\.mjs\ttests\/b\.test\.js$/m, 'and so is one only theirs has');
    assert.match(result.stderr, /rows on ONE side only[^\n]*tools\/new-a\.mjs[^\n]*tools\/new-b\.mjs/, result.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a comment block one side deleted stays deleted (airhorn-tcdb), and a comment theirs adds is kept', () => {
  // airhorn-m85h moved the map's prose into docs/coverage-map.md; a union driver then put 207 of those lines back
  // on a rebase. Prose is a deletion like any other, so the base decides - while a comment the OTHER side added
  // is still an addition and must not be lost.
  const dir = tmpdir();
  try {
    const base = write(dir, 'base.tsv', [
      '# the map',
      '# why: prose that moved to docs/coverage-map.md',
      'tools/x.mjs\ttests/x.test.js',
      '',
    ].join('\n'));
    const ours = write(dir, 'ours.tsv', ['# the map', 'tools/x.mjs\ttests/x.test.js', ''].join('\n'));
    const theirs = write(dir, 'theirs.tsv', [
      '# the map',
      '# why: prose that moved to docs/coverage-map.md',
      '# why: added by theirs',
      'tools/x.mjs\ttests/x.test.js',
      'tools/y.mjs\ttests/y.test.js',
      '',
    ].join('\n'));
    const result = run(['--driver', base, ours, theirs]);
    assert.equal(result.status, 0, result.stderr);
    const merged = fs.readFileSync(ours, 'utf8');
    assert.doesNotMatch(merged, /prose that moved to docs/, 'the returned prose must not come back');
    assert.match(merged, /^# why: added by theirs$/m, "but a comment only theirs added is an addition and stays");
    assert.match(merged, /^# the map$/m, 'and the shared header survives exactly once');
    assert.equal(merged.match(/^# the map$/gm).length, 1, 'a raw line both sides keep appears once');
    assert.match(result.stderr, /deleted comment\/blank lines[^\n]*prose that moved to docs/, 'and the deletion is named');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
