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
 *   node tools/derive-coverage-contract.mjs      # the contract is derived: regenerate, never merge
 *   git add tools/suite-map.tsv .fleet/coverage-contract.json
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
//
// The report is part of the contract, not a nicety (airhorn-gdtr): a union that quietly keeps a suite token one
// side deleted is doing exactly what a coverage map should do - over-approximate, never false-green - but the lane
// reviewing the merge has to SEE it. So:
//   added       a token one side names and the other does not, and BASE does not: a genuine addition
//   restored    a token present in BASE and on one side only, i.e. the other side deleted it and the union kept it
//   resurrected a whole row present in BASE and on one side only
// and "no shared patterns" is printed only when the two sides truly share none.
const union = (ours, theirs, base = null) => {
  const report = { added: [], restored: [], resurrected: [], shared: 0 };
  const kindOf = (key) => (key.startsWith('!') ? 'exemption' : key.startsWith('~') ? 'pending' : 'mapped');
  const patternOf = (key) => key.replace(/^[!~]/, '');
  const rowMap = (rows) => {
    const map = new Map();
    for (const row of rows) {
      if (row.kind === 'raw') continue;
      const pattern = patternOf(row.key);
      if (!map.has(pattern)) map.set(pattern, { kind: kindOf(row.key), key: row.key, tokens: [...row.tokens] });
    }
    return map;
  };
  const oursMap = rowMap(ours);
  const theirsMap = rowMap(theirs);
  const baseMap = base ? rowMap(base) : null;
  const byKey = new Map();
  for (const pattern of [...new Set([...oursMap.keys(), ...theirsMap.keys()])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const mine = oursMap.get(pattern);
    const other = theirsMap.get(pattern);
    if (!mine || !other) {
      const only = mine ?? other;
      byKey.set(pattern, { kind: 'row', key: only.key, tokens: [...only.tokens] });
      continue;
    }
    report.shared += 1;
    if (mine.kind !== other.kind) {
      const name = (kind) => (kind === 'exemption' ? 'an "!" exemption' : kind === 'pending' ? 'a "~" pending row' : 'an ordinary row');
      die(`both sides define ${pattern} differently - ${name(mine.kind)} on one side, ${name(other.kind)} on the other. That is a disagreement to settle by hand, not a union`);
    }
    const tokens = [...mine.tokens];
    for (const token of other.tokens) if (!tokens.includes(token)) tokens.push(token);
    byKey.set(pattern, { kind: 'row', key: mine.key, tokens });
    // A token the two sides disagree about is either an addition (fine) or a deletion the union restores
    // (over-approximation). BASE is what tells them apart, so say the specific thing when we have it.
    const disagreed = [...new Set([...mine.tokens, ...other.tokens])].filter((token) => !(mine.tokens.includes(token) && other.tokens.includes(token)));
    if (disagreed.length === 0) continue;
    const keptByBase = baseMap && baseMap.has(pattern) ? new Set(baseMap.get(pattern).tokens) : new Set();
    const restored = disagreed.filter((token) => keptByBase.has(token));
    const added = disagreed.filter((token) => !keptByBase.has(token));
    if (restored.length > 0) report.restored.push(`${pattern} (${restored.join(' ')})`);
    if (added.length > 0) report.added.push(`${pattern} (${added.join(' ')})`);
  }
  // A whole row one branch DELETED and the other kept is resurrected by a union. Same direction of safety, same
  // requirement to say it (the hazard named in airhorn-tp3g).
  if (baseMap) {
    for (const pattern of baseMap.keys()) {
      const deletedByUs = !oursMap.has(pattern);
      const deletedByThem = !theirsMap.has(pattern);
      if (deletedByUs !== deletedByThem) report.resurrected.push(pattern);
    }
  }
  const oursComments = ours.filter((row) => row.kind === 'raw');
  const theirsOnlyComments = theirs.filter((row) => row.kind === 'raw' && !oursComments.some((mine) => mine.line === row.line));
  const rows = [...oursComments, ...theirsOnlyComments, ...[...byKey.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((key) => byKey.get(key))];
  return { rows, report };
};

// The union is only reviewable if it says what it did: a silently broadened row is the failure mode this tool
// exists to make impossible, so every unioned and every resurrected pattern is printed.
const printReport = (report, label) => {
  const say = (list, what) => {
    if (list.length > 0) process.stderr.write(`merge-suite-map: ${label}: ${what} ${list.join(', ')}\n`);
  };
  say(report.added, 'added suites (named on one side only - the union keeps them):');
  say(report.restored, 'RESTORED (deleted on one side, kept by the union - over-approximation, extra suites will run):');
  say(report.resurrected, 'RESURRECTED rows (deleted on one side, kept by the union - over-approximation):');
  if (report.shared === 0) {
    process.stderr.write(`merge-suite-map: ${label}: no pattern appears on both sides - a straight union of both sides\n`);
  } else if (report.added.length === 0 && report.restored.length === 0 && report.resurrected.length === 0) {
    process.stderr.write(`merge-suite-map: ${label}: ${report.shared} shared pattern(s), all identical - only new rows were added\n`);
  }
};

/* -------------------------------------------------- gate.conf tier-block mode (airhorn-09dr)
 *
 * tools/gate.conf's SUITE_TIERS block is the SECOND shared append surface: every new pinned suite adds
 * a `path=tier` row, and two branches doing it collide textually. The block is mechanically mergeable
 * because the consumer (fast-gate.sh declared_tier, :136-151) is an exact-match line scan: distinct keys
 * are ORDER-INSENSITIVE, so union-by-key is safe for appends. The same consumer is FIRST-HIT-WINS on a
 * duplicate key, so a duplicate path with a DIFFERING tier must fail loudly here - a silent union would
 * let the parser quietly take the first.
 *
 * Only the SUITE_TIERS="..." block is merged or normalised; everything outside it (the runner pin, the
 * comments that carry the z4cn design) is verbatim from ours. A conflict OUTSIDE the block is left to
 * git, deliberately: the runner line is a reviewed singleton, not an append surface (airhorn-v6th).
 */
const TIER_OPEN = 'SUITE_TIERS="';

// Split a gate.conf into { pre, rows, post }: the text before the block, the tier rows, the text after.
const splitGateConf = (text, label) => {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const open = lines.findIndex((line) => line.trim() === TIER_OPEN);
  if (open === -1) die(`${label}: no SUITE_TIERS=" block - the tier-block mode only merges gate.conf's tier rows`);
  const close = lines.findIndex((line, i) => i > open && line.trim() === '"');
  if (close === -1) die(`${label}: the SUITE_TIERS block never closes (no line that is just a quote)`);
  const rows = lines.slice(open + 1, close).map((line, i) => {
    const at = `${label}:${open + 2 + i}`;
    const trimmed = line.trim();
    if (trimmed === '') return { kind: 'blank', line: '' };
    if (!trimmed.includes('=')) die(`${at}: a tier row is <path>=<tier> (${trimmed}) - comments do not belong inside the block`);
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq);
    const tier = trimmed.slice(eq + 1);
    if (/\s/.test(key)) die(`${at}: the suite path contains whitespace (${key})`);
    if (tier === '') die(`${at}: ${key} declares no tier`);
    return { kind: 'tier', key, tier };
  });
  return { pre: lines.slice(0, open + 1), rows, post: lines.slice(close) };
};

// A duplicate path with a DIFFERING tier is a disagreement and refuses, naming both rows; byte-identical
// duplicates are a merge artifact and normalise drops the second copy.
const checkTierDuplicates = (rows, label, baseLine) => {
  const seen = new Map();
  rows.forEach((row, i) => {
    if (row.kind !== 'tier') return;
    const existing = seen.get(row.key);
    if (existing && existing.tier !== row.tier) {
      die(`${label}:${baseLine + i + 1}: ${row.key} is declared with tier '${row.tier}' here but '${existing.tier}' at block row ${existing.index + 1} - one suite cannot be two tiers; settle it by hand`);
    }
    if (!existing) seen.set(row.key, { tier: row.tier, index: i });
  });
};

const renderGateConf = ({ pre, rows, post }) =>
  [...pre, ...rows.map((row) => (row.kind === 'blank' ? '' : `${row.key}=${row.tier}`)), ...post, ''].join('\n');

// Canonical form: outside the block untouched; inside, order kept, blank lines kept, identical duplicate
// rows dropped, no whitespace changes beyond the row's own trim. Today's gate.conf reproduces byte-for-byte
// (tests/gate-conf-merge.test.js pins that with a checksum).
const normaliseTiers = (conf, label) => {
  const seen = new Set();
  return {
    ...conf,
    rows: conf.rows.filter((row) => {
      if (row.kind !== 'tier') return true;
      if (seen.has(row.key)) return false;
      seen.add(row.key);
      return true;
    }),
  };
};

// Union two gate.confs BY TIER KEY: the block rows from both sides, sorted by path (order-independent);
// a path on both sides must agree on its tier or this refuses; everything outside the block is ours
// verbatim. The parse of each side has already refused any same-file duplicate with differing tiers.
const unionTiers = (oursConf, theirsConf, oursLabel, theirsLabel) => {
  const byKey = new Map();
  for (const row of oursConf.rows) {
    if (row.kind === 'tier' && !byKey.has(row.key)) byKey.set(row.key, row.tier);
  }
  for (const row of theirsConf.rows) {
    if (row.kind !== 'tier') continue;
    const existing = byKey.get(row.key);
    if (existing && existing !== row.tier) {
      die(`${row.key}: tier '${row.tier}' in ${theirsLabel} but '${existing}' in ${oursLabel} - a suite cannot be two tiers; settle it by hand`);
    }
    if (!existing) byKey.set(row.key, row.tier);
  }
  const rows = [...byKey.keys()].sort().map((key) => ({ kind: 'tier', key, tier: byKey.get(key) }));
  return { pre: oursConf.pre, rows, post: oursConf.post };
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
  const { rows, report } = union(parse(readMap(ours), ours), parse(readMap(theirs), theirs), base ? parse(readMap(base), base) : null);
  printReport(report, 'driver');
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
  const { rows, report } = union(parse(readMap(oursFile), oursFile), parse(readMap(theirsFile), theirsFile));
  printReport(report, 'union');
  const out = render(rows);
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

if (mode === '--tiers-driver') {
  const [base, ours, theirs] = rest.filter((arg) => !arg.startsWith('--'));
  if (!ours || !theirs) die('--tiers-driver needs <base> <ours> <theirs> (the git %O %A %B arguments)');
  const oursConf = splitGateConf(readMap(ours), ours);
  const theirsConf = splitGateConf(readMap(theirs), theirs);
  checkTierDuplicates(oursConf.rows, ours, 0);
  checkTierDuplicates(theirsConf.rows, theirs, 0);
  const merged = unionTiers(oursConf, theirsConf, ours, theirs);
  fs.writeFileSync(ours, renderGateConf(merged));
  process.stdout.write(`merge-suite-map: tier block merged by key into ${ours} (${merged.rows.length} tier rows; everything outside SUITE_TIERS is ours verbatim)\n`);
  process.exit(0);
}

if (mode === '--tiers-union') {
  const values = rest.filter((arg) => !arg.startsWith('--'));
  const writeAt = rest.indexOf('--write');
  const write = writeAt === -1 ? null : rest[writeAt + 1];
  const [oursFile, theirsFile] = values;
  if (!oursFile || !theirsFile) die('--tiers-union needs <ours-file> <theirs-file> (optionally --write <file>)');
  const oursConf = splitGateConf(readMap(oursFile), oursFile);
  const theirsConf = splitGateConf(readMap(theirsFile), theirsFile);
  checkTierDuplicates(oursConf.rows, oursFile, 0);
  checkTierDuplicates(theirsConf.rows, theirsFile, 0);
  const out = renderGateConf(unionTiers(oursConf, theirsConf, oursFile, theirsFile));
  if (write) fs.writeFileSync(write, out);
  else process.stdout.write(out);
  process.exit(0);
}

if (mode === '--tiers-normalise' || mode === '--tiers-check') {
  const file = rest.find((arg) => !arg.startsWith('--')) ?? 'tools/gate.conf';
  const text = readMap(file);
  const conf = splitGateConf(text, file);
  const open = conf.pre.length;   // tier rows start at 1-based line open+1
  checkTierDuplicates(conf.rows, file, open);
  const normalised = renderGateConf(normaliseTiers(conf, file));
  if (mode === '--tiers-check') {
    if (normalised !== text) die(`${file}'s tier block is not in canonical form - run: node tools/merge-suite-map.mjs --tiers-normalise ${file}`);
    process.stdout.write(`merge-suite-map: ${file}'s tier block is canonical\n`);
    process.exit(0);
  }
  fs.writeFileSync(file, normalised);
  process.stdout.write(`merge-suite-map: normalised the tier block of ${file}\n`);
  process.exit(0);
}

die('nothing to do - pass --normalise [file], --check [file], --union <ours> <theirs> [--write out], --driver <base> <ours> <theirs>, or the tier-block forms --tiers-normalise/--tiers-check/--tiers-union/--tiers-driver (airhorn-09dr)');
