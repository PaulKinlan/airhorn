// tests/closure-claims.test.mjs — airhorn-3di8.
//
// The class: a bead can be CLOSED with the merger's stale-clearance note as its last word - "QUEUE STALE
// ... it is NOT in origin/master@<baseline> ... merge-blocked" - and the work then lands in a later
// carrier. The status is right; the closing TEXT reads as "this never landed". tools/closure-claims.mjs
// finds that state (closed + a last word that claims the trunk does not have the work) and only writes a
// correction when the trunk PROVES the claim false.
//
// Every text fixture below is a verbatim record from this project's tracker (airhorn-jmpm,
// 2026-11-11), so the classifier is pinned to the shape that actually occurs rather than to a shape
// invented for a test. The git and tracker halves are exercised against throwaway fixtures - a temp
// repository and a stub `bd` on PATH - never this checkout's history, this project's tracker, or another
// suite's files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  stripCitations,
  pinnedShas,
  classifyNote,
  normaliseComments,
  lastWord,
  beadIdsInRange,
  proveInTrunk,
  decideBead,
  formatSupersede,
  selectCandidates,
  parseArgs,
  defaultSince,
  summarise,
  main,
} from '../tools/closure-claims.mjs';

const TOOL = fileURLToPath(new URL('../tools/closure-claims.mjs', import.meta.url));

// airhorn-jmpm, airhorn-merger, 2026-11-11T14:14:19Z - the note that starts the class.
const STALE_NOTE =
  'QUEUE STALE: cleared:be942892 pins an ancestor of origin/fleet/impl-del@34a10e8b (branch moved since clearance), no corresponding branch points at this sha and it is NOT in origin/master@e2b5ad0d. Cannot independently land a historical commit by assuming the moved carrier\'s contents were reviewed. Cleared and merge-queue removed, merge-blocked. Owner/coord next action: consolidate into ONE immutable fleet carrier tip, author truthful LAND-SUMMARY for the whole delta, independent cross-family full-carrier verdict, then requeue; individual findings are COVERED BY after actual landing, not independently MERGED.';

// The two hand-written corrections that followed it on the same bead (airhorn-land2, same day). They
// QUOTE the stale note, which is how this tool tells "reporting the note" from "making the claim".
const LONG_CORRECTION =
  'RECORD CORRECTION (audit airhorn-k1wo, baseline origin/master 8b7ef0b2). The last comment on this bead is a merger "QUEUE STALE ... it is NOT in origin/master@e2b5ad0d ... merge-blocked" note. That was true at 14:15Z and is FALSE now: this bead\'s landing commit is an ancestor of origin/master and its contents are in the tree.';

const SHORT_CORRECTION =
  "CORRECTION (coord audit): this bead's content IS in master be942892; the 'QUEUE STALE / NOT in origin/master' note above was about a stale QUEUE ENTRY at the time, not about the work. Landing verified by ancestry be942892 and content grep on 8b7ef0b2.";

// ---------------------------------------------------------------------------------------------
// Reading a comment as a claim about the trunk.
// ---------------------------------------------------------------------------------------------

test('the merger stale-clearance note is a claim about the trunk, and it names the commit it is about', () => {
  const note = classifyNote(STALE_NOTE);
  assert.equal(note.state, 'stale-clearance');
  // `cleared:<sha>` is the commit the clearance pinned - the bead's landing commit. The note's other two
  // shas are context (the moved branch tip, the baseline master), not the commit under discussion.
  assert.deepEqual(note.pinned, [{ role: 'cleared', sha: 'be942892' }]);
});

test('a correction that QUOTES the stale note is not read as a fresh stale claim', () => {
  // The long correction quotes in double quotes and is a REPORT; the short one quotes in single quotes
  // and announces itself. Neither may be re-corrected - that is the duplicate-noise failure this tool
  // would otherwise cause on the seven beads already fixed by hand.
  assert.notEqual(classifyNote(LONG_CORRECTION).state, 'stale-clearance');
  assert.equal(classifyNote(SHORT_CORRECTION).state, 'superseded');
});

test('citations are stripped, and stripping can only hide a marker, never invent one', () => {
  assert.doesNotMatch(stripCitations('the note said "QUEUE STALE and is NOT in origin/master" here'), /QUEUE STALE/);
  assert.doesNotMatch(stripCitations('as `git merge-base --is-ancestor` shows'), /is-ancestor/);
  assert.doesNotMatch(stripCitations('> QUEUE STALE: it is NOT in origin/master@abc1234'), /QUEUE STALE/);
  // Prose with no citation survives untouched.
  assert.match(stripCitations('QUEUE STALE: cleared:be942892'), /QUEUE STALE/);
});

test('merge-blocked alone is a conflict note, and a conflict note makes no claim about the trunk', () => {
  const conflict = classifyNote('Merge conflict in src/horn.js; aborted the merge, removed merge-queue, merge-blocked. Owner/coord next action: rebase on master and requeue.');
  assert.equal(conflict.state, 'other');
  assert.equal(conflict.pinned.length, 0);
});

test('a landing claim is "landed", not a stale claim', () => {
  assert.equal(classifyNote('MERGED at be942892; the content is in origin/master and the bead is closed.').state, 'landed');
  assert.equal(classifyNote('COVERED BY e95664b0, an ancestor of master.').state, 'landed');
});

test('a correction marker wins even when the stale wording is unquoted', () => {
  const own = `SUPERSEDED-BY-LANDING (tools/closure-claims.mjs). QUEUE STALE: this is NOT in origin/master, it said.`;
  assert.equal(classifyNote(own).state, 'superseded');
  assert.equal(classifyNote('Superseded: the earlier note said it is NOT in origin/master.').state, 'superseded');
});

test('pinned commits are read by role, most specific first, without duplicates', () => {
  assert.deepEqual(pinnedShas('cleared:abc1234 and tip def5678'), [
    { role: 'cleared', sha: 'abc1234' },
    { role: 'tip', sha: 'def5678' },
  ]);
  assert.deepEqual(pinnedShas('cleared:abc1234, cleared:abc1234'), [{ role: 'cleared', sha: 'abc1234' }]);
  // The baseline master and a moved branch tip are context, not the pinned commit.
  assert.deepEqual(pinnedShas('NOT in origin/master@e2b5ad0d'), []);
});

test('comments are ordered oldest first and the last word is the newest one', () => {
  const comments = normaliseComments([
    { author: 'b', created_at: '2026-11-11T15:00:00Z', text: 'second' },
    { author: 'a', created_at: '2026-11-11T14:00:00Z', text: 'first' },
  ]);
  assert.deepEqual(comments.map((comment) => comment.text), ['first', 'second']);
  assert.equal(lastWord(comments).text, 'second');
  assert.equal(lastWord([]), null);
});

// ---------------------------------------------------------------------------------------------
// The decision: closed + a stale last word + proof. Any one missing means no write.
// ---------------------------------------------------------------------------------------------

const PROVEN = { state: 'proven', method: 'cleared-ancestry', sha: 'be942892aaaa' };
const UNPROVEN = { state: 'unproven', method: null, sha: null, attempts: ['pinned cleared commit abc is NOT an ancestor of origin/master'] };
const commentsOf = (...texts) => normaliseComments(texts.map((text, index) => ({
  author: 'fixture',
  created_at: `2026-11-11T1${index}:00:00Z`,
  text,
})));

test('a closed bead whose last word is a stale note, with proof, is superseded', () => {
  const row = decideBead({ beadId: 'airhorn-jmpm', status: 'closed', comments: commentsOf(STALE_NOTE), proof: PROVEN });
  assert.equal(row.decision, 'supersede');
  assert.equal(row.lastWordState, 'stale-clearance');
  assert.equal(row.reason, 'cleared-ancestry proves be942892aaaa');
});

test('a stale last word that the trunk does not contradict is reported, never written', () => {
  const row = decideBead({ beadId: 'airhorn-x', status: 'closed', comments: commentsOf(STALE_NOTE), proof: UNPROVEN });
  assert.equal(row.decision, 'review:unproven');
  assert.match(row.reason, /no evidence in this clone contradicts it/);
});

test('an open bead is not a closure record, however stale its last word', () => {
  const row = decideBead({ beadId: 'airhorn-x', status: 'open', comments: commentsOf(STALE_NOTE), proof: PROVEN });
  assert.equal(row.decision, 'skip:not-closed');
});

test('a bead already corrected by hand is a no-op', () => {
  const row = decideBead({ beadId: 'airhorn-jmpm', status: 'closed', comments: commentsOf(STALE_NOTE, SHORT_CORRECTION), proof: PROVEN });
  assert.equal(row.decision, 'skip:last-word-ok');
  assert.equal(row.lastWordState, 'superseded');
});

test('a bead with no comments is not a closure record to correct', () => {
  const row = decideBead({ beadId: 'airhorn-x', status: 'closed', comments: [], proof: PROVEN });
  assert.equal(row.decision, 'skip:last-word-ok');
});

test('the written comment names the proof, its method, and says the status is unchanged', () => {
  const ancestry = formatSupersede({ bead: 'airhorn-jmpm', proof: PROVEN, ref: 'origin/master', refSha: '8b7ef0b2cccc' });
  assert.match(ancestry, /^SUPERSEDED-BY-LANDING/);
  assert.match(ancestry, /be942892 IS an ancestor of origin\/master@8b7ef0b2/);
  assert.match(ancestry, /STATUS is unchanged \(closed\)/);
  assert.match(ancestry, /never answered "will the work reach master\?"/);

  // The weaker proof says which one it used, so a reader is not told more than was checked.
  const subject = formatSupersede({
    bead: 'airhorn-jmpm',
    proof: { state: 'proven', method: 'subject-landing', sha: 'f'.repeat(40), subject: 'Merge fleet/batch-six (airhorn-jmpm): nine beads' },
    ref: 'origin/master',
    refSha: '8b7ef0b2cccc',
  });
  assert.match(subject, /whose subject names this bead/);
  assert.doesNotMatch(subject, /IS an ancestor of origin\/master@8b7ef0b2 \(git merge-base/);
});

// ---------------------------------------------------------------------------------------------
// Proof against a throwaway repository. Ancestry is the only thing that can answer "did it land".
// ---------------------------------------------------------------------------------------------

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...env },
  });
}

function commit(dir, file, content, message, date) {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ['add', file]);
  git(dir, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

function fixtureRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airhorn-closure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '-b', 'master']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['config', 'user.name', 'Fixture']);
  commit(dir, 'base.txt', 'base\n', 'base commit', '2026-11-01T00:00:00+00:00');
  return dir;
}

/**
 * An abandoned branch nobody merged, then a batch carrier that brings three inner commits in through its
 * second parent - the real shape (e95664b0's range is what names the nine beads, not master's own line).
 */
function buildHistory(t) {
  const dir = fixtureRepo(t);
  git(dir, ['checkout', '-q', '-b', 'fleet/abandoned']);
  commit(dir, 'abandoned.txt', 'abandoned\n', 'airhorn-aabn: work nobody landed', '2026-11-01T01:00:00+00:00');
  const abandoned = git(dir, ['rev-parse', 'HEAD']).trim();

  git(dir, ['checkout', '-q', 'master']);
  git(dir, ['checkout', '-q', '-b', 'fleet/batch-six']);
  commit(dir, 'inner.txt', 'inner\n', 'airhorn-61m1: pin the HTTP leg', '2026-11-10T10:00:00+00:00');
  const landed = git(dir, ['rev-parse', 'HEAD']).trim();
  commit(dir, 'more.txt', 'more\n', 'mutation-check: refuse a test-file target (airhorn-29nt, airhorn-da6c)', '2026-11-10T11:00:00+00:00');
  commit(dir, 'batch.txt', 'batch\n', 'airhorn-7fol: the SW stamp proves the served worker', '2026-11-11T10:00:00+00:00');

  git(dir, ['checkout', '-q', 'master']);
  git(dir, ['merge', '--no-ff', '-q', '-m', 'Merge fleet/batch-six (airhorn-7fol): nine beads in one frozen range', 'fleet/batch-six'], {
    GIT_AUTHOR_DATE: '2026-11-11T12:00:00+00:00',
    GIT_COMMITTER_DATE: '2026-11-11T12:00:00+00:00',
  });
  const carrier = git(dir, ['rev-parse', 'HEAD']).trim();
  return { dir, abandoned, landed, carrier };
}

test('the commit a stale note pins is proven in the trunk by ancestry', (t) => {
  const { dir, landed } = buildHistory(t);
  const proof = proveInTrunk({ cwd: dir, ref: 'master', beadId: 'airhorn-61m1', pinned: [{ role: 'cleared', sha: landed.slice(0, 8) }] });
  assert.equal(proof.state, 'proven');
  assert.equal(proof.method, 'cleared-ancestry');
  assert.equal(proof.sha.slice(0, 8), landed.slice(0, 8));
});

test('a pinned commit that is NOT an ancestor falls back to a trunk commit naming the bead', (t) => {
  const { dir, abandoned, carrier } = buildHistory(t);
  // airhorn-7fol's work was pinned on an abandoned commit, but the carrier merge names the bead.
  const proof = proveInTrunk({ cwd: dir, ref: 'master', beadId: 'airhorn-7fol', pinned: [{ role: 'cleared', sha: abandoned.slice(0, 8) }] });
  assert.equal(proof.state, 'proven');
  assert.equal(proof.method, 'subject-landing');
  assert.equal(proof.sha, carrier);
  assert.match(proof.attempts[0], /is NOT an ancestor of master/);
});

test('no ancestor and no subject naming the bead is "unproven" - the note may be true', (t) => {
  const { dir, abandoned } = buildHistory(t);
  const proof = proveInTrunk({ cwd: dir, ref: 'master', beadId: 'airhorn-aabn', pinned: [{ role: 'cleared', sha: abandoned.slice(0, 8) }] });
  assert.equal(proof.state, 'unproven');
  assert.equal(proof.sha, null);
  assert.match(proof.attempts.join(' '), /is NOT an ancestor of master/);
  assert.match(proof.attempts.join(' '), /no trunk commit's subject names airhorn-aabn/);
});

test('a pinned sha this clone does not contain is unproven, and says so', (t) => {
  const { dir } = buildHistory(t);
  const proof = proveInTrunk({ cwd: dir, ref: 'master', beadId: 'airhorn-zzzz', pinned: [{ role: 'cleared', sha: 'deadbeefdeadbeef' }] });
  assert.equal(proof.state, 'unproven');
  assert.match(proof.attempts[0], /does not exist in this clone/);
});

test('a carrier range names the beads its subjects name, and never an ordinary hyphenated word', (t) => {
  const { dir, carrier } = buildHistory(t);
  const ids = beadIdsInRange(dir, `${carrier}^1..${carrier}`, { prefix: 'airhorn' });
  assert.deepEqual([...ids].sort(), ['airhorn-29nt', 'airhorn-61m1', 'airhorn-7fol', 'airhorn-da6c']);
  assert.ok(!ids.includes('mutation-check'), 'a subject word that looks like an id is not one');
});

// ---------------------------------------------------------------------------------------------
// The whole pass, end to end: selection, decision, write, and idempotency.
// ---------------------------------------------------------------------------------------------

function record(id, { status = 'closed', closedAt = '2026-11-11T18:00:00Z', comments = [] } = {}) {
  return {
    id,
    status,
    closed_at: closedAt,
    comments: comments.map((text, index) => ({ author: 'fixture-merger', created_at: `2026-11-11T1${index}:00:00Z`, text })),
  };
}

/** Deps that behave like `bd` would, including persisting a written comment so a re-run sees it. */
function fakeDeps(records) {
  const written = [];
  return {
    written,
    exportIssues: () => records,
    issuePrefix: () => 'airhorn',
    writeComment: ({ id, text }) => {
      written.push({ id, text });
      const target = records.find((row) => row.id === id);
      target.comments.push({ author: 'closure-claims', created_at: '2026-11-12T00:00:00Z', text });
      return 'ok';
    },
  };
}

function capture(fn) {
  const lines = [];
  const [log, error] = [console.log, console.error];
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return { rc: fn(), out: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function buildRecords(t) {
  const { dir, landed } = buildHistory(t);
  const staleOf = (sha) => STALE_NOTE.replace('cleared:be942892', `cleared:${sha}`);
  const records = [
    record('airhorn-61m1', { comments: [STALE_NOTE.replace('cleared:be942892', `cleared:${landed.slice(0, 8)}`)] }),
    record('airhorn-aabn', { comments: [staleOf('aaaaaaa')] }),
    record('airhorn-open', { status: 'open', comments: [staleOf(landed.slice(0, 8))] }),
    record('airhorn-done', { comments: [staleOf(landed.slice(0, 8)), SHORT_CORRECTION] }),
    record('airhorn-old', { closedAt: '2026-09-01T00:00:00Z', comments: [staleOf(landed.slice(0, 8))] }),
  ];
  return { dir, records, landed };
}

test('a sweep corrects only what it can prove, and reports the rest without writing', (t) => {
  const { dir, records } = buildRecords(t);
  const deps = fakeDeps(records);
  const { rc, out } = capture(() => main(['--json', '--ref', 'master', '--since', '2026-11-01'], { cwd: dir, deps }));
  assert.equal(rc, 0);
  const json = JSON.parse(out);
  const byBead = Object.fromEntries(json.rows.map((row) => [row.bead, row]));
  // A window is the CLOSURE record, so the open bead is not in it (it is selected by --bead below).
  assert.deepEqual(Object.keys(byBead).sort(), ['airhorn-61m1', 'airhorn-aabn', 'airhorn-done']);
  assert.equal(byBead['airhorn-61m1'].decision, 'supersede');
  assert.equal(byBead['airhorn-aabn'].decision, 'review:unproven');
  assert.equal(byBead['airhorn-done'].decision, 'skip:last-word-ok');
  assert.equal(json.summary.pending, 1);
  assert.equal(json.written.length, 0, 'nothing is written without --apply');
  assert.equal(deps.written.length, 0);

  const open = JSON.parse(capture(() => main(['--json', '--bead', 'airhorn-open', '--apply', '--ref', 'master'], { cwd: dir, deps })).out);
  assert.equal(open.rows[0].decision, 'skip:not-closed', 'an open bead is not a closure record, whatever its last word');
  assert.equal(deps.written.length, 0);
});

test('--apply writes exactly the provable correction, and a second run is a no-op', (t) => {
  const { dir, records } = buildRecords(t);
  const deps = fakeDeps(records);
  const first = capture(() => main(['--json', '--apply', '--ref', 'master', '--since', '2026-11-01'], { cwd: dir, deps }));
  assert.deepEqual(JSON.parse(first.out).written, ['airhorn-61m1']);
  assert.equal(deps.written.length, 1);
  assert.equal(deps.written[0].id, 'airhorn-61m1');
  assert.match(deps.written[0].text, /SUPERSEDED-BY-LANDING/);
  assert.match(deps.written[0].text, /STATUS is unchanged \(closed\)/);

  // The written comment is now the bead's last word, so the same sweep finds nothing to do.
  const second = capture(() => main(['--json', '--apply', '--ref', 'master', '--since', '2026-11-01'], { cwd: dir, deps }));
  assert.deepEqual(JSON.parse(second.out).written, []);
  assert.equal(deps.written.length, 1, 'a re-run must not add a second correction');
});

test('--require-clear is a gate: exit 1 while a correction is outstanding, 0 once it is written', (t) => {
  const { dir, records } = buildRecords(t);
  const deps = fakeDeps(records);
  assert.equal(capture(() => main(['--require-clear', '--ref', 'master'], { cwd: dir, deps })).rc, 1);
  capture(() => main(['--apply', '--ref', 'master'], { cwd: dir, deps }));
  assert.equal(capture(() => main(['--require-clear', '--ref', 'master'], { cwd: dir, deps })).rc, 0);
});

test('usage and lookup mistakes are refused instead of silently sweeping', (t) => {
  const { dir, records } = buildRecords(t);
  const deps = fakeDeps(records);
  assert.equal(capture(() => main(['--nonsense'], { cwd: dir, deps })).rc, 2);
  assert.equal(capture(() => main(['--bead', 'airhorn-a', '--carrier', 'abc'], { cwd: dir, deps })).rc, 2);
  const missing = capture(() => main(['--bead', 'airhorn-nope'], { cwd: dir, deps }));
  assert.equal(missing.rc, 2);
  assert.match(missing.out, /no bead airhorn-nope in this tracker/);
  // A missing value must not be read as "no such flag".
  assert.throws(() => parseArgs(['--since']), /--since needs a value/);
  assert.ok(defaultSince(new Date('2026-11-11T00:00:00Z').getTime()) < '2026-11-11');
});

test('a carrier selection reads only the beads that carrier names', (t) => {
  const { dir, carrier } = buildHistory(t);
  const records = [
    record('airhorn-61m1', { comments: [STALE_NOTE.replace('cleared:be942892', 'cleared:be942892')] }),
    record('airhorn-7fol'),
    record('airhorn-zzzz'),
  ];
  const byId = new Map(records.map((row) => [row.id, row]));
  const selected = selectCandidates({ cwd: dir, options: { carrier }, byId, deps: { issuePrefix: () => 'airhorn' } });
  assert.deepEqual(selected.map((row) => row.id).sort(), ['airhorn-61m1', 'airhorn-7fol']);
});

// ---------------------------------------------------------------------------------------------
// The default data path speaks `bd`: one export for the read, `--stdin` for the write. The stub below
// is a real executable on PATH, so `spawnSync` and the argument/stdin shapes are under test too.
// ---------------------------------------------------------------------------------------------

function stubBd(t, { exportLines, written }) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'airhorn-closure-bin-'));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const script = path.join(bin, 'bd');
  fs.writeFileSync(script, [
    '#!/bin/sh',
    'case "$1" in',
    `  export) cat "${exportLines}" ;;`,
    '  config) printf "Configuration:\\n  issue_prefix = airhorn\\n" ;;',
    `  comment) shift; printf "ARGV %s\\n" "$*" >> "${written}"; cat >> "${written}" ;;`,
    '  *) echo "stub bd: unexpected $*" >&2; exit 9 ;;',
    'esac',
    '',
  ].join('\n'));
  fs.chmodSync(script, 0o755);
  return bin;
}

test('the bd path reads one export and writes a correction through bd comment --stdin', (t) => {
  const { dir, landed } = buildHistory(t);
  const stale = STALE_NOTE.replace('cleared:be942892', `cleared:${landed.slice(0, 8)}`);
  const exportFile = path.join(dir, 'stub-export.jsonl');
  const writtenFile = path.join(dir, 'stub-written.txt');
  fs.writeFileSync(exportFile, [
    JSON.stringify({ _type: 'issue', id: 'airhorn-61m1', status: 'closed', closed_at: '2026-11-11T18:00:00Z', comments: [{ author: 'airhorn-merger', created_at: '2026-11-11T14:14:19Z', text: stale }] }),
    JSON.stringify({ _type: 'issue', id: 'airhorn-open', status: 'open', closed_at: null, comments: [{ author: 'x', created_at: '2026-11-11T14:00:00Z', text: stale }] }),
  ].join('\n') + '\n');
  fs.writeFileSync(writtenFile, '');
  const bin = stubBd(t, { exportLines: exportFile, written: writtenFile });

  // The stub IS bd here, so this drives defaultDeps: one `bd export --json` and one `bd comment --stdin`.
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const json = JSON.parse(execFileSync(process.execPath, [TOOL, '--json', '--apply', '--ref', 'master', '--since', '2026-11-01'], {
    cwd: dir,
    encoding: 'utf8',
    env,
  }));
  assert.deepEqual(json.rows.map((row) => row.bead), ['airhorn-61m1']);
  assert.equal(json.rows[0].decision, 'supersede');
  assert.deepEqual(json.written, ['airhorn-61m1']);
  const written = fs.readFileSync(writtenFile, 'utf8');
  assert.match(written, /ARGV airhorn-61m1 --stdin/, 'the comment is written with --stdin, not as a quoted argument');
  assert.match(written, /SUPERSEDED-BY-LANDING/);

  // The open bead in the same export is a real record the tracker knows, and --bead reaches it.
  const one = JSON.parse(execFileSync(process.execPath, [TOOL, '--json', '--bead', 'airhorn-open', '--ref', 'master'], {
    cwd: dir,
    encoding: 'utf8',
    env,
  }));
  assert.equal(one.rows.length, 1);
  assert.equal(one.rows[0].decision, 'skip:not-closed');
});

test('the carrier mode discovers the issue prefix from the tracker instead of assuming one', (t) => {
  const { dir, carrier } = buildHistory(t);
  const exportFile = path.join(dir, 'stub-export.jsonl');
  const writtenFile = path.join(dir, 'stub-written.txt');
  fs.writeFileSync(exportFile, [
    JSON.stringify({ _type: 'issue', id: 'airhorn-61m1', status: 'closed', closed_at: '2026-11-11T18:00:00Z', comments: [{ author: 'x', created_at: '2026-11-11T14:00:00Z', text: 'nothing to see' }] }),
    JSON.stringify({ _type: 'issue', id: 'airhorn-7fol', status: 'closed', closed_at: '2026-11-11T15:29:00Z', comments: [{ author: 'x', created_at: '2026-11-11T15:29:00Z', text: 'landed in the carrier' }] }),
    JSON.stringify({ _type: 'issue', id: 'airhorn-29nt', status: 'closed', closed_at: '2026-11-11T16:00:00Z', comments: [] }),
  ].join('\n') + '\n');
  fs.writeFileSync(writtenFile, '');
  const bin = stubBd(t, { exportLines: exportFile, written: writtenFile });
  const json = JSON.parse(execFileSync(process.execPath, [TOOL, '--json', '--carrier', carrier], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  }));
  assert.deepEqual(json.rows.map((row) => row.bead).sort(), ['airhorn-29nt', 'airhorn-61m1', 'airhorn-7fol']);
  assert.equal(json.summary.pending, 0);
});

test('the summary counts each decision, so a quiet sweep and a pending one cannot read alike', () => {
  const rows = [
    { decision: 'supersede' },
    { decision: 'review:unproven' },
    { decision: 'skip:last-word-ok' },
    { decision: 'skip:last-word-ok' },
  ];
  const summary = summarise(rows);
  assert.equal(summary.beads, 4);
  assert.equal(summary.pending, 1);
  assert.equal(summary.unproven, 1);
  assert.equal(summary.counts['skip:last-word-ok'], 2);
});
