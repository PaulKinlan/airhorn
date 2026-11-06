#!/usr/bin/env node
/*
 * tools/merge-suite-map.mjs - the mechanical answer to a tools/suite-map.tsv collision (airhorn-tp3g).
 *
 * WHY THIS EXISTS. tools/suite-map.tsv is the repo's hottest file: 48 of 198 landings touched it, and two
 * cleared branches were aborted by a conflict in it on 2026-11-06. The conflict is NOT a disagreement about
 * coverage - the map is already a SET that the gate UNIONs at run time (fast-gate.sh accumulates every
 * matching row, and the deriver does the same), so two branches adding rows for different files are both
 * right and only the text merge fails. The architect rejected splitting the file for exactly that reason
 * (airhorn-09dr): the shape is right, the merge is the problem.
 *
 * So this tool merges by the map's own key and never picks a side:
 *
 *   node tools/merge-suite-map.mjs --normalise [<file>]
 *       Canonicalise one map in place (default tools/suite-map.tsv). The canonical form is the file as it is
 *       today: comments and blank lines verbatim where they are, rows in their order, single spaces inside a
 *       suite list, one trailing newline. It is IDEMPOTENT and it reproduces today's file byte-for-byte
 *       (tests/suite-map-merge.test.js pins that against the real file).
 *
 *   node tools/merge-suite-map.mjs --check [<file>]
 *       Writes nothing; exits 1 if the file is not canonical, naming the command to fix it.
 *
 *   node tools/merge-suite-map.mjs --union <ours> <theirs> [--write <file>]
 *       Union two variants by key, sorted by key, and print (or write) the result. Suite lists are unioned
 *       with ours' order first; a key present in one side only is kept as-is, so no row is ever dropped.
 *
 *   node tools/merge-suite-map.mjs --driver <base> <ours> <theirs>
 *       Git merge-driver shape (the %O %A %B arguments): writes the union into <ours> and exits 0. On
 *       malformed input it exits 1 with a named message and writes nothing, which leaves the conflict in
 *       place for a human - a loud conflict, never a quiet wrong answer.
 *
 * RESOLVING A CONFLICT without configuring anything (the primary path - works in every clone):
 *   git show :2:tools/suite-map.tsv > /tmp/ours.tsv     # our side of the conflict
 *   git show :3:tools/suite-map.tsv > /tmp/theirs.tsv   # their side
 *   node tools/merge-suite-map.mjs --union /tmp/ours.tsv /tmp/theirs.tsv --write tools/suite-map.tsv
 *   git add tools/suite-map.tsv
 *
 * OR let git call it (opt-in, once per clone). A .gitattributes entry alone does NOT configure a driver -
 * git cannot read a driver from the repository, for good reason - so without this `git config` the ordinary
 * text merge runs and conflicts loudly, which is the safe failure, not a silent no-op:
 *   git config merge.suite-map-union.driver "node tools/merge-suite-map.mjs --driver %O %A %B"
 *   git config merge.suite-map-union.name "union tools/suite-map.tsv by key"
 *
 * WHAT IT WILL NOT DO. It never chooses between two different meanings for one key: a key that is an `!`
 * exemption on one side and a real row on the other, a row with no suite list, a pattern containing
 * whitespace, a non-comment line with no TAB, or the same key twice inside one file all FAIL LOUDLY with
 * file:line and the key. Gate semantics are untouched: this only writes the map, and only ever writes what
 * the gate already unions at run time.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAP = path.join(HERE, 'suite-map.tsv');

const die = (message) => {
  process.stderr.write(`merge-suite-map: ${message}\n`);
  process.exit(1);
};

// One row: raw (comment/blank, kept verbatim), exemption (`!pattern`, no TAB, no suites), or a keyed row
// (`pattern<TAB>tokens...`). `tokens` keeps file order.
const parse = (text, label) => {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();   // the trailing newline is re-emitted
  const rows = [];
  const seen = new Map();   // pattern -> { kind, line, text }  (a pattern has ONE meaning in one file)
  const kindOf = (key) => (key.startsWith('!') ? 'exemption' : key.startsWith('~') ? 'pending' : 'mapped');
  const patternOf = (key) => key.replace(/^[!~]/, '');
  // A pattern may appear more than once only as a byte-identical row: that resolves nothing by preference and
  // loses nothing, and today's map has such a pair (`!preview/**` twice under two comment blocks, which
  // normalise must reproduce byte-for-byte). Two meanings for one pattern - different suites, or an exemption
  // on one line and a mapped row on another - are a disagreement, and this refuses rather than picking one.
  const noteRow = (pattern, kind, text, at) => {
    const existing = seen.get(pattern);
    if (!existing) {
      seen.set(pattern, { kind, line: Number(at.split(':').pop()), text });
      return;
    }
    if (existing.kind !== kind) {
      die(`${at}: ${pattern} is declared as a${kind === 'exemption' ? 'n "!" exemption' : kind === 'pending' ? ' "~" pending row' : 'n ordinary row'} here, but as a${existing.kind === 'exemption' ? 'n "!" exemption' : existing.kind === 'pending' ? ' "~" pending row' : 'n ordinary row'} at line ${existing.line} - one pattern cannot mean both`);
    }
    if (existing.text !== text) {
      die(`${at}: ${pattern} appears twice with different suites (first at line ${existing.line}) - that is a disagreement to settle by hand, not a duplicate`);
    }
  };
  lines.forEach((line, index) => {
    const at = `${label}:${index + 1}`;
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      rows.push({ kind: 'raw', line });
      return;
    }
    if (!line.includes('\t')) {
      if (line !== line.replace(/[ \t]+$/, '')) {
        die(`${at}: trailing whitespace after an exemption - run --normalise, do not hand-edit`);
      }
      if (line.startsWith('!') && line.length > 1) {
        noteRow(patternOf(line), kindOf(line), line, at);
        rows.push({ kind: 'row', key: line, tokens: [] });
        return;
      }
      die(`${at}: no TAB and not an "!" exemption (${line}) - a row is <pattern><TAB><suites...>`);
    }
    const tab = line.indexOf('\t');
    const key = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    if (key === '') die(`${at}: empty pattern before the TAB`);
    if (/\s/.test(key)) die(`${at}: the pattern contains whitespace (${key}) - no path with a space can match it`);
    if (rest.trim() === '') die(`${at}: row ${key} names no suites - name the suites, or use an "!${key}" exemption with a reason`);
    if (rest !== rest.replace(/[ \t]+$/, '')) die(`${at}: trailing whitespace after the suite list of ${key} - run --normalise, do not hand-edit`);
    const tokens = rest.split(' ');
    noteRow(patternOf(key), kindOf(key), line, at);
    if (tokens.some((token) => token === '')) die(`${at}: double space inside the suite list (${rest}) - run --normalise`);
    rows.push({ kind: 'row', key, tokens });
  });
  return rows;
};

const renderRow = (row) => {
  if (row.kind === 'raw') return row.line;
  if (row.tokens.length === 0) return row.key;            // an `!` exemption keeps its no-TAB spelling
  return `${row.key}\t${row.tokens.join(' ')}`;
};

const render = (rows) => `${rows.map(renderRow).join('\n')}\n`;

// Canonical form of ONE file: order and comments untouched, so today's map normalises to itself. A repeated
// token inside one suite list is dropped (it is the same suite named twice).
const normalise = (rows) => rows.map((row) => {
  if (row.kind === 'raw') return row;
  const seen = new Set();
  return { ...row, tokens: row.tokens.filter((token) => (seen.has(token) ? false : seen.add(token))) };
});

// Union two variants BY KEY. Comments come from ours first, then any comment line theirs has that ours does
// not, so a comment block from the other branch is neither lost nor duplicated. Keyed rows are sorted by key,
// which makes the rows independent of merge order.
const union = (ours, theirs) => {
  const byKey = new Map();
  const kindOf = (key) => (key.startsWith('!') ? 'exemption' : key.startsWith('~') ? 'pending' : 'mapped');
  const patternOf = (key) => key.replace(/^[!~]/, '');
  for (const row of [...ours, ...theirs]) {
    if (row.kind === 'raw') continue;
    const pattern = patternOf(row.key);
    const existing = byKey.get(pattern);
    if (!existing) {
      byKey.set(pattern, { kind: 'row', key: row.key, tokens: [...row.tokens] });
      continue;
    }
    if (kindOf(existing.key) !== kindOf(row.key)) {
      die(`both sides define ${pattern} differently - ${kindOf(existing.key) === 'exemption' ? 'an "!" exemption' : kindOf(existing.key) === 'pending' ? 'a "~" pending row' : 'an ordinary row'} on one side, ${kindOf(row.key) === 'exemption' ? 'an "!" exemption' : kindOf(row.key) === 'pending' ? 'a "~" pending row' : 'an ordinary row'} on the other. That is a disagreement to settle by hand, not a union`);
    }
    for (const token of row.tokens) if (!existing.tokens.includes(token)) existing.tokens.push(token);
  }
  const oursComments = ours.filter((row) => row.kind === 'raw');
  const theirsOnlyComments = theirs.filter((row) => row.kind === 'raw' && !oursComments.some((mine) => mine.line === row.line));
  const keys = [...byKey.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...oursComments, ...theirsOnlyComments, ...keys.map((key) => byKey.get(key))];
};

const readMap = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    die(`${file}: cannot read it (${err.code ?? err.message})`);
  }
};

const [mode, ...rest] = process.argv.slice(2);

if (mode === '--driver') {
  const [base, ours, theirs] = rest.filter((arg) => !arg.startsWith('--'));
  if (!ours || !theirs) die('--driver needs <base> <ours> <theirs> (the git %O %A %B arguments)');
  // The union is OURS + THEIRS: the map's rows are additive, so a 3-way base contributes nothing that is not
  // already in one of the two sides - and using base instead of ours would silently drop this branch's rows.
  const rows = union(parse(readMap(ours), ours), parse(readMap(theirs), theirs));
  fs.writeFileSync(ours, render(rows));
  process.stdout.write(`merge-suite-map: merged by key into ${ours} (${rows.filter((row) => row.kind === 'row').length} rows)\n`);
  process.exit(0);
}

if (mode === '--union') {
  const values = rest.filter((arg) => !arg.startsWith('--'));
  const writeAt = rest.indexOf('--write');
  const write = writeAt === -1 ? null : rest[writeAt + 1];
  const [oursFile, theirsFile] = values;
  if (!oursFile || !theirsFile) die('--union needs <ours-file> <theirs-file> (optionally --write <file>)');
  const out = render(union(parse(readMap(oursFile), oursFile), parse(readMap(theirsFile), theirsFile)));
  if (write) fs.writeFileSync(write, out);
  else process.stdout.write(out);
  process.exit(0);
}

if (mode === '--normalise' || mode === '--check') {
  const file = rest.find((arg) => !arg.startsWith('--')) ?? DEFAULT_MAP;
  const text = readMap(file);
  const normalised = render(normalise(parse(text, file)));
  if (mode === '--check') {
    if (normalised !== text) die(`${file} is not in canonical form - run: node tools/merge-suite-map.mjs --normalise ${file}`);
    process.stdout.write(`merge-suite-map: ${file} is canonical\n`);
    process.exit(0);
  }
  fs.writeFileSync(file, normalised);
  process.stdout.write(`merge-suite-map: normalised ${file}\n`);
  process.exit(0);
}

die('nothing to do - pass --normalise [file], --check [file], --union <ours> <theirs> [--write out], or --driver <base> <ours> <theirs>');
