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
 *   node tools/merge-suite-map.mjs --union <ours> <theirs> [base] [--write <file>]
 *       Union two variants by key, sorted by key, and print (or write) the result. Suite lists are unioned
 *       with ours' order first. Give the merge BASE too (`git show :1:<file>`) and the merge is THREE-WAY: a
 *       row - or a comment, or a blank line - the base has and one side removed is DELETED. Without a base
 *       nothing can tell an addition from a deletion, so a one-side-only row is kept and REPORTED, and a
 *       one-side-only SELF-ROW refuses outright rather than resurrecting it (airhorn-famo).
 *
 *   node tools/merge-suite-map.mjs --driver <base> <ours> <theirs>
 *       Git merge-driver shape (the %O %A %B arguments): merges three-way into <ours> and exits 0. On
 *       malformed input, or on a delete/modify disagreement, it exits 1 with a named message and writes
 *       nothing, which leaves the conflict in place for a human - a loud conflict, never a quiet wrong answer.
 *
 * WHERE A UNION IS RIGHT AND WHERE IT IS NOT (airhorn-famo). The map is a SET the gate unions at run time, so
 * a union is right for ADDITIONS: two branches adding rows for different files are both right and only the
 * text merge fails. It is WRONG for a DELETION: "ours still has the row, theirs removed it" is
 * indistinguishable from "theirs never had it", so a union silently puts back a row a branch meant to retire.
 * That is how 47 tautological self-rows a branch had deleted came back on a rebase, exit 0, while looking like
 * a clean merge (airhorn-xh81), and how 207 prose comment lines a landing had moved into docs/coverage-map.md
 * came back too (airhorn-tcdb). So with a BASE this tool is ordinary three-way: a row or a raw line present in
 * the base and absent from one side, unchanged on the other, is deleted; deleted on one side and CHANGED on
 * the other is a disagreement it refuses by name. The one thing still over-approximated is a TOKEN inside a
 * row both sides keep: a coverage claim, where the union's extra suites cost time but can never false-green,
 * and the report names every restored token.
 *
 * RESOLVING A CONFLICT without configuring anything (the primary path - works in every clone):
 *   git show :1:tools/suite-map.tsv > /tmp/base.tsv     # the merge base - what a DELETION needs
 *   git show :2:tools/suite-map.tsv > /tmp/ours.tsv     # our side of the conflict
 *   git show :3:tools/suite-map.tsv > /tmp/theirs.tsv   # their side
 *   node tools/merge-suite-map.mjs --union /tmp/ours.tsv /tmp/theirs.tsv /tmp/base.tsv --write tools/suite-map.tsv
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
 * whitespace, a non-comment line with no TAB, the same key twice inside one file, or a row DELETED on one side
 * and CHANGED on the other all FAIL LOUDLY with file:line and the key. Gate semantics are untouched: this only
 * writes the map, and only ever writes what the gate already unions at run time.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The map's ONE spelling rule (airhorn-huud): naming variants normalise, escapes are refused. Imported rather
// than copied so a delete/add decision cannot disagree with the gate about what a row names.
import { normalizeSuiteToken } from './derive-coverage-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MAP = path.join(HERE, 'suite-map.tsv');

const die = (message) => {
  process.stderr.write(`merge-suite-map: ${message}\n`);
  process.exit(1);
};

// A row's key is `<prefix?><pattern>`: `!` is an exemption and `~` a pending suite, and both name the same
// PATTERN for merge purposes (two sides must never end up with different meanings for one pattern).
const kindOf = (key) => (key.startsWith('!') ? 'exemption' : key.startsWith('~') ? 'pending' : 'mapped');
const patternOf = (key) => key.replace(/^[!~]/, '');
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// One row: raw (comment/blank, kept verbatim), exemption (`!pattern`, no TAB, no suites), or a keyed row
// (`pattern<TAB>tokens...`). `tokens` keeps file order.
const parse = (text, label) => {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();   // the trailing newline is re-emitted
  const rows = [];
  const seen = new Map();   // pattern -> { kind, line, text }  (a pattern has ONE meaning in one file)
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

// Merge two variants BY KEY. Keyed rows are sorted by key, which makes the rows independent of merge order.
// Raw lines (comments, blank lines) come from ours first, then any line theirs has that ours does not, so a
// comment block from the other branch is neither lost nor duplicated.
//
// WITH A BASE THE MERGE IS THREE-WAY (airhorn-famo). A union cannot say "removed": a row the base has, that one
// side deleted and the other left untouched, is kept by a plain union - so a branch retiring rows (or prose,
// airhorn-tcdb) is silently reverted by an exit-0 merge. So when the base is supplied:
//   deletedRows  a row in BASE, removed on one side, untouched on the other: DELETED (reported by name)
//   deletedRaw   a comment/blank line the same way: DELETED (reported by name)
//   addedRows    a row not in BASE and on one side only: kept - an addition, which is what a union is for
// and a row DELETED on one side and CHANGED on the other refuses by name: that is a disagreement, not a union.
// Without a base nothing can tell an addition from a deletion, so one-side-only rows are kept and REPORTED,
// and a one-side-only self-row is reported as the hazard it is (--union refuses it outright).
//
// The report is part of the contract, not a nicety (airhorn-gdtr): a union that quietly keeps a suite token one
// side deleted is doing exactly what a coverage map should do - over-approximate, never false-green - but the lane
// reviewing the merge has to SEE it. So:
//   added       a token one side names and the other does not, and BASE does not: a genuine addition
//   restored    a token present in BASE and on one side only, i.e. the other side deleted it and the union kept it
//     (the ONE over-approximation left: a token is a coverage claim, where an extra suite costs time and cannot
//     false-green - unlike a whole row or a whole comment, whose deletion is the branch's actual intent)
// and "no shared patterns" is printed only when the two sides truly share none.

// A row's MEANING is its kind plus its suite SET: a token reorder is not a change, so whether a side "touched" a
// row does not depend on the order it happened to spell the suites in.
const sameRow = (a, b) => {
  if (!a || !b || a.kind !== b.kind) return false;
  const mine = [...a.tokens].sort();
  const other = [...b.tokens].sort();
  return mine.length === other.length && mine.every((token, index) => token === other[index]);
};

// A row that names only its own suite is a tautology the gate derives from the tree (airhorn-xh81), so a
// one-side-only self-row is far more likely to be a DELETION than an addition - and without a BASE that is
// precisely what this tool cannot tell apart. Spelled through the map's shared naming rule, so a variant
// spelling ('.//x', 'tests/../x') is recognised as the same row.
const isSelfRow = (row) => {
  if (row.kind !== 'mapped' || row.tokens.length !== 1) return false;
  const pattern = normalizeSuiteToken(patternOf(row.key));
  const suite = normalizeSuiteToken(row.tokens[0]);
  return !pattern.escape && !suite.escape && pattern.path === suite.path;
};

const describeRaw = (line) => {
  const text = line.trim();
  if (text === '') return 'blank line';
  return `"${text.length > 60 ? `${text.slice(0, 57)}...` : text}"`;
};

const union = (ours, theirs, base = null) => {
  const report = {
    added: [], restored: [], addedRows: [], deletedRows: [], deletedRaw: [], rawDiffering: [],
    onlyOneSide: [], selfRowOnly: [], shared: 0,
  };
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
  const patterns = [...new Set([...oursMap.keys(), ...theirsMap.keys(), ...(baseMap ? [...baseMap.keys()] : [])])];
  for (const pattern of patterns.sort(byString)) {
    const mine = oursMap.get(pattern);
    const other = theirsMap.get(pattern);
    const was = baseMap ? baseMap.get(pattern) ?? null : null;
    if (!mine || !other) {
      const only = mine ?? other;
      const side = mine ? 'ours' : 'theirs';
      if (!only) continue;   // both sides deleted it: nothing to keep and nothing to prefer
      if (!was) {
        // Neither the base nor the other side has this row: an ADDITION, which a union is the right answer for.
        byKey.set(pattern, { kind: 'row', key: only.key, tokens: [...only.tokens] });
        report.addedRows.push(`${pattern} (${side})`);
        if (!baseMap) report.onlyOneSide.push(`${pattern} (${side})`);
        if (isSelfRow(only)) report.selfRowOnly.push(`${pattern} (${side})`);
        continue;
      }
      if (!sameRow(only, was)) {
        const kept = only.tokens.length > 0 ? only.tokens.join(' ') : 'an "!" exemption';
        die(`${pattern} was DELETED on one side and CHANGED on the other (${side} still declares ${kept}) - delete/modify is a disagreement to settle by hand, not a union`);
      }
      // The base has it, one side kept it as it was, the other removed it: a DELETION, and the branch meant it.
      report.deletedRows.push(`${pattern} (deleted by ${side === 'ours' ? 'theirs' : 'ours'})`);
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
  // Raw lines are three-way too, because prose is a deletion like any other (airhorn-tcdb). A raw line has no
  // key, so its identity is its text plus the number of copies of that text: a line the base has and the side
  // that changed it removed stays removed. Without a base the old over-approximation stands - ours' lines, then
  // any line of theirs ours does not have - because nothing there can tell a deletion from an addition.
  const oursRaw = ours.filter((row) => row.kind === 'raw');
  const theirsRaw = theirs.filter((row) => row.kind === 'raw');
  let keptRaw;
  if (!base) {
    const oursLines = new Set(oursRaw.map((row) => row.line));
    keptRaw = [...oursRaw, ...theirsRaw.filter((row) => !oursLines.has(row.line))];
  } else {
    const rawCounts = (rows) => {
      const counts = new Map();
      for (const row of rows) if (row.kind === 'raw') counts.set(row.line, (counts.get(row.line) ?? 0) + 1);
      return counts;
    };
    const oursCounts = rawCounts(oursRaw);
    const theirsCounts = rawCounts(theirsRaw);
    const baseCounts = rawCounts(base);
    const keepCount = new Map();
    for (const line of new Set([...oursCounts.keys(), ...theirsCounts.keys(), ...baseCounts.keys()])) {
      const mineCount = oursCounts.get(line) ?? 0;
      const otherCount = theirsCounts.get(line) ?? 0;
      const was = baseCounts.get(line) ?? 0;
      let keep;
      if (mineCount === otherCount) keep = mineCount;                 // both sides agree (including both deleted)
      else if (mineCount === was) keep = otherCount;                  // only THEIRS changed it: their edit wins
      else if (otherCount === was) keep = mineCount;                  // only OURS changed it: ours wins
      else {
        keep = Math.max(mineCount, otherCount);                       // both changed: keep the larger, and say so
        report.rawDiffering.push(`${describeRaw(line)} (ours ${mineCount}, theirs ${otherCount}, base ${was})`);
      }
      keepCount.set(line, keep);
      if (keep < was) report.deletedRaw.push(`${describeRaw(line)} (base ${was}, kept ${keep})`);
    }
    keptRaw = [];
    const emitted = new Map();
    const keepLine = (row) => {
      const kept = keepCount.get(row.line) ?? 0;
      const used = emitted.get(row.line) ?? 0;
      if (used >= kept) return;
      emitted.set(row.line, used + 1);
      keptRaw.push(row);
    };
    for (const row of oursRaw) keepLine(row);
    for (const row of theirsRaw) keepLine(row);
  }
  const rows = [...keptRaw, ...[...byKey.keys()].sort(byString).map((key) => byKey.get(key))];
  return { rows, report };
};

// The merge is only reviewable if it says what it did: a silently broadened row is the failure mode this tool
// exists to make impossible, so every unioned, every RESTORED token, every deleted row/line and every
// one-side-only self-row is printed. A deletion is a verdict too, not a stderr footnote (airhorn-famo).
const printReport = (report, label) => {
  const say = (list, what) => {
    if (list.length > 0) process.stderr.write(`merge-suite-map: ${label}: ${what} ${list.join(', ')}`);
    if (list.length > 0) process.stderr.write('\n');
  };
  say(report.deletedRows, 'DELETED rows (in the base, removed on one side and untouched on the other - the merge RESPECTS the deletion, airhorn-famo):');
  say(report.deletedRaw, 'deleted comment/blank lines (removed by one side, respected - a union would put them back, airhorn-tcdb):');
  say(report.addedRows, 'added rows (not in the base and on one side only - kept):');
  say(report.onlyOneSide, 'rows on ONE side only and no base to tell an addition from a deletion - kept:');
  say(report.selfRowOnly, 'SELF-ROWS on one side only - keeping one REVERTS a branch that deleted it, so pass the merge base (airhorn-famo):');
  say(report.rawDiffering, 'comment/blank lines BOTH sides changed differently - kept the larger count, settle by hand if it matters:');
  say(report.added, 'added suites (named on one side only - the union keeps them):');
  say(report.restored, 'RESTORED (deleted on one side, kept by the union - over-approximation, extra suites will run):');
  const quiet = report.added.length === 0 && report.restored.length === 0 && report.addedRows.length === 0
    && report.deletedRows.length === 0 && report.deletedRaw.length === 0 && report.onlyOneSide.length === 0
    && report.selfRowOnly.length === 0 && report.rawDiffering.length === 0;
  if (report.shared === 0) {
    process.stderr.write(`merge-suite-map: ${label}: no pattern appears on both sides - a straight union of both sides\n`);
  } else if (quiet) {
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
  // THREE-WAY, and the base is the whole point (airhorn-famo): "ours still has the row" and "theirs never had
  // it" are only distinguishable with the common ancestor, and a union that cannot express a deletion puts
  // back the rows a branch retired. Additions are still unioned - both sides' new rows survive.
  const { rows, report } = union(parse(readMap(ours), ours), parse(readMap(theirs), theirs), base ? parse(readMap(base), base) : null);
  printReport(report, 'driver');
  fs.writeFileSync(ours, render(rows));
  const counted = rows.filter((row) => row.kind === 'row').length;
  const changes = [];
  if (report.deletedRows.length > 0) changes.push(`${report.deletedRows.length} row(s) deleted`);
  if (report.addedRows.length > 0) changes.push(`${report.addedRows.length} row(s) added`);
  if (report.deletedRaw.length > 0) changes.push(`${report.deletedRaw.length} comment/blank line kind(s) deleted`);
  process.stdout.write(`merge-suite-map: merged by key into ${ours} (${counted} rows${changes.length > 0 ? `; ${changes.join(', ')}` : ''})\n`);
  process.exit(0);
}

if (mode === '--union') {
  const writeAt = rest.indexOf('--write');
  const write = writeAt === -1 ? null : rest[writeAt + 1];
  const skip = writeAt === -1 ? -1 : writeAt + 1;   // --write's value is not a positional file
  const values = rest.filter((arg, index) => !arg.startsWith('--') && index !== skip);
  const [oursFile, theirsFile, baseFile] = values;
  if (!oursFile || !theirsFile) die('--union needs <ours-file> <theirs-file> [base-file] (optionally --write <file>)');
  const { rows, report } = union(
    parse(readMap(oursFile), oursFile),
    parse(readMap(theirsFile), theirsFile),
    baseFile ? parse(readMap(baseFile), baseFile) : null,
  );
  printReport(report, 'union');
  // Without a base this tool cannot tell "one side added this row" from "one side deleted it", and a self-row
  // is by far the likeliest deletion (a tautology the gate derives anyway, airhorn-xh81): refuse rather than
  // hand back a map with the deletion silently reversed. Nothing is written, so the conflict stays for the
  // lane - which now has the exact fix in the message (airhorn-famo).
  if (!baseFile && report.selfRowOnly.length > 0) {
    die(`no merge base given, and one side carries a self-row the other lacks (${report.selfRowOnly.join(', ')}) - keeping it silently REVERTS the branch that deleted it, which is how 47 deleted self-rows came back (airhorn-xh81, airhorn-famo). Nothing was written. Pass the base:\n  git show :1:tools/suite-map.tsv > /tmp/base.tsv\n  node tools/merge-suite-map.mjs --union <ours> <theirs> /tmp/base.tsv --write tools/suite-map.tsv\nor rebuild the map from the other side and re-apply the deletion, and say so on the bead`);
  }
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

die('nothing to do - pass --normalise [file], --check [file], --union <ours> <theirs> [base] [--write out], --driver <base> <ours> <theirs>, or the tier-block forms --tiers-normalise/--tiers-check/--tiers-union/--tiers-driver (airhorn-09dr)');
