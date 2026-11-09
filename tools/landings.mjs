#!/usr/bin/env node
/**
 * tools/landings.mjs — answer "was this landing gated?" from the record that already exists.
 *
 * airhorn-32wa. Measured during airhorn-v6iv: for the 37 merges in the week to 2026-11-01,
 * `fleet-check --status --fast <merge-tip>` answered PASS for 4, FAIL for 3, INTERRUPTED for 2 and
 * NONE/UNKNOWN for 18, and the oldest surviving fast-gate log was 2026-10-27. That absence is NOT
 * "never verified": the verdict cache is keyed by TREE and its records/logs are pruned, so a week-old
 * answer disappears with the tree it described.
 *
 * The cache was never the record. `fleet-land-message` writes the gate verdict, the reviewer verdict,
 * the bead and the branch into the MERGE COMMIT MESSAGE, and a commit is immutable, travels with every
 * clone and is greppable a year later:
 *
 *   GATE
 *   PASS (full gate) for tree 3da95967... (cached for commit 54fd6ad) in 329s run by merger at ...
 *   Log /home/exedev/.fleet/checks/3da95967....log
 *   Identity commit ref origin/fleet/<branch>; tree 3da95967... matches landing HEAD tree 3da95967...
 *
 * Nothing read it back, so the question was answered against the transient cache instead. This tool
 * reads the durable record and classifies every first-parent fleet landing:
 *
 *   gated            the message records PASS for THIS commit's own tree — the run describes the
 *                    landed content, exactly.
 *   gated-in-batch   no own verdict (the batch's intermediate merges carry a "no cached verdict yet"
 *                    placeholder); a NEWER first-parent landing records PASS on its own tree and this
 *                    commit is one of its ancestors. The fleet lands a batch oldest-first and gates the
 *                    UNION once, so that one run covered this content. The covering commit is named.
 *   gated-other-tree PASS is recorded, but for a DIFFERENT tree than this commit's, so the evidence
 *                    describes other content and does not answer for this landing.
 *   gate-failed      the message records a non-PASS verdict (FAIL, INTERRUPTED, ...) for the landing.
 *   ungated          no gate evidence in the message and no covering gate — the truthful answer.
 *
 * REVIEW is reported beside it (review-pass / review-pass-with-notes / review-fail / no-review),
 * because the weekly review has to separate "verified by the gate" from "verified by focused evidence
 * after landing", and a landing can be one without being the other.
 *
 * Limits, stated rather than implied. A commit-message verdict is what the landing lane RECORDED — it
 * is not a re-run, so this tool cannot prove the gate was honest, only that the record exists and that
 * the tree it names is the tree that landed. `gated-in-batch` proves the content was inside a tree that
 * passed; it cannot see a revert in between, so the covering commit is printed for a human to check.
 * Non-fleet merges (no `Merge fleet/...` and no BEAD block) are not landings and are counted as
 * skipped, never assumed green. Landings made before the generator wrote structured blocks report
 * `form: absent` for the gate and `no-review` for the review, which is what their record can say.
 *
 * Usage:
 *   node tools/landings.mjs                        # every fleet landing on the trunk, newest first
 *   node tools/landings.mjs --since 2026-10-25 --until 2026-11-01
 *   node tools/landings.mjs --bead airhorn-e2ir     # one landing (bead id, prefix or branch name)
 *   node tools/landings.mjs --json                  # machine-readable rows + summary
 *   node tools/landings.mjs --require-gate          # exit 1 unless every landing has gate evidence
 *   node tools/landings.mjs --ref origin/master     # walk another trunk (default: origin/master, else HEAD)
 *
 * Exit codes: 0 = read succeeded (and, with --require-gate, every landing has gate evidence);
 *             1 = --require-gate found a landing with no usable gate evidence; 2 = usage/ref error.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Section labels `fleet-land-message` writes, longest first so a prefix cannot shadow a longer label. */
const SECTION_LABELS = [
  'BATCH GATE SCOPE AND HOST',
  'USER-VISIBLE EFFECT',
  'WHAT CHANGED',
  'RELEASE-NOTE',
  'SUMMARY',
  'REVIEW',
  'BRANCH',
  'BEAD',
  'WHY',
  'GATE',
];

/** Fleet landing evidence states, in the order the summary reports them. */
export const GATE_STATES = ['gated', 'gated-in-batch', 'gated-other-tree', 'gate-failed', 'ungated'];

/** Reviewer evidence states. Reported beside the gate: a landing can have one without the other. */
export const REVIEW_STATES = ['review-pass', 'review-pass-with-notes', 'review-fail', 'no-review'];

/** A landing whose recorded gate evidence answers for its own landed tree. */
const GATE_SATISFIED = new Set(['gated', 'gated-in-batch']);

function sectionHeader(line) {
  const text = line.trim();
  if (!text) return null;
  // A labelled block can put its first line on the header line (`BRANCH fleet/<x> (tip <sha>, ...)`)
  // or below it (`GATE` then the verdict). Longest label first so 'BATCH GATE SCOPE AND HOST' is not
  // read as a 'GATE' block, and SUMMARY carries a provenance suffix of its own.
  for (const label of SECTION_LABELS) {
    if (text === label) return { label, rest: '' };
    if (text.startsWith(`${label} `)) return { label, rest: text.slice(label.length + 1) };
  }
  return null;
}

/**
 * Split a landing commit message into its labelled blocks. Unknown prose is kept under
 * '' so a message with no sections is not silently treated as empty.
 */
export function parseSections(body) {
  const sections = {};
  let current = '';
  for (const line of String(body || '').split('\n')) {
    const header = sectionHeader(line);
    if (header) {
      current = header.label;
      if (!sections[current]) sections[current] = [];
      if (header.rest) sections[current].push(header.rest);
      continue;
    }
    if (!sections[current]) sections[current] = [];
    sections[current].push(line);
  }
  const out = {};
  for (const [key, lines] of Object.entries(sections)) out[key] = lines.join('\n').trim();
  return out;
}

/** The first non-empty line of a block, or ''. */
function firstLine(block) {
  return String(block || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
}

/**
 * Read a GATE block. A pass is recognised structurally — verdict word, gate kind, and the tree it
 * ran on — never by searching the prose for the word "pass": the placeholder block the generator
 * writes for a batch's intermediate merges literally says "NOT a pass" and must not be read as one.
 */
export function parseGate(block, { present = true } = {}) {
  const lines = String(block || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const verdict = lines[0] || '';
  const verdictMatch = verdict.match(/^(PASS|FAIL)\b.*?\((full|fast) gate\)/);
  if (!verdictMatch) {
    // `absent` = the message has no GATE block at all (a landing made before the generator wrote
    // one); `placeholder` = the generator's "no cached verdict yet" line for a batch's inner merges.
    // They are different absences and the weekly review must not read one as the other.
    return { state: 'unrecorded', form: present ? 'placeholder' : 'absent', verdict, kind: null, tree: null, commit: null, at: null, log: null };
  }
  const joined = lines.join(' ');
  const tree = (joined.match(/for tree ([0-9a-f]{40})/) || [])[1] || null;
  const commit = (joined.match(/cached for commit ([0-9a-f]{7,40})/) || [])[1] || null;
  const at = (joined.match(/run by merger at (\S+)/) || [])[1] || null;
  const log = (lines.find((line) => /^Log \S+/.test(line)) || '').replace(/^Log /, '') || null;
  return {
    state: verdictMatch[1] === 'PASS' ? 'pass' : 'fail',
    form: 'verdict',
    verdict,
    kind: verdictMatch[2],
    tree,
    commit,
    at,
    log,
  };
}

/** Read a REVIEW block into its verdict and its provenance. */
export function parseReview(block) {
  const verdict = firstLine(block);
  const match = verdict.match(/^(PASS|FAIL)\b(?:.*?\(verdict: ([^)]+)\))?/);
  if (!match) return { state: 'no-review', verdict, commit: null, lane: null, reviewer: null };
  const state = match[1] === 'PASS'
    ? (match[2] && /notes/i.test(match[2]) ? 'review-pass-with-notes' : 'review-pass')
    : 'review-fail';
  return {
    state,
    verdict,
    commit: (verdict.match(/for commit ([0-9a-f]{7,40})/) || [])[1] || null,
    lane: (verdict.match(/ by (\S+) at /) || [])[1] || null,
    reviewer: (verdict.match(/\[reviewer ([^\];]+)/) || [])[1] || null,
  };
}

/**
 * Parse one landing commit into a record. `tree` must be the commit's own tree
 * (`git rev-parse <sha>^{tree}`): comparing it with the recorded gate tree is the only thing that
 * makes the verdict a statement about THIS landing.
 */
export function parseLandingMessage({ sha, tree, date, subject, body }) {
  const sections = parseSections(body);
  const title = /^Merge (\S+) \(([^)]+)\)/.exec(subject || '');
  const beadBlock = firstLine(sections.BEAD || '');
  const bead = (title && title[2]) || (beadBlock.match(/^([A-Za-z][\w.-]*-\w+)/) || [])[1] || null;
  const branch = (title && title[1]) || (firstLine(sections.BRANCH || '').match(/^(\S+)/) || [])[1] || null;
  const tip = (firstLine(sections.BRANCH || '').match(/\btip ([0-9a-f]{7,40})/) || [])[1] || null;
  const gate = parseGate(sections.GATE || '', { present: Object.prototype.hasOwnProperty.call(sections, 'GATE') });
  const review = parseReview(sections.REVIEW || '');
  const isFleetLanding = Boolean(title && title[1].startsWith('fleet/')) || Boolean(beadBlock.match(/^[A-Za-z][\w.-]*-\w+/));
  return {
    sha,
    tree,
    date,
    subject: subject || '',
    bead,
    branch,
    tip,
    gate,
    review,
    isFleetLanding,
    batchNote: sections['BATCH GATE SCOPE AND HOST'] || '',
  };
}

/**
 * Classify landings, newest first. Coverage walks FORWARD (towards newer commits) because a batch's
 * gate is the union of the merges before it: an intermediate merge's own message carries a placeholder.
 * On a first-parent chain a newer merge is by construction a descendant, so "the covering gate's tree
 * contains this commit" needs no extra ancestry query.
 */
export function classifyLandings(landings) {
  return landings.map((landing, index) => {
    const { gate } = landing;
    const ownTreeMatch = gate.state === 'pass' && gate.tree === landing.tree;
    let state;
    let coveredBy = null;
    let coveredByNamesIt = null;

    if (ownTreeMatch) {
      state = 'gated';
    } else if (gate.state === 'fail') {
      state = 'gate-failed';
    } else if (gate.state === 'pass') {
      // A verdict exists but for a different tree. It cannot answer for this landing, and it is a record
      // anomaly in its own right, so it outranks a covering batch gate (which the JSON still reports).
      state = 'gated-other-tree';
    } else {
      for (let newer = index - 1; newer >= 0; newer -= 1) {
        const candidate = landings[newer];
        if (candidate.gate.state === 'pass' && candidate.gate.tree === candidate.tree) {
          coveredBy = candidate.sha;
          // Informational only: the ancestry is the evidence, this just shows whether the covering
          // message names this landing explicitly.
          const needles = [landing.bead, landing.branch].filter(Boolean);
          coveredByNamesIt = needles.length > 0 && needles.some((needle) => candidate.batchNote.includes(needle) || candidate.subject.includes(needle));
          break;
        }
      }
      state = coveredBy ? 'gated-in-batch' : 'ungated';
    }

    return { ...landing, state, coveredBy, coveredByNamesIt };
  });
}

/** Counts by gate state (and by review verdict) plus the landings a reader must look at. */
export function summarise(rows) {
  const byState = Object.fromEntries(GATE_STATES.map((state) => [state, 0]));
  const byReview = Object.fromEntries(REVIEW_STATES.map((state) => [state, 0]));
  for (const row of rows) {
    byState[row.state] += 1;
    byReview[row.review.state] = (byReview[row.review.state] || 0) + 1;
  }
  return {
    total: rows.length,
    byState,
    byReview,
    needsAttention: rows.filter((row) => !GATE_SATISFIED.has(row.state)).map((row) => row.sha),
  };
}

function git(args, cwd) {
  // stderr is dropped: resolveRef probes candidate refs that may not exist, and a missing candidate
  // is an expected answer, not output. Real failures still surface as a thrown error with its status.
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** The trunk to walk: an explicit ref, else origin/master, else master, else HEAD. */
export function resolveRef(cwd, requested) {
  if (requested) {
    git(['rev-parse', '--verify', `${requested}^{commit}`], cwd);
    return requested;
  }
  for (const candidate of ['origin/master', 'master', 'HEAD']) {
    try {
      git(['rev-parse', '--verify', `${candidate}^{commit}`], cwd);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('no trunk ref found (tried origin/master, master, HEAD)');
}

/** Every first-parent merge on the trunk, newest first, parsed. */
export function readLandings(cwd, ref) {
  const raw = git(
    ['log', '--first-parent', '--merges', '--format=%H%x1f%T%x1f%cI%x1f%s%x1f%B%x1e', ref],
    cwd
  );
  return raw
    .split('\x1e')
    .map((record) => record.replace(/^\n+/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha, tree, date, subject, ...rest] = record.split('\x1f');
      return parseLandingMessage({ sha, tree, date, subject, body: rest.join('\x1f') });
    });
}

/** Inclusive date bounds. A date-only --until includes that whole UTC day. */
export function withinRange(date, since, until) {
  const at = new Date(date).getTime();
  if (Number.isNaN(at)) return true;
  if (since) {
    const from = new Date(since).getTime();
    if (!Number.isNaN(from) && at < from) return false;
  }
  if (until) {
    let to = new Date(until);
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(until))) to = new Date(`${until}T23:59:59.999Z`);
    const limit = to.getTime();
    if (!Number.isNaN(limit) && at > limit) return false;
  }
  return true;
}

const USAGE = 'usage: node tools/landings.mjs [--ref <ref>] [--since <date>] [--until <date>] [--bead <id|branch>] [--limit <n>] [--json] [--require-gate]';

export function parseArgs(argv) {
  const options = { ref: null, since: null, until: null, bead: null, limit: null, json: false, requireGate: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case 'audit': break;
      case '--ref': options.ref = take(); break;
      case '--since': options.since = take(); break;
      case '--until': options.until = take(); break;
      case '--bead': options.bead = take(); break;
      case '--limit': {
        const value = Number(take());
        if (!Number.isInteger(value) || value < 1) throw new Error('--limit needs a positive integer');
        options.limit = value;
        break;
      }
      case '--json': options.json = true; break;
      case '--require-gate': options.requireGate = true; break;
      case '--help': case '-h': options.help = true; break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function formatRow(row) {
  const gate = row.state === 'gated-in-batch' ? `${row.state}(${(row.coveredBy || '').slice(0, 8)})` : row.state;
  return [
    (row.date || '').slice(0, 10),
    row.sha.slice(0, 8),
    (row.bead || '-').padEnd(18),
    gate.padEnd(28),
    row.review.state.padEnd(24),
    row.subject.replace(/\s+/g, ' ').slice(0, 60),
  ].join(' ');
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const ref = resolveRef(cwd, options.ref);
  const all = readLandings(cwd, ref);
  const fleet = all.filter((landing) => landing.isFleetLanding);
  const classified = classifyLandings(fleet);

  let rows = classified.filter((row) => withinRange(row.date, options.since, options.until));
  if (options.bead) {
    const needle = options.bead;
    rows = rows.filter((row) => (row.bead && row.bead.startsWith(needle)) || (row.branch && row.branch.includes(needle)));
  }
  if (options.limit) rows = rows.slice(0, options.limit);

  const summary = summarise(rows);

  if (options.json) {
    console.log(JSON.stringify({
      ref,
      summary,
      skippedNonFleetMerges: all.length - fleet.length,
      landings: rows.map((row) => ({
        sha: row.sha,
        tree: row.tree,
        date: row.date,
        subject: row.subject,
        bead: row.bead,
        branch: row.branch,
        tip: row.tip,
        state: row.state,
        gate: row.gate,
        review: row.review,
        coveredBy: row.coveredBy,
        coveredByNamesIt: row.coveredByNamesIt,
      })),
    }, null, 2));
  } else {
    console.log(`landings: ${ref} — ${summary.total} fleet landing(s) shown; ${all.length - fleet.length} non-fleet merge(s) on the trunk skipped`);
    for (const row of rows) console.log(formatRow(row));
    const counts = GATE_STATES.map((state) => `${state} ${summary.byState[state]}`).join(', ');
    const reviews = REVIEW_STATES.map((state) => `${state} ${summary.byReview[state]}`).join(', ');
    console.log(`landings: gate — ${counts}`);
    console.log(`landings: review — ${reviews}`);
    if (summary.needsAttention.length > 0) {
      console.log(`landings: NO USABLE GATE EVIDENCE for ${summary.needsAttention.length}: ${summary.needsAttention.map((sha) => sha.slice(0, 8)).join(' ')}`);
    }
  }

  if (options.requireGate && summary.needsAttention.length > 0) {
    if (options.json) {
      // JSON consumers get one loud line on stderr rather than a polluted document on stdout.
      console.error(`landings: NO USABLE GATE EVIDENCE for ${summary.needsAttention.length} landing(s)`);
    }
    return 1;
  }
  return 0;
}

// Guard main() so importing the pure parse/classify functions is side-effect free (airhorn-fc98).
// The realpath comparison is wrapped because argv[1] can be a path that does not exist (stdin/eval
// imports), where an unguarded realpathSync throws ENOENT before the guard can answer (airhorn-nqnt).
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
const invokedAsScript = invokedDirectly();
if (invokedAsScript) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`landings: ${error && error.message ? error.message : error}`);
    process.exitCode = 2;
  }
}
