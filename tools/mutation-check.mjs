#!/usr/bin/env node
/*
 * tools/mutation-check.mjs — apply a mutation, PROVE it applied, then judge the tests.
 *
 * Why this exists (airhorn-f41e): an assertion-honesty sweep is only as good as its
 * mutation step, and a sweep that cannot tell "the mutant applied" from "nothing
 * changed" reports holes that are not there. Seven of the last sixteen findings on this
 * repo were falsified exactly that way: the "mutation" edited the TEST rather than the
 * product, or the write silently did not land, and the suite passed because nothing had
 * been mutated at all. So every step here is checked and the tool refuses rather than
 * guesses:
 *
 *   1. the target must be PRODUCT code (tests/ is refused unless --allow-test-mutation,
 *      because a test edit is not a product mutation and must never count as one);
 *   2. `--from` must occur EXACTLY once (zero = the mutation does not apply; more =
 *      ambiguous, so a different occurrence may have been hit);
 *   3. after writing, the file is re-read and must differ from the original AND contain
 *      `--to` - the compare-and-discard guard: a mutant that did not land is an error,
 *      never a result;
 *   4. the original is restored in a finally block and the restore is verified. A SIGINT or
 *      SIGTERM landing between the mutant write and that restore cannot run the finally, so the
 *      signal path restores and verifies the file itself before exiting non-zero (airhorn-rf0u).
 *      SIGKILL cannot be handled by any process: if the tool is killed that hard while the file is
 *      mutated, the mutant stays on disk and the recovery is `git checkout -- <the --file path>`;
 *
 * LANDING-PATH DECISION (airhorn-zach, 2026-11-09): this tool is ON-DEMAND ONLY. No gate
 * invokes it - not tools/fast-gate.sh, not npm test, not tools/suite-map.tsv as a runnable
 * suite (the map rows point at its UNIT TEST, tests/mutation-check.test.js, which is the
 * browser-free node-test tier). A lane or reviewer runs it by hand when a one-off mutation
 * honesty proof is wanted; the per-module enforcer + unit-test pattern (ADR
 * docs/adr/0001-delegation-pin-not-prose-scan.md, precedent tests/press-guard.test.mjs) is
 * what the gate relies on instead. Do NOT wire this tool into a gate without a bead and a
 * measured budget - two browser runs do not fit the fast gate's 60s budget.
 *   5. the verdict is the triad, not a boolean:
 *        hole-proven        OLD suite passes the mutant, NEW suite fails it
 *        not-reproducible   OLD suite already fails the mutant (the guard is elsewhere)
 *        fix-does-not-close NEW suite still passes the mutant (the new check is blind)
 *
 * Usage:
 *   node tools/mutation-check.mjs --file src/badge.js --from "a" --to "b" \
 *     --suite tests/multitab.test.mjs [--suite-old /tmp/old-suite.mjs] \
 *     [--build "npx --no-install vite build"] [--allow-test-mutation] [--dry-run] [--expect-strip]
 *
 * --dry-run does everything that can be refused before the file is touched (the target guard, the unique-occurrence
 * check) and then prints the plan - which file would be mutated with which replacement, which suite would run, and that
 * the file would be restored and verified - and exits 0 having written nothing and run nothing (airhorn-lpgh).
 *
 * --expect-strip is the ONLY way to say a suite deliberately removes the driver's crash handlers (airhorn-co4h).
 * Detection is unchanged - the strip is still recorded and named - but instead of refusing the report the run is
 * judged on the runner's in-test evidence, and the verdict carries the limitation it accepted (a crash outside any
 * test is invisible). The opt-in is a CALLER flag rather than a suite-side marker because the suite is the untrusted
 * side: a marker it can write is a marker an adversarial suite can write. Without the flag a strip still refuses
 * (rc 3, report-not-trustworthy), which is the safe direction.
 *
 * Exit: 0 hole-proven (or a clean dry run), 1 not-reproducible, 2 fix-does-not-close, 3 refused/error.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCT_PREFIXES_TO_REFUSE = ['tests/', 'test/'];

/**
 * A mutation target must be product code: a test edit is not a product mutation.
 *
 * Every way of NAMING the file is checked, and then the file itself is checked by IDENTITY
 * (airhorn-29nt, airhorn-7rer). Spelling alone was not enough: `tests/x.test.mjs` was refused
 * while `$PWD/tests/x.test.mjs` was not (a prefix comparison), and once that was fixed a symlink
 * (`--file link.mjs` -> tests/x.test.mjs) or a hardlink (`--file src/sneaky.js` -> tests/x.test.mjs)
 * still reached "mutant applied", because path.resolve neither follows links nor knows that two
 * names are one file.
 *
 * So the guard takes three spellings - as given, relative to the working directory, and the
 * segments of the resolved absolute path - and then compares the target's (device, inode) against
 * the identity of every file under the working directory's tests/ and test/ trees. Identity is
 * what makes it total: stat() follows a symlink and returns the SAME inode for a hardlink, so one
 * comparison covers both. --allow-test-mutation still overrides, because the test file genuinely
 * can be the subject of the experiment.
 *
 * Residual, stated rather than implied: the identity walk covers the tests/ and test/ trees of the
 * working directory. A target outside it (another checkout), or a hardlink created from outside
 * those trees, is not identity-checked - it can still be refused by spelling only.
 */
const TEST_DIR_NAMES = ['tests', 'test'];

/** (device, inode) - the only thing that tells two names for one file apart from two files. */
function targetIdentity(absolute) {
  try {
    const stat = fs.statSync(absolute); // follows symlinks: this is the file, not the link
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

/** Identities of the files under the working directory's tests/ and test/ trees, bounded. */
function testTreeIdentities(cwd, { maxEntries = 4000, maxDepth = 3 } = {}) {
  const found = new Set();
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || seen > maxEntries) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no such tree: nothing to compare against
    }
    for (const entry of entries) {
      if (++seen > maxEntries) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else {
        const identity = targetIdentity(full);
        if (identity) found.add(identity);
      }
    }
  };
  for (const name of TEST_DIR_NAMES) walk(path.join(cwd, name), 0);
  return found;
}

export function mutationTargetProblem(relPath, { allowTestMutation = false, cwd = process.cwd() } = {}) {
  if (allowTestMutation) return null;
  const absolute = path.resolve(cwd, relPath);
  const forms = [
    String(relPath).split(path.sep).join('/').replace(/^\.\//, ''),            // as given
    path.relative(cwd, absolute).split(path.sep).join('/'),                    // relative to cwd
  ];
  const segments = absolute.split(path.sep);
  const refused = forms.some((form) => PRODUCT_PREFIXES_TO_REFUSE.some((prefix) => form.startsWith(prefix)))
    // a tests/ or test/ directory ANYWHERE in the resolved path: an absolute path outside the
    // working directory was the spelling that slipped through (airhorn-29nt)
    || segments.some((segment) => PRODUCT_PREFIXES_TO_REFUSE.some((prefix) => `${segment}/` === prefix));
  if (refused) {
    return `${relPath} is a TEST file, so mutating it proves nothing about the product (use --allow-test-mutation only when the test IS the subject)`;
  }
  // Spelling cannot see a symlink or a hardlink; identity can (airhorn-7rer).
  const identity = targetIdentity(absolute);
  if (identity && testTreeIdentities(cwd).has(identity)) {
    return `${relPath} resolves to a file in tests/ or test/ (same inode), so mutating it proves nothing about the product (use --allow-test-mutation only when the test IS the subject)`;
  }
  return null;
}

/**
 * Apply one exact replacement. Returns { ok, content } or { ok: false, error } - it never
 * guesses which occurrence was meant, and it refuses a no-op mutation outright.
 */
export function applyMutation(original, from, to) {
  if (typeof original !== 'string') return { ok: false, error: 'the target was not read as text' };
  if (!from) return { ok: false, error: '--from is empty: a mutation needs exact text to replace' };
  if (from === to) return { ok: false, error: '--from and --to are identical: that is a no-op, not a mutation' };

  const occurrences = original.split(from).length - 1;
  if (occurrences === 0) {
    return { ok: false, error: 'the --from text does not occur in the target: the mutation does not apply' };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      error: `the --from text occurs ${occurrences} times: it must be unique, or a different occurrence than the one you meant may be mutated`,
    };
  }

  const mutated = original.replace(from, to);
  if (mutated === original) return { ok: false, error: 'the replacement produced an identical file: the mutation did not land' };
  return { ok: true, content: mutated };
}

/**
 * The compare-and-discard guard. `to` may be omitted when the mutation DELETES text; the
 * only non-negotiable is that the on-disk bytes change and are not the original.
 */
export function mutationApplied({ original, onDisk, to }) {
  if (typeof onDisk !== 'string') return { applied: false, reason: 'the file could not be read back after writing' };
  if (onDisk === original) return { applied: false, reason: 'the file on disk is identical to the original: the write did not land' };
  if (to && !onDisk.includes(to)) {
    return { applied: false, reason: 'the file on disk does not contain the mutant text: something rewrote it (a build hook, an editor, a formatter)' };
  }
  return { applied: true };
}

export function restoreVerified({ original, onDisk }) {
  if (typeof onDisk !== 'string') return false;
  return onDisk === original;
}

/**
 * A suite that FAILED TO RUN is not a suite that caught the mutant (review finding
 * airhorn-cmr1: `--suite tests/does-not-exist.test.mjs` scored "mutant-caught" exit 0,
 * because node exits non-zero when it cannot load the file - the tool read that as "the
 * suite fails the mutant", which is the exact confusion between "the check fired" and "the
 * check never ran" this tool exists to prevent).
 *
 * Two answers, both named:
 *   suitePresenceProblem  the file is not there at all;
 *   suiteLoadProblem      node's own stderr says it could not load/parse the file.
 * Anything else - a genuine assertion failure, a timeout inside a test - stays a failure.
 */
export function suitePresenceProblem(suite, cwd) {
  const resolved = path.resolve(cwd, suite);
  if (!fs.existsSync(resolved)) {
    return `the suite ${suite} does not exist (${resolved}) - nothing was measured, so a non-zero exit from node's loader must not count as the suite catching the mutant`;
  }
  return null;
}

const LOAD_FAILURES = [
  [/Cannot find module/, 'the module could not be found'],
  [/ERR_MODULE_NOT_FOUND/, 'a module could not be resolved'],
  [/ERR_UNSUPPORTED_DIR_IMPORT/, 'a directory was imported as a module'],
  [/SyntaxError:/, 'the file does not parse'],
];

export function suiteLoadProblem(stderr) {
  const text = String(stderr || '');
  for (const [pattern, reason] of LOAD_FAILURES) {
    if (pattern.test(text)) {
      return `could not run (${reason}) - a suite that never loaded proves nothing about the mutant`;
    }
  }
  return null;
}

/**
 * The triad. `oldRc` is the pre-change suite against the mutant, `newRc` the current one;
 * null means "not measured", which is never a pass.
 */
export function verdictFor({ oldRc, newRc }) {
  if (newRc === null) {
    return { verdict: 'unmeasured', exit: 3, why: 'the suite was never run against the mutant; a missing measurement is not a result' };
  }
  if (newRc === 0) {
    return { verdict: 'fix-does-not-close', exit: 2, why: 'the NEW suite still passes the mutant, so the new check does not catch it' };
  }
  if (oldRc === null) {
    return { verdict: 'mutant-caught', exit: 0, why: 'the suite fails the mutant; run --suite-old to say whether the hole was ever real' };
  }
  if (oldRc !== 0) {
    return { verdict: 'not-reproducible', exit: 1, why: 'the OLD suite already fails the mutant, so the guard exists somewhere in the suite already' };
  }
  return { verdict: 'hole-proven', exit: 0, why: 'the OLD suite passes the mutant and the NEW suite fails it' };
}

function parseArgs(argv) {
  const args = { allowTestMutation: false, dryRun: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--allow-test-mutation') { args.allowTestMutation = true; continue; }
    if (flag === '--suite-mode') { args.suiteMode = argv[++i]; continue; }
    if (flag === '--dry-run') { args.dryRun = true; continue; }
    if (flag === '--expect-strip') { args.expectStrip = true; continue; }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--file') args.file = value;
    else if (flag === '--from') args.from = value;
    else if (flag === '--to') args.to = value;
    else if (flag === '--suite') args.suite = value;
    else if (flag === '--suite-old') args.suiteOld = value;
    else if (flag === '--build') args.build = value;
    else if (flag === '--timeout-ms') {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) throw new Error(`--timeout-ms must be a positive number of milliseconds, not ${value}`);
      args.timeoutMs = ms;
    }
    else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

/** How long one child run may take before it is killed. A bound, not a habit. */
export const DEFAULT_TIMEOUT_MS = 120000;
/** The child in flight, so a signal or a bound can reach it. */
let activeChild = null;
/**
 * How to put the product file back, while it currently holds mutated bytes.
 *
 * A signal handler cannot unwind the try/finally in main(): `process.exit()` inside a handler
 * terminates without running finally blocks, so a SIGINT/SIGTERM landing between the mutant write
 * and the restore used to leave the mutant ON DISK with only "no verdict was scored" printed
 * (airhorn-rf0u, reproduced: `answer = 42` survived a SIGTERM). main() publishes this closure for
 * exactly the window in which the file is mutated, and the signal path calls it before exiting.
 * SIGKILL cannot be handled at all - that residual is documented in the header, with the recovery
 * command, rather than pretended away.
 */
let crashRestore = null;

/**
 * Kill the run in flight AND the processes it started.
 *
 * Both halves are load-bearing, and this is measured: a check once sat for 120 minutes because
 * suites ran through spawnSync, which blocks, so no timer could fire (reaper event 2026-11-04).
 * Bounding the run alone is not enough either - node's test runner runs each suite in a child of
 * the process we spawn, and that child survives a kill sent to our direct child only. So every run
 * is the leader of its own process group and the kill goes to the GROUP. Where containment is
 * available the run also lives in a PID namespace (airhorn-4h8l), which is the real guarantee; this
 * is the path that works when it is not.
 */
export function killRunTree(signal = 'SIGKILL') {
  if (!activeChild) return false;
  const { pid } = activeChild;
  let killed = false;
  try {
    process.kill(-pid, signal);
    killed = true;
  } catch {
    // the group is gone (or was never a group leader): fall back to the process itself
  }
  try {
    activeChild.kill(signal);
    killed = true;
  } catch {
    // already gone
  }
  return killed;
}

/**
 * One child, asynchronously, BOUNDED, in its own process group.
 *
 * spawnSync cannot do this: it blocks, so nothing can interrupt it and no timer can fire - which is
 * exactly how a hanging suite became a 120-minute process. The result carries `timedOut`, and a
 * timed-out run is a named refusal - never a verdict.
 */
function run(command, shellArgs, cwd, { captureStderr = false, quiet = false, env = process.env, reportPipe = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, shellArgs, {
      cwd,
      env,
      // fd 3 is a PIPE, not a path (airhorn-gwcm): the suite is handed a channel it can only write
      // to, never a filename it or a sibling it spawns can poll and rewrite after the reporter's
      // final write. The parent is the only reader.
      // quiet = the CORROBORATION run (airhorn-uk28): its stdout is DISCARDED, never inherited. The
      // suite's raw bytes must not reach this tool's own stdout, where an operator (or a future
      // scanner) could mistake them for records - the same rule the supervisor enforces one level up.
      stdio: reportPipe ? ['ignore', 'inherit', 'pipe', 'pipe'] : quiet ? ['ignore', 'pipe', 'pipe'] : captureStderr ? ['ignore', 'inherit', 'pipe'] : 'inherit',
      // Its own process group, so killRunTree reaches node's per-file child as well.
      detached: true,
    });
    activeChild = child;
    let stderr = '';
    let channel = '';
    let timedOut = false;
    let settled = false;
    const finish = (rc, signal = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeChild === child) activeChild = null;
      if (captureStderr && stderr) process.stderr.write(stderr);
      resolve({ rc, stderr, channel, timedOut, signal });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killRunTree('SIGKILL');
    }, timeoutMs);
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    if (quiet && child.stdout) child.stdout.on('data', () => { /* discarded on purpose */ });
    if (reportPipe && child.stdio[3]) child.stdio[3].on('data', (chunk) => { channel += String(chunk); });
    child.on('error', () => finish(1));
    // The SIGNAL matters as much as the code for the corroboration run (airhorn-uk28): a process that
    // died of SIGABRT proves nothing about an assertion, and reading its non-zero status as one would
    // re-open the very class this closes.
    child.on('close', (code, signal) => finish(code === null ? 1 : code, signal));
  });
}

/**
 * Read the report CHANNEL (airhorn-gwcm).
 *
 * The channel is the child's fd 3: every record is one JSON line. Nothing about the verdict may
 * rest on a file whose path we hand to the suite - the suite can poll and rewrite that, and so can
 * any process it spawns, which is exactly how a green suite scored "mutant-caught" 2 runs in 3.
 * A record is trusted only when: it is well formed, it carries this run's nonce, its kind is known,
 * and no kind appears twice. Anything else is a NAME for the parent to report, never a verdict.
 */
export function readChannel(text, nonce) {
  const problems = [];
  const records = { driver: [], final: [] };
  const lines = String(text || '').split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return { records: null, problem: 'no report: the run wrote nothing to the report channel' };
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      problems.push(`malformed record ${JSON.stringify(line.slice(0, 80))}`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object') { problems.push('record was not an object'); continue; }
    if (parsed.nonce !== nonce) { problems.push('record did not carry this run\'s nonce'); continue; }
    if (parsed.kind === 'driver' || parsed.kind === 'final') records[parsed.kind].push(parsed);
    else problems.push(`unknown record kind ${JSON.stringify(parsed.kind)}`);
  }
  if (records.driver.length > 1) problems.push(`${records.driver.length} driver records (a run writes one)`);
  if (records.final.length > 1) problems.push(`${records.final.length} final records (a run writes one)`);
  if (records.final.length === 0 && problems.length === 0) problems.push('no final record: the reporter never finished');
  if (problems.length > 0) {
    return { records: null, problem: `report channel not trustworthy: ${problems.join('; ')}` };
  }
  const final = records.final[0];
  return {
    records: {
      driver: records.driver[0] ? records.driver[0].driver : final.driver,
      startedTests: final.startedTests,
      realTests: final.realTests,
      realPassed: final.realPassed,
      realFailed: final.realFailed,
      fileLevelFailed: final.fileLevelFailed,
      wrapperEvents: final.wrapperEvents,
      // Carried, not dropped: without this the conservative refusal in classifyRun is unreachable
      // through the real call path (review finding airhorn-4a3p).
      unattributed: final.unattributed,
      failing: final.failing,
    },
    problem: null,
  };
}

/** Run a suite and say both what it exited with and whether it ran at all. */
/**
 * Classify a run by EXECUTION EVIDENCE ONLY (airhorn-lnme, review of airhorn-u1v2).
 *
 * `report.driver.importFailed` is written by tools/lib/suite-driver.mjs from inside the run: it is
 * true only when importing the suite threw, which is the one thing a comment, a path spelling or an
 * import style cannot fake and cannot hide. Everything else is the runner's own counts.
 *
 *   no report / no driver record -> never-ran: nothing was measured
 *   driver.importFailed          -> never-ran, named (the suite threw while loading)
 *   realFailed > 0               -> caught: the suite executed tests and they failed
 *   otherwise                    -> passed: the suite does not catch this mutant
 *
 * A declared script suite (--suite-mode script) is judged by its exit code, because for a script
 * the top-level assertion IS the failure and there is no runner to report anything.
 */
export function classifyRun({ report, exitCode, suiteMode = 'node-test', expectStrip = false }) {
  if (suiteMode === 'script') {
    return exitCode === 0 ? { mode: 'passed', rc: 0 } : { mode: 'caught', rc: exitCode };
  }
  if (!report || !report.driver) {
    return { mode: 'never-ran', problem: `produced no record of the suite loading (exit ${exitCode}), so nothing was measured - a suite that never ran proves nothing about the mutant` };
  }
  if (report.driver.handlersPreceded) {
    return { mode: 'report-not-trustworthy', problem: `${report.driver.precededReason || 'the suite installed a rejection listener ahead of the driver\'s'} - a rejection it hid cannot be told from a pass, so nothing here is evidence either way (exit ${exitCode}) (airhorn-rnj5)` };
  }
  if (report.driver.handlersStripped && !expectStrip) {
    // airhorn-co4h: a suite that removed the driver's crash handlers is a SUPPRESSION report, not a forgery.
    // The reporter names the shape (IMPORT, STRIP[, STRIP]) and carries the strip line's own reason, so
    // the operator is told what actually happened. The safe direction is unchanged - rc 3, report-not-trustworthy,
    // never a verdict - which is also why a forged strip line can buy nothing (see the reporter).
    //
    // --expect-strip is the EXPLICIT way to say the strip is the point of the suite: detection is untouched
    // (the strip is still recorded and still named), only the policy response changes - the run is then judged
    // on the runner's in-test evidence, which the suite cannot share or forge. That is why the opt-in lives on
    // the CALLER's command line and not in a suite-side marker: the suite is the untrusted side, and anything
    // it can write to excuse itself an adversarial suite can write too.
    const sequenceNote = report.driver.tampered
      ? ` (the record sequence also carried ${report.driver.lines || 0} line(s) and did not fit the grammar)`
      : '';
    // A crash recorded by the monitor alongside the strip is still real evidence, so it is named rather than hidden - but
    // the strip is what decides the report's trustworthiness, so the refusal stands (airhorn-co4h).
    const crashNote = report.driver.crashedOutsideTest
      ? `, and this run ALSO recorded a crash outside any test (${report.driver.reason || 'no reason recorded'}), which the monitor still caught`
      : '';
    return {
      mode: 'report-not-trustworthy',
      problem: `${report.driver.strippedReason || "the suite removed the driver's crash handlers, so a crash outside any test would be invisible"}${crashNote} - nothing here is evidence either way (exit ${exitCode}); pass --expect-strip if the strip is deliberate${sequenceNote} (airhorn-co4h)`,
    };
  }
  // A DRIVER DEFECT, refused by name (airhorn-co4h): every defence rests on these instruments existing and on
  // the strip watcher recognising them by identity. Sampled by the driver at install time, so a suite's own
  // strip cannot trip it, and --expect-strip cannot excuse it. This is the one branch that must stay red for a
  // genuinely missing handler, whatever a careless fix does to the strip policy.
  const instruments = report.driver.instruments;
  if (instruments && typeof instruments === 'object') {
    const missing = ['monitor', 'rejection', 'exitCheck'].filter((name) => instruments[name] === false);
    if (missing.length > 0) {
      return { mode: 'report-not-trustworthy', problem: `the driver never installed its ${missing.join(', ')} instrument(s) as its own function, so a crash outside any test would be invisible and the strip watcher could not recognise a removal - that is a defect in the tool, not a measurement of the suite (exit ${exitCode}) (airhorn-co4h)` };
    }
  }
  if (report.driver.tampered || report.driver.nonceMismatch) {
    // The reporter now says WHICH rule the sequence broke (airhorn-co4h) - an operator reading "forged or broken"
    // about a malformed record needs the reason to tell a bug from an attack.
    const why = typeof report.driver.why === 'string' && report.driver.why ? ` [${report.driver.why}]` : '';
    return { mode: 'report-not-trustworthy', problem: `the driver record sequence was invalid (${report.driver.lines || 0} record line(s), or a nonce that was not this run's) - a record was forged or broken, so nothing it says is evidence either way (exit ${exitCode})${why} (airhorn-y3d6)` };
  }
  if (report.driver.importFailed) {
    return { mode: 'never-ran', problem: `threw while loading (${report.driver.reason || 'no reason reported'}), so NO test ever ran and this is not a caught mutant (exit ${exitCode}, ${report.realTests} test event(s) seen). If this is a script suite whose top-level assertion failed, say so with --suite-mode script` };
  }
  // An event the reporter could not attribute to a file could be the driver's own file-level entry
  // under a spelling it did not recognise. Letting it pass as a real test is how a run with no test
  // in it becomes a caught mutant, so it is refused by name instead (airhorn-u1v2).
  if (typeof report.unattributed === 'number' && report.unattributed > 0) {
    return { mode: 'never-ran', problem: `${report.unattributed} runner event(s) could not be attributed to a file, so nothing about the mutant is attributable (exit ${exitCode})` };
  }
  if (typeof report.realTests !== 'number') {
    return { mode: 'never-ran', problem: `produced no test counts (exit ${exitCode}), so nothing was measured` };
  }
  // A failure OUTSIDE any test is its own named state, whatever the exit code: the driver saw a
  // crash after the load, or the run ended non-zero with no failing test (airhorn-so88/a6ch).
  if (report.driver.crashedOutsideTest) {
    return { mode: 'threw-outside-a-test', problem: `${report.driver.reason || 'the suite failed outside any test after it loaded'}, so NO test asserted anything about the mutant (exit ${exitCode})` };
  }
  if (report.realTests === 0) {
    return { mode: 'never-ran', problem: `registered no tests (${report.wrapperEvents || 0} driver-level event(s) seen${report.fileLevelFailed ? ', the driver file failed as a whole' : ''}), so nothing was measured - a suite with no tests proves nothing about the mutant` };
  }
  if (report.realFailed > 0) {
    // The rule: 'caught' is claimable ONLY when a test STARTED and something inside it failed.
    if (typeof report.startedTests === 'number' && report.startedTests === 0) {
      return { mode: 'threw-outside-a-test', problem: `reported ${report.realFailed} failing event(s) but no test ever STARTED in the suite, so nothing asserted anything about the mutant (exit ${exitCode})` };
    }
    return { mode: 'caught', rc: 1, failing: report.failing, ...stripNote(report) };
  }
  if (exitCode !== 0) {
    return { mode: 'threw-outside-a-test', problem: `the run exited ${exitCode} with no failing test (${report.wrapperEvents || 0} driver-level event(s)), so something failed outside the tests and nothing about the mutant was measured` };
  }
  return { mode: 'passed', rc: 0, ...stripNote(report) };
}

/**
 * The limitation a run accepted when the caller declared the strip deliberate. The verdict is then real, but
 * what it rests on changed: a crash outside any test is invisible, so only the tests that actually ran speak.
 */
function stripNote(report) {
  if (!report.driver || !report.driver.handlersStripped) return {};
  return { note: "the suite removed the driver's crash handlers and --expect-strip accepted it - a crash outside any test is INVISIBLE in this run, so the verdict rests only on the tests that ran (airhorn-co4h)" };
}

// Real paths, so an invocation through a symlink (tool-link/mutation-check.mjs) still finds its own
// helper files AND still recognises itself as main. Before this, a symlinked invocation exited 0
// having done nothing at all - a silent pass, which is worse than any wrong verdict
// (airhorn-a6ch/so88 tool-honesty rule: no verdict may be faked, including by doing nothing).
const SELF = fs.realpathSync(fileURLToPath(import.meta.url));
const REPORTER = path.join(path.dirname(SELF), 'lib', 'suite-mode-reporter.mjs');
const DRIVER = path.join(path.dirname(SELF), 'lib', 'suite-driver.mjs');

/**
 * The suite must run as its own test-runner invocation. A parent `node --test` exports
 * NODE_TEST_CONTEXT, and the runner then SKIPS the child ("run() is being called recursively"),
 * producing no report - which would read as never-ran for every case when the mutation checker is
 * itself under test.
 */
function childEnv(suitePath, nonce, { plain = false } = {}) {
  if (plain) {
    // The CORROBORATION run (airhorn-uk28): a direct `node <suite>`, so there is no runner and nothing
    // decodes frames. The suite must not be told it is a mutation run at all - no channel, no nonce,
    // no paths - because this run's only job is to fail honestly.
    const env = { ...process.env };
    for (const name of ['MUTATION_SUITE_CHANNEL', 'MUTATION_RUN_NONCE', 'MUTATION_SUITE_FILE', 'MUTATION_DRIVER_FILE', 'NODE_TEST_CONTEXT', 'NODE_TEST_ISOLATION', 'NODE_TEST_WORKER_ID']) delete env[name];
    return env;
  }
  const env = {
    ...process.env,
    // A channel the child can only write to (fd 3) plus this run's nonce - NOT a path. The suite
    // gets no filename to poll or rewrite, and a sibling it spawns inherits neither (airhorn-gwcm).
    MUTATION_SUITE_CHANNEL: '3',
    MUTATION_RUN_NONCE: nonce,
    MUTATION_SUITE_FILE: suitePath,
    MUTATION_DRIVER_FILE: DRIVER,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_ISOLATION;
  return env;
}

/**
 * Containment for a suite run (airhorn-4h8l): a suite's detached descendants must not outlive
 * the verdict. The previous mechanism keyed a sweep on the run's nonce in /proc/PID/environ -
 * a child spawned with a scrubbed environment was invisible to it (measured: {env:{}} child
 * survived, the tool exited 2 with the child still running). Environment can be scrubbed,
 * names can change, and a double-fork breaks ancestry - so the identifier cannot live with the
 * child AT ALL. Measured on this fleet's hosts: cgroup2 delegation is NOT writable by an
 * unprivileged lane, but a user+PID namespace is: `unshare -r -fp --kill-child` makes the
 * runner the init of a fresh PID namespace, and every descendant - env-scrubbed, renamed,
 * setsid'd, double-forked - dies with it (measured: the marker was never written). (c), an
 * inherited-FD heartbeat, asks the untrusted side to cooperate, so it was never a candidate.
 * If the namespace is unavailable the run still happens, UNCONTAINED, and the tool says so in
 * its own output - the guarantee is printed, never implied.
 */
let containmentProbe = null;
export function containmentPrefix() {
  if (containmentProbe === null) {
    const probe = spawnSync('unshare', ['-r', '-fp', '--kill-child', 'true'], { encoding: 'utf8' });
    containmentProbe = probe.status === 0 ? ['unshare', '-r', '-fp', '--kill-child'] : [];
  }
  return containmentProbe;
}

export function containmentGuaranteeLine() {
  return containmentPrefix().length
    ? 'containment: suite runs execute inside a PID namespace (unshare -r -fp --kill-child) - every descendant dies with the run, whatever its environment, name or forking (airhorn-4h8l)'
    : 'containment: NONE - PID namespaces are unavailable here, so a detached child of a suite run SURVIVES the verdict; the verdict is still honest about the mutant, but the host is not cleaned (airhorn-4h8l)';
}

async function runSuite(suite, cwd, label, suiteMode, timeoutMs = DEFAULT_TIMEOUT_MS, expectStrip = false) {
  const presence = suitePresenceProblem(suite, cwd);
  if (presence) return { problem: presence };
  // Containment and the bound are separate guarantees: a contained run can still hang, and a
  // hanging run is a wedge with a namespace around it.
  const contained = containmentPrefix();
  if (suiteMode === 'script') {
    const ran = await run(contained.length ? contained[0] : process.execPath,
      contained.length ? [...contained.slice(1), process.execPath, suite] : [suite], cwd, { captureStderr: true, timeoutMs });
    if (ran.timedOut) return { rc: null, timedOut: true, problem: `${label} [never-ran] did not finish within ${timeoutMs}ms and was killed with its process group, so nothing was measured` };
    const classified = classifyRun({ report: null, exitCode: ran.rc, suiteMode });
    if (classified.problem) return { problem: `${label} [${classified.mode}] ${classified.problem}` };
    return { rc: classified.rc };
  }
  const nonce = randomUUID();
  // Run under the test runner with the reporting hook: the runner tells us whether any test
  // executed, instead of us guessing the suite's kind from its text (airhorn-u1v2).
  // The runner is pointed at the driver, not at the suite: the driver records whether the suite
  // LOADED, which is the only spelling-proof evidence that any test could have run (airhorn-lnme).
  const nodeArgs = ['--test', '--test-reporter', REPORTER, DRIVER];
  const ran = await run(contained.length ? contained[0] : process.execPath,
    contained.length ? [...contained.slice(1), process.execPath, ...nodeArgs] : nodeArgs, cwd, {
    captureStderr: true,
    reportPipe: true,
    timeoutMs,
    env: childEnv(path.resolve(cwd, suite), nonce),
  });
  // A run we had to kill measured nothing - not even a report worth reading.
  if (ran.timedOut) return { rc: null, timedOut: true, problem: `${label} [never-ran] did not finish within ${timeoutMs}ms and was killed with its process group, so nothing was measured` };
  const channel = readChannel(ran.channel, nonce);
  const report = channel.records;
  if (channel.problem) return { problem: `${label} [report-not-trustworthy] ${channel.problem}` };
  const classified = classifyRun({ report, exitCode: ran.rc, suiteMode, expectStrip });
  // The state is NAMED in the refusal, not just implied by the exit code (airhorn-so88): a reader
  // must be able to tell "never-ran" from "threw-outside-a-test" without reading prose.
  if (classified.problem) return { problem: `${label} [${classified.mode}] ${classified.problem}` };
  // CORROBORATION (airhorn-uk28, closing airhorn-yvwo's forged-runner-event class). A 'caught' verdict
  // rests on the runner's counters, and those are the code under test's own report: node's runner reads
  // test events as v8-serializer frames on the WORKER's stdout, and the suite runs in that worker, so a
  // suite that writes the frames itself states a failure that never happened (measured: rc 0
  // mutant-caught with no test asserting anything). Nothing inside node --test can authenticate that
  // report, so the claim is CORROBORATED on a channel with no frames: the same suite is run again as a
  // PLAIN node process, where nothing decodes frames, and node:test's own failing assertion still sets
  // a non-zero exit status. 'caught' requires that direct run to fail NORMALLY (an exit code, not a
  // signal - an aborted or killed process proves nothing about an assertion). Cost: one extra process,
  // and only when a catch is claimed - never on the refusal or passing paths.
  if (classified.mode === 'caught') {
    const plainArgs = [path.resolve(cwd, suite)];
    const direct = await run(contained.length ? contained[0] : process.execPath, contained.length ? [...contained.slice(1), process.execPath, ...plainArgs] : plainArgs, cwd, { captureStderr: true, quiet: true, timeoutMs, env: childEnv(path.resolve(cwd, suite), null, { plain: true }) });
    if (direct.timedOut) {
      return { problem: `${label} [caught-unconfirmed] the runner reported a failing test, but the same suite run directly did not finish within ${timeoutMs}ms, so the failure cannot be checked against anything` };
    }
    if (direct.signal) {
      return { problem: `${label} [caught-unconfirmed] the runner reported a failing test, but running the suite directly ended on signal ${direct.signal} rather than failing an assertion, so the reported failure is not corroborated` };
    }
    if (direct.rc === 0) {
      return { problem: `${label} [caught-unconfirmed] the runner reported a failing test, but the same suite run directly (no test runner, nothing to forge) passed: the failure exists only as runner events, which the code under test can write itself (airhorn-yvwo/uk28)` };
    }
    // A direct run that could not EXECUTE the suite proves nothing: it exits non-zero for its own
    // reasons (a missing dependency, a browser the suite needs, a bad import), and reading that as
    // "the assertion failed" would let an environmental failure corroborate a forged catch. This is
    // the SKIP-LOUD path coord asked for: the mutation is UNCORROBORATED - never counted as caught,
    // never silently passed - and the refusal says which run could not speak.
    const couldNotRun = /ERR_MODULE_NOT_FOUND|Cannot find module|ERR_UNSUPPORTED_ESM_URL_SCHEME|SyntaxError|Cannot find package|ERR_UNKNOWN_FILE_EXTENSION/.test(direct.stderr || '');
    if (couldNotRun) {
      const why = (String(direct.stderr || '').split('\n').find((line) => /ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|Cannot find package|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_ESM_URL_SCHEME/.test(line)) || '').trim();
      return { problem: `${label} [caught-uncorroborated] the runner reported a failing test but the direct run could not EXECUTE the suite (${why || 'a load error'}), so this mutation is UNCORROBORATED and is never counted as caught - the runner's claim stands unverified (airhorn-uk28)` };
    }
  }
  return { rc: classified.rc, note: classified.note };
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`mutation-check: ${error.message}`);
    return 3;
  }

  if (!args.file || !args.from || args.suite === undefined) {
    console.error('mutation-check: --file, --from and --suite are required (see the header comment)');
    return 3;
  }
  const targetProblem = mutationTargetProblem(args.file, { allowTestMutation: args.allowTestMutation, cwd });
  if (targetProblem) {
    console.error(`mutation-check: refusing: ${targetProblem}`);
    return 3;
  }

  const absolute = path.resolve(cwd, args.file);
  const original = fs.readFileSync(absolute, 'utf8');
  const applied = applyMutation(original, args.from, args.to ?? '');
  if (!applied.ok) {
    console.error(`mutation-check: refusing: ${applied.error}`);
    return 3;
  }

  // --dry-run has a consumer (airhorn-lpgh): it was parsed and stored and then never read, so a caller who asked for a
  // rehearsal got the real mutation, the real suite runs and the real restore. Everything that can be refused WITHOUT
  // touching the file has already run above (the target guard and the unique-occurrence check), so a dry run here is
  // exactly the plan that a real run would carry out - printed, and nothing done.
  if (args.dryRun) {
    const bytes = applied.content.length - original.length;
    console.log(`mutation-check: dry run - nothing was written and no suite was run`);
    console.log(`  would mutate ${args.file} (${bytes >= 0 ? '+' : ''}${bytes} bytes): ${JSON.stringify(args.from)} -> ${JSON.stringify(args.to ?? '')}`);
    console.log(`  would then run ${args.suite}${args.suiteOld ? ` (after a baseline run of ${args.suiteOld})` : ''}`);
    console.log(`  would restore ${args.file} in a finally block, and verify the restore on disk`);
    return 0;
  }

  let mutantRc = 3;
  let baselineRc = null;
  try {
    fs.writeFileSync(absolute, applied.content);
    // Published BEFORE anything can be interrupted: from here until the finally, the product file
    // holds the mutant, so a signal must restore rather than merely report (airhorn-rf0u).
    crashRestore = () => {
      try {
        fs.writeFileSync(absolute, original);
        return restoreVerified({ original, onDisk: fs.readFileSync(absolute, 'utf8') });
      } catch {
        return false;
      }
    };
    const check = mutationApplied({ original, onDisk: fs.readFileSync(absolute, 'utf8'), to: args.to });
    if (!check.applied) {
      console.error(`mutation-check: refusing: ${check.reason}`);
      mutantRc = 3;
      return 3;
    }
    console.log(`mutant applied to ${args.file} (${applied.content.length - original.length >= 0 ? '+' : ''}${applied.content.length - original.length} bytes), verified on disk`);
    // BEFORE any suite runs, so a refusal further down can never pre-empt the truth about
    // what this host guarantees (airhorn-4h8l review: the line used to print only at the
    // verdict, so a broken degradation path refused first and said nothing).
    console.log(containmentGuaranteeLine());
    // The trust boundary, printed and not just commented (airhorn-p0dg): what the record
    // channel CANNOT see. A tool that states its own limit is honest; one that implies
    // closure is not.
    // THE TRUST STATEMENT (airhorn-14ht). What a record means, who can write it, and what a forged line
    // can and cannot achieve - printed once per invocation so an operator never has to read the source
    // to know where the line is. The full channel enumeration is docs/trust-boundary.md.
    console.log('trust: the suite runs in a CHILD that the supervisor (tools/lib/suite-driver.mjs) spawns, so there are two processes - the supervisor writes every MUTATION-DRIVER-RECORD line, and every byte the code under test emits is QUOTED with a marker before it reaches the stream those records are read from, so a forged record arrives as DATA and is ignored whatever shape it imitates and whatever it reads from /proc. The facts that decide the verdict (did the suite load, did a test start, did one fail) are RELAYED from the child runner on a pipe the suite does not inherit (measured: a suite writeSync to that fd dies EINVAL) - but they are the decode of the worker own report, so they inherit the worker trust level: the node runner reads test events as v8-serializer frames on the WORKER stdout, and the code under test runs in that worker, so a suite that writes forged frames can state a failure that never happened (measured: rc 0 mutant-caught, airhorn-yvwo/86wl). That is the same class as a suite whose assertions lie, and the answer to it is corroboration, not authentication: a claimed catch is CONFIRMED by running the same suite again as a plain node process, where nothing decodes frames and a real failing assertion still exits non-zero (a frame-only forgery is refused as caught-unconfirmed, airhorn-uk28), and --suite-old additionally refuses to call it proven when the suite also fails on the ORIGINAL file. KNOWN-LIMIT: with no shared process there is no in-process monitor, so a suite that installs its own uncaughtException/unhandledRejection handler and exits 0 is indistinguishable from a passing suite - it scores fix-does-not-close (rc 2), never mutant-caught: a refusal to call the check working, not a false catch. Seen from OUTSIDE and named: a crash outside any test (including process.abort, OOM and hard kills, which the in-process design could not record at all), a suite that never loaded, a suite that registered no test, and a supervisor wiring defect.');
    console.log('policy: --expect-strip remains the caller\'s statement that a deliberate strip is the subject of the suite; with the suite in its own process there is nothing of the harness in it to strip, so a strip is a no-op and the verdict rests on the tests that ran (airhorn-14ht).');

    if (args.build) {
      console.log(`building: ${args.build}`);
      // run() is async: an un-awaited call puts a PROMISE where an exit code belongs, and a Promise
      // is truthy, so the build could never fail. Every call site is awaited (rev-u1v2r7).
      const build = await run('bash', ['-lc', args.build], cwd, { timeoutMs: args.timeoutMs });
      if (build.timedOut) {
        console.error(`mutation-check: refusing: the build did not finish within ${args.timeoutMs}ms and was killed - an unbuilt mutant proves nothing`);
        mutantRc = 3;
        return 3;
      }
      const buildRc = build.rc;
      if (buildRc !== 0) {
        console.error(`mutation-check: the build failed (rc=${buildRc}) - a mutant that does not build proves nothing`);
        mutantRc = 3;
        return 3;
      }
    }

    // A suite that could not run is UNMEASURED, never "caught the mutant" (airhorn-cmr1).
    if (args.suiteOld) {
      const baseline = await runSuite(args.suiteOld, cwd, 'the OLD suite', args.suiteMode || 'node-test', args.timeoutMs, args.expectStrip);
      if (baseline.problem) {
        console.error(`mutation-check: refusing: ${baseline.problem}`);
        mutantRc = 3;
        return 3;
      }
      if (baseline.note) console.log(`note: ${baseline.note}`);
      baselineRc = baseline.rc;
    }
    const judged = await runSuite(args.suite, cwd, 'the suite', args.suiteMode || 'node-test', args.timeoutMs, args.expectStrip);
    if (judged.problem) {
      console.error(`mutation-check: refusing: ${judged.problem}`);
      mutantRc = 3;
      return 3;
    }
    if (judged.note) console.log(`note: ${judged.note}`);
    mutantRc = judged.rc;
  } finally {
    fs.writeFileSync(absolute, original);
    crashRestore = null; // the file is the original again: a signal from here on has nothing to undo
    const restored = restoreVerified({ original, onDisk: fs.readFileSync(absolute, 'utf8') });
    console.log(`restored ${args.file}: ${restored ? 'verified' : 'NOT VERIFIED - check the file by hand'}`);
    if (!restored) mutantRc = 3;
  }

  const result = verdictFor({ oldRc: args.suiteOld ? baselineRc : null, newRc: mutantRc === 3 ? null : mutantRc });
  console.log(`verdict: ${result.verdict} (${result.why})`);
  if (!args.suiteOld) {
    console.log('note: --suite-old was not given, so "mutant-caught" cannot say whether the hole was ever real (that is what "hole-proven" is for)');
  }
  return result.exit === 3 && mutantRc !== 3 ? 3 : result.exit;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === SELF;
  } catch {
    return path.resolve(process.argv[1]) === SELF;
  }
}

if (invokedDirectly()) {
  // A fleet SIGTERM (the reaper) must not leave the run's process group behind either.
  const onSignal = (signal) => {
    killRunTree('SIGKILL');
    const restored = crashRestore ? crashRestore() : null;
    if (restored === true) {
      console.error(`mutation-check: interrupted by ${signal} - the run was killed with its process group, the mutated file was restored and verified, and no verdict was scored`);
    } else if (restored === false) {
      console.error(`mutation-check: interrupted by ${signal} - the run was killed, but the mutated file could NOT be restored; recover it with: git checkout -- <the --file path> (no verdict was scored)`);
    } else {
      console.error(`mutation-check: interrupted by ${signal} - the run was killed with its process group and no verdict was scored (the product file was already restored)`);
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.exitCode = await main();
}
