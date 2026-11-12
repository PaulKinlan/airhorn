#!/usr/bin/env node
/**
 * tools/closure-claims.mjs — a closed bead's LAST WORD must not still say "it never landed" once the
 * trunk says it did. (airhorn-3di8, from the closure audit airhorn-k1wo.)
 *
 * THE CLASS. A merger lane writes this note, and it is CORRECT at the moment it is written:
 *
 *   QUEUE STALE: cleared:be942892 pins an ancestor of origin/fleet/impl-del@34a10e8b (branch moved
 *   since clearance), no corresponding branch points at this sha and it is NOT in origin/master@e2b5ad0d.
 *   Cannot independently land a historical commit ... Cleared and merge-queue removed, merge-blocked.
 *
 * It answers "can this CLEARANCE land this commit NOW?", and the answer is no: a clearance pinned on an
 * ancestor cannot land a carrier that has moved. Nothing in it answers "will this bead's work ever reach
 * master?" - but it is the bead's most readable artifact, so when a later batch carrier merges the same
 * content the note survives as the bead's LAST word, and the record then reads as "this never landed".
 * Measured on 2026-11-11 (master 8b7ef0b2): 7 of 101 closures were in exactly this state, every one with
 * its cited landing commit an ANCESTOR of master and its functional lines present in the tree, the
 * vehicle being the batch-six merge e95664b0, which landed after the 14:15Z notes.
 *
 * It is invisible to ancestry-only checks because the note makes no landing claim, and it passes a
 * ledger sweep that only asks "is it closed?" - the status is right. Only the closing TEXT is wrong, in
 * the direction that reads as "not landed".
 *
 * WHY A TOOL AND NOT A HABIT. The note is written by a merger lane in prose, and the tooling that would
 * have to remember to supersede it (`fleet-land-message`, the merge train) is hub-owned: a project VM
 * does not patch ~/fleet, and a diff would be rejected by the inbox. So the correction is made
 * mechanical where the project CAN own it - one command the merger (or any lane) runs after a carrier
 * lands, or that a later audit runs against the whole record. The merger already knows the carrier sha
 * and the commit range; this tool turns that into the loop over data it already has.
 *
 *   node tools/closure-claims.mjs                              # every bead closed in the last 14 days
 *   node tools/closure-claims.mjs --since 2026-11-01
 *   node tools/closure-claims.mjs --carrier e95664b0            # only beads named in that carrier's range
 *   node tools/closure-claims.mjs --bead airhorn-jmpm           # one bead
 *   node tools/closure-claims.mjs --apply                       # write the superseding comment(s)
 *   node tools/closure-claims.mjs --json                        # machine-readable rows + summary
 *   node tools/closure-claims.mjs --require-clear               # exit 1 if any correction is outstanding
 *
 * WHAT COUNTS AS A STALE LAST WORD. The LAST comment on a bead that is CLOSED, whose text ASSERTS (not
 * quotes, not reports) that the work is not in the trunk: `QUEUE STALE`, `pins an ancestor of`, `no
 * corresponding branch points at this sha`, `is NOT in origin/master`. `merge-blocked` alone is NOT a
 * marker - the merger labels a bead merge-blocked for a real merge conflict too, and a conflict note
 * makes no claim about the trunk. A comment that quotes such a note ("the last comment is a merger
 * 'QUEUE STALE ... it is NOT in origin/master' note") is REPORTING it, not making the claim: quoted
 * spans, inline code and blockquote lines are stripped before the markers are read, so a hand-written
 * correction is not re-corrected. The tool's own comment carries SUPERSEDED-BY-LANDING, and any comment
 * saying "superseded"/"correction" is read as a correction, so running the tool twice is a no-op.
 *
 * WHAT COUNTS AS PROOF. The note itself names the commit it is talking about (`cleared:<sha>`, or
 * `tip <sha>`), so that is what gets checked, against the trunk, by ancestry:
 * `git merge-base --is-ancestor <sha> <ref>` -> 0. If the pinned sha is not an ancestor, the tool falls
 * back to a trunk commit whose subject names the bead (`Merge fleet/<branch> (<bead>): ...`), and says
 * so in the comment it writes. If neither holds, the row is `review:unproven` and NOTHING is written:
 * a stale-sounding note whose pinned commit is genuinely absent from the trunk may well be true, and
 * this tool never writes a correction it cannot evidence.
 *
 * STATED LIMITS. Ancestry proves the commit that landed is in the trunk's history; it cannot see a
 * later revert, so the evidence line names the sha it proved and a reader can check the content the way
 * airhorn-k1wo did. Proof by subject is weaker than proof by the pinned sha, which is why the comment
 * says which one it used. The tool reads comments through `bd`, so `bd dolt pull` first if the record
 * may have moved, and `bd dolt push` after `--apply` - an unsynced comment is not a record.
 *
 * Exit codes: 0 = ran (and, with --require-clear, no correction is outstanding); 1 = --require-clear
 * found a provable stale last word; 2 = usage/ref/tool error.
 */

import { spawnSync } from 'node:child_process';
import { parseLandingMessage } from './landings.mjs';

/** The last-word states a bead's closing comment can be in. */
export const LAST_WORD_STATES = ['stale-clearance', 'superseded', 'landed', 'other'];

/** What the tool decides per bead. `review:unproven` is a report row, never a write. */
export const DECISIONS = ['supersede', 'skip:not-closed', 'skip:last-word-ok', 'review:unproven'];

/**
 * The sentences a stale-clearance note is actually made of (samples on airhorn-3di8). These are CLAIMS
 * about the trunk, which is what makes them checkable. `merge-blocked` is deliberately not here.
 */
const STALE_MARKERS = [
  /QUEUE\s+STALE/i,
  /\bpins an ancestor of\b/i,
  /\bno corresponding branch points at this sha\b/i,
  /\bis\s+NOT\s+in\s+origin\/master\b/i,
  /\bNOT\s+in\s+(?:origin\/)?master\b/i,
];

/** A comment that already corrects (or is our own correction) - never re-corrected. */
const SUPERSEDE_MARKERS = [/SUPERSEDED-BY-LANDING/, /\bsupersede[ds]?\b/i, /^[ \t]*CORRECTION\b/im];

/** The commits a stale note pins as "this is the work and it is not in the trunk", most specific first. */
const PINNED_PATTERNS = [
  ['cleared', /\bcleared:\s*([0-9a-f]{7,40})\b/gi],
  ['tip', /\btip\s+([0-9a-f]{7,40})\b/gi],
];

const MARKER = 'SUPERSEDED-BY-LANDING';

/**
 * Remove the parts of a comment that CITE another note rather than making a claim: blockquote lines,
 * `inline code`, and quoted spans. This is what keeps a hand-written correction ("the last comment is a
 * merger 'QUEUE STALE ... it is NOT in origin/master' note") from being read as a fresh stale claim.
 * Limit: only single-line quoted spans are stripped (an apostrophe with no partner stays), which can
 * only make the tool MISS a stale claim, never invent one.
 */
export function stripCitations(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/\u201c[^\u201d\n]*\u201d/g, ' ')
    .replace(/'[^'\n]*'/g, ' ');
}

/** The commits a note pins, as `{ role, sha }`, in the order the note names them. */
export function pinnedShas(text) {
  const out = [];
  const seen = new Set();
  for (const [role, pattern] of PINNED_PATTERNS) {
    for (const match of String(text || '').matchAll(pattern)) {
      const sha = match[1].toLowerCase();
      if (seen.has(sha)) continue;
      seen.add(sha);
      out.push({ role, sha });
    }
  }
  return out;
}

/**
 * Read one comment as a claim about the trunk. Citations are stripped first (see stripCitations), then
 * a correction marker wins, then a stale marker, then a landing claim.
 */
export function classifyNote(text) {
  const raw = String(text || '');
  const claim = stripCitations(raw);
  const pinned = pinnedShas(claim);
  if (SUPERSEDE_MARKERS.some((pattern) => pattern.test(claim))) return { state: 'superseded', pinned };
  if (STALE_MARKERS.some((pattern) => pattern.test(claim))) return { state: 'stale-clearance', pinned };
  if (/\b(landed|MERGED|COVERED BY|in origin\/master|is an ancestor|an ancestor of)\b/i.test(claim)) return { state: 'landed', pinned };
  return { state: 'other', pinned };
}

/** `bd comments <id> --json` rows -> `{ author, at, text }`, oldest first. */
export function normaliseComments(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      author: row.author || row.created_by || 'unknown',
      at: row.created_at || row.createdAt || '',
      text: row.text || row.body || '',
    }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** The bead's last word: the newest comment, or null when the bead has none. */
export function lastWord(comments) {
  const list = Array.isArray(comments) ? comments : [];
  return list.length ? list[list.length - 1] : null;
}

function run(command, args, { cwd, input } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

function git(cwd, args) {
  const result = run('git', args, { cwd });
  if (result.error) throw new Error(`git ${args.join(' ')}: ${result.error.message}`);
  return result;
}

/** The trunk ref: what `origin/master` is, else master, else HEAD. */
export function resolveRef(cwd, requested) {
  if (requested) {
    if (!git(cwd, ['rev-parse', '--verify', '--quiet', `${requested}^{commit}`]).ok) {
      throw new Error(`--ref ${requested} is not a commit`);
    }
    return requested;
  }
  for (const candidate of ['origin/master', 'master', 'HEAD']) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]).ok) return candidate;
  }
  throw new Error('no trunk ref found (tried origin/master, master, HEAD)');
}

/** The commit a ref points at, shortened for a record line. */
export function refSha(cwd, ref) {
  const result = git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!result.ok) throw new Error(`cannot resolve ${ref}`);
  return result.stdout.trim();
}

/**
 * Every bead id named in a commit range. Two shapes are read, because a carrier's range contains both:
 * a fleet LANDING subject (`Merge fleet/<branch> (<bead>): ...`, parsed by the record generator's own
 * parser) and the repo's commit convention `<bead>: <what changed>` / `... (<bead>, <bead>)` on the
 * inner commits. The second is matched against the tracker's own issue prefix, so an ordinary
 * hyphenated word in a subject (a `mutation-check` or a `press-guard`) is never mistaken for an id, and
 * every id found is filtered against the tracker before anything is read.
 */
export function beadIdsInRange(cwd, range, { prefix = null } = {}) {
  const raw = git(cwd, ['log', '--format=%H%x1f%T%x1f%cI%x1f%s%x1f%B%x1e', range]);
  if (!raw.ok) throw new Error(`git log ${range} failed: ${raw.stderr.trim()}`);
  const ids = new Set();
  const idPattern = prefix ? new RegExp(`\\b${escapeRegex(prefix)}-[a-z0-9][a-z0-9.]*\\b`, 'gi') : null;
  for (const record of raw.stdout.split('\x1e')) {
    const line = record.replace(/^\n+/, '');
    if (!line) continue;
    const [sha, tree, date, subject, ...rest] = line.split('\x1f');
    const landing = parseLandingMessage({ sha, tree, date, subject, body: rest.join('\x1f') });
    if (landing.bead) ids.add(landing.bead);
    if (idPattern) for (const match of String(subject || '').matchAll(idPattern)) ids.add(match[0]);
  }
  return [...ids];
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Prove the bead's work is in the trunk, using the evidence the record itself offers.
 * `pinned-ancestry`/`tip-ancestry`: the commit the note names is an ancestor of the trunk.
 * `subject-landing`: the pinned commit is NOT an ancestor, but a trunk commit's subject names the bead.
 * `unproven`: neither - the note may well be true, so the tool writes nothing.
 */
export function proveInTrunk({ cwd, ref, beadId, pinned = [] }) {
  const attempts = [];
  for (const { role, sha } of pinned) {
    if (!git(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).ok) {
      attempts.push(`pinned ${role} commit ${sha} does not exist in this clone`);
      continue;
    }
    if (git(cwd, ['merge-base', '--is-ancestor', sha, ref]).ok) {
      return { state: 'proven', method: `${role}-ancestry`, sha, attempts };
    }
    attempts.push(`pinned ${role} commit ${sha} is NOT an ancestor of ${ref}`);
  }
  const named = git(cwd, ['log', '--format=%H%x1f%s', '--fixed-strings', `--grep=${beadId}`, ref]);
  if (named.ok) {
    for (const line of named.stdout.split('\n').filter(Boolean)) {
      const [sha, subject = ''] = line.split('\x1f');
      if (!new RegExp(`\\(${beadId}\\)|\\b${beadId}\\b`).test(subject)) continue;
      if (!git(cwd, ['merge-base', '--is-ancestor', sha, ref]).ok) continue;
      return { state: 'proven', method: 'subject-landing', sha, subject, attempts };
    }
  }
  attempts.push(`no trunk commit's subject names ${beadId}`);
  return { state: 'unproven', method: null, sha: null, attempts };
}

/**
 * Decide one bead. Pure: the caller supplies the proof, so the decision can be tested without git and
 * without a tracker. A correction needs all three: closed, a stale last word, and proof.
 */
export function decideBead({ beadId, status, comments, proof }) {
  const word = lastWord(comments);
  const classified = word ? classifyNote(word.text) : { state: 'other', pinned: [] };
  const base = {
    bead: beadId,
    status: status || 'unknown',
    at: word ? word.at : null,
    author: word ? word.author : null,
    lastWordState: classified.state,
    pinned: classified.pinned,
    proof: proof || null,
    decision: null,
    reason: null,
  };
  if (classified.state !== 'stale-clearance') {
    return { ...base, decision: 'skip:last-word-ok', reason: `the last comment is ${classified.state === 'other' ? 'not a claim about the trunk' : classified.state}` };
  }
  if (String(status || '').toLowerCase() !== 'closed') {
    return { ...base, decision: 'skip:not-closed', reason: `a ${status || 'unknown'} bead is not a closure record` };
  }
  if (!proof || proof.state !== 'proven') {
    return { ...base, decision: 'review:unproven', reason: 'the last word says the work is not in the trunk and no evidence in this clone contradicts it' };
  }
  return { ...base, decision: 'supersede', reason: `${proof.method} proves ${proof.sha}` };
}

/**
 * The comment the tool writes. Deterministic and factual: it names the sha it proved, HOW it proved it,
 * and says plainly that the status is unchanged - because "closed" was right and only the closing text
 * was wrong. It also says what the earlier note was actually about, so a later reader is not left with
 * two contradictory sentences and no way to choose.
 */
export function formatSupersede({ bead, proof, ref, refSha: trunk }) {
  const short = (sha) => String(sha).slice(0, 8);
  const evidence = proof.method === 'subject-landing'
    ? `its work is in the trunk: the landing commit for it is ${proof.sha} (${short(proof.sha)}), whose subject names this bead ("${String(proof.subject || '').replace(/\s+/g, ' ').trim()}") and which is an ancestor of ${ref}@${short(trunk)}`
    : `its landing commit ${short(proof.sha)} IS an ancestor of ${ref}@${short(trunk)} (git merge-base --is-ancestor ${short(proof.sha)} ${ref} -> 0)`;
  return [
    `${MARKER} (tools/closure-claims.mjs, airhorn-3di8). This bead's last word before this comment was a merger stale-clearance note - a "QUEUE STALE ... it is NOT in origin/master@<baseline> ... merge-blocked" note - and it now misreads: ${evidence}.`,
    '',
    'That earlier note was CORRECT when written: it answered "can this clearance land this historical commit NOW?", and a clearance pinned on an ancestor cannot land a carrier that has moved. It never answered "will the work reach master?". A later carrier merged that content, which is what this comment records.',
    '',
    'The STATUS is unchanged (closed) - this is a record correction, not a reopen, and nothing is requeued. Read the trunk commit above as this bead\'s landing.',
  ].join('\n');
}

/**
 * Read the tracker ONCE, then classify and decide each candidate. `deps` is injectable so the tests can
 * drive the whole pass against fixtures without touching this project's tracker.
 */
export function collect({ cwd, options, ref, trunk, deps }) {
  const records = deps.exportIssues({ cwd });
  const byId = new Map((Array.isArray(records) ? records : []).map((record) => [record.id, record]));
  const rows = [];
  for (const record of selectCandidates({ cwd, options, byId, deps })) {
    const comments = normaliseComments(record.comments);
    const word = lastWord(comments);
    const classified = word ? classifyNote(word.text) : { state: 'other', pinned: [] };
    const closed = String(record.status || '').toLowerCase() === 'closed';
    const proof = classified.state === 'stale-clearance' && closed
      ? proveInTrunk({ cwd, ref, beadId: record.id, pinned: classified.pinned })
      : null;
    const row = decideBead({ beadId: record.id, status: record.status, comments, proof });
    if (row.decision === 'supersede') row.comment = formatSupersede({ bead: record.id, proof, ref, refSha: trunk });
    rows.push(row);
  }
  return rows;
}

/**
 * The beads to read: one id, the ids a carrier's range names, or the closure record of a window. Every
 * selection is filtered through the tracker, so an id the record does not contain is not read at all.
 */
export function selectCandidates({ cwd, options, byId, deps }) {
  if (options.bead) {
    const record = byId.get(options.bead);
    if (!record) throw new Error(`no bead ${options.bead} in this tracker`);
    return [record];
  }
  if (options.carrier) {
    const range = /\.\./.test(options.carrier) ? options.carrier : `${options.carrier}^1..${options.carrier}`;
    const ids = beadIdsInRange(cwd, range, { prefix: options.idPrefix || deps.issuePrefix({ cwd }) });
    return ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
  }
  const since = String(options.since || '').slice(0, 10);
  return [...byId.values()].filter((record) => {
    if (String(record.status || '').toLowerCase() !== 'closed') return false;
    const closedAt = String(record.closed_at || '').slice(0, 10);
    return closedAt && closedAt >= since;
  });
}

const USAGE = 'usage: node tools/closure-claims.mjs [--ref <ref>] [--since <date>] [--carrier <sha|range>] [--bead <id>] [--id-prefix <prefix>] [--apply] [--json] [--require-clear]';

export function parseArgs(argv) {
  const options = { ref: null, since: null, carrier: null, bead: null, idPrefix: null, apply: false, json: false, requireClear: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--ref': options.ref = take(); break;
      case '--since': options.since = take(); break;
      case '--carrier': options.carrier = take(); break;
      case '--bead': options.bead = take(); break;
      case '--id-prefix': options.idPrefix = take(); break;
      case '--apply': options.apply = true; break;
      case '--json': options.json = true; break;
      case '--require-clear': options.requireClear = true; break;
      case '--help': case '-h': options.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.bead && options.carrier) throw new Error('--bead and --carrier select different populations; pick one');
  return options;
}

/** The default window: a bead closed in the last fortnight is still recent enough to be read. */
export function defaultSince(now = Date.now(), days = 14) {
  return new Date(now - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function summarise(rows) {
  const counts = Object.fromEntries(DECISIONS.map((decision) => [decision, 0]));
  for (const row of rows) counts[row.decision] += 1;
  return { beads: rows.length, pending: counts.supersede, unproven: counts['review:unproven'], counts };
}

function formatRow(row) {
  const proof = row.proof && row.proof.state === 'proven'
    ? `${row.proof.method}(${String(row.proof.sha).slice(0, 8)})`
    : (row.proof && row.proof.attempts && row.proof.attempts[0]) || '-';
  return [
    row.bead.padEnd(18),
    (row.status || '-').padEnd(8),
    (row.at || '-').slice(0, 16).padEnd(18),
    (row.lastWordState || '-').padEnd(16),
    row.decision.padEnd(20),
    proof,
  ].join(' ');
}

export function main(argv = process.argv.slice(2), options = {}) {
  const cwd = options.cwd || process.cwd();
  const deps = { ...defaultDeps, ...(options.deps || {}) };
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`closure-claims: ${error.message}`);
    console.error(USAGE);
    return 2;
  }
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (!parsed.since) parsed.since = defaultSince();
  let ref;
  let trunk;
  try {
    ref = resolveRef(cwd, parsed.ref);
    trunk = refSha(cwd, ref);
  } catch (error) {
    console.error(`closure-claims: ${error.message}`);
    return 2;
  }
  let rows;
  try {
    rows = collect({ cwd, options: parsed, ref, trunk, deps });
  } catch (error) {
    console.error(`closure-claims: ${error.message}`);
    return 2;
  }
  const summary = summarise(rows);
  const written = [];
  if (parsed.apply) {
    for (const row of rows.filter((candidate) => candidate.decision === 'supersede')) {
      deps.writeComment({ cwd, id: row.bead, text: row.comment });
      written.push(row.bead);
    }
  }
  if (parsed.json) {
    console.log(JSON.stringify({ ref, trunk, rows, summary, written }, null, 2));
  } else {
    const how = parsed.carrier ? `carrier ${parsed.carrier}` : parsed.bead ? `bead ${parsed.bead}` : `closed since ${parsed.since}`;
    console.log(`closure-claims: ${summary.beads} bead(s) from ${how}, against ${ref}@${trunk.slice(0, 8)}`);
    for (const row of rows) {
      console.log(`  ${formatRow(row)}`);
      if (row.decision === 'review:unproven') console.log(`    ! ${row.reason}`);
    }
    if (summary.pending === 0) {
      console.log(`  no closed bead's last word is contradicted by ${ref}`);
    } else {
      console.log(`  ${summary.pending} bead(s) can be superseded${parsed.apply ? '' : '; re-run with --apply to write the comment(s)'}`);
    }
    if (written.length) {
      console.log(`  wrote ${written.length} comment(s): ${written.join(', ')}`);
      console.log('  next: bd dolt push  (an unsynced comment is not a record)');
    }
  }
  if (parsed.requireClear && summary.pending > 0) return 1;
  return 0;
}

/**
 * The `bd`-backed data access. One `bd export --json` reads every issue WITH its comments (~1.6 s for
 * this repo's ~1000 beads), which is why the sweep is seconds and not one bd call per bead (that shape
 * measured 8m19s for the same window). Injected wholesale in the tests.
 */
export const defaultDeps = {
  exportIssues({ cwd }) {
    const result = run('bd', ['export', '--json'], { cwd });
    if (!result.ok) throw new Error(`bd export --json failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  },
  issuePrefix({ cwd }) {
    const result = run('bd', ['config', 'list'], { cwd });
    if (!result.ok) return null;
    const match = result.stdout.match(/^\s*issue_prefix\s*=\s*(\S+)\s*$/m);
    return match ? match[1] : null;
  },
  writeComment({ cwd, id, text }) {
    const result = run('bd', ['comment', id, '--stdin'], { cwd, input: text });
    if (!result.ok) throw new Error(`bd comment ${id} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout.trim();
  },
};

const invokedDirectly = process.argv[1] && /closure-claims\.mjs$/.test(process.argv[1]);
if (invokedDirectly) process.exitCode = main();
