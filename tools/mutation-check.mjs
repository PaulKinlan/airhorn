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
 *   4. the original is restored in a finally block and the restore is verified;
 *   5. the verdict is the triad, not a boolean:
 *        hole-proven        OLD suite passes the mutant, NEW suite fails it
 *        not-reproducible   OLD suite already fails the mutant (the guard is elsewhere)
 *        fix-does-not-close NEW suite still passes the mutant (the new check is blind)
 *
 * HOW "DID IT RUN?" IS DECIDED — read before touching classifyPair (airhorn-u1v2).
 *
 * Four earlier versions of this file tried to work out what KIND of suite it was
 * holding: first by scanning its source text for node:test, then by matching the test
 * runner's file-level event by basename, then by an import record written from inside
 * the run, then by that record plus the runner's own pass/fail counts. Every one of
 * them produced a FALSE GREEN or a FALSE REFUSAL, and each was defeated by something
 * stupid: an indirect `node:test` import, a directory-qualified path spelling, an
 * asynchronous throw after the suite loaded, a `process.removeAllListeners` call, a
 * forged report file, and — first of all — a COMMENT. If a comment changes the verdict,
 * nothing was measured.
 *
 * So no evidence from inside the suite's process is trusted any more, and nothing about
 * the suite's kind is inferred. The suite is simply run TWICE and the two runs are
 * compared:
 *
 *     control   the suite against the ORIGINAL source, before anything is written
 *     mutant    the same suite, same runner, same arguments, against the mutant
 *
 * Only the source bytes differ, so the run pair is a controlled experiment. The
 * classification is therefore about OBSERVED BEHAVIOUR:
 *
 *     control fails                      -> never-ran (refused, named): the suite does
 *                                           not pass the code as written, so it cannot
 *                                           say the mutant was caught. This is the shape
 *                                           that was previously scored as "caught": an
 *                                           import crash, an asynchronous boot failure,
 *                                           a stripped handler, a script whose top-level
 *                                           assertion fails, a hung run.
 *     control passes, mutant fails       -> caught
 *     control passes, mutant passes      -> passed (fix-does-not-close)
 *     mutant hangs                       -> never-ran (refused, named)
 *
 * A "caught" is then re-checked: the source is restored and the suite is run once more,
 * and if it does not pass again the tool refuses. A flaky suite that fails on its second
 * run would otherwise manufacture a caught mutant - and a false catch is exactly the
 * direction that hides a hole. So a green here is three observations, not one:
 *
 *     control passes -> mutant fails -> control passes again (code restored)
 *
 * BUILD OUTPUT IS PART OF THE PHASE (airhorn-br28). If a suite can observe `--build`
 * output (dist/), a run that measures stale bytes is not a measurement: so the build runs
 * for each phase - unmutated, mutant, restored - and a build failure is a refusal, never a
 * result. The restored build happens on every path, so dist/ can never keep the mutant.
 *
 * AN OLD SUITE HAS ITS OWN CONTROL. "--suite-old already fails the mutant" is only
 * reportable if the OLD suite passes the unmutated source, otherwise a crashed OLD suite
 * would read as not-reproducible.
 *
 * INTERRUPTION (airhorn-rf0u). SIGINT/SIGTERM run the same restore-and-verify as the
 * finally block and exit non-zero. SIGKILL cannot be handled: if a check is ever killed
 * hard between the write and the restore, the file is left mutated and the recovery is
 * `git checkout -- <file>`; `git status` shows it.
 *
 * That comparison cannot be moved by comments, whitespace, quoting, module specifiers,
 * path spellings, reporter hooks or forged report files, because none of them are read.
 * The price is two extra suite runs per check (one control, one re-check after a catch);
 * correctness of the verdict is the whole point of the tool, and the control run is what
 * makes a green mean something.
 *
 * A script suite (a file that asserts at top level and calls process.exit) needs no
 * special treatment for classification — the control/mutant pair judges it the same way.
 * `--suite-mode script` still exists for callers that want it run by plain `node`
 * instead of `node --test`.
 *
 * Usage:
 *   node tools/mutation-check.mjs --file src/badge.js --from "a" --to "b" \
 *     --suite tests/multitab.test.mjs [--suite-old /tmp/old-suite.mjs] \
 *     [--build "npx --no-install vite build"] [--suite-mode node-test|script] \
 *     [--timeout-ms 120000] [--allow-test-mutation] [--dry-run]
 *
 * Exit: 0 hole-proven / mutant-caught, 1 not-reproducible, 2 fix-does-not-close,
 *       3 refused/unmeasured (nothing was measured, or the run pair could not be trusted).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCT_PREFIXES_TO_REFUSE = ['tests/', 'test/'];

export const DEFAULT_TIMEOUT_MS = 120000;
/** How much of a failed run's output is quoted back. A tail, because the cause is at the end. */
const OUTPUT_TAIL = 1200;

/** A mutation target must be product code: a test edit is not a product mutation. */
export function mutationTargetProblem(relPath, { allowTestMutation = false } = {}) {
  if (allowTestMutation) return null;
  const normalised = relPath.split(path.sep).join('/').replace(/^\.\//, '');
  const refused = PRODUCT_PREFIXES_TO_REFUSE.find((prefix) => normalised.startsWith(prefix));
  if (refused) {
    return `${relPath} is a TEST file, so mutating it proves nothing about the product (use --allow-test-mutation only when the test IS the subject)`;
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
 * A suite that is not there at all is refused before anything is run. (The control run
 * would refuse it too, as "does not pass on the unmutated source"; the presence check
 * exists only so the message names the actual problem.)
 */
export function suitePresenceProblem(suite, cwd) {
  const resolved = path.resolve(cwd, suite);
  if (!fs.existsSync(resolved)) {
    return `the suite ${suite} does not exist (${resolved}) - nothing was measured, so a non-zero exit from node's loader must not count as the suite catching the mutant`;
  }
  return null;
}

/** The tail of a run's output, for a refusal message. Bounded: a suite can print a lot. */
function tail(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const clipped = value.length > OUTPUT_TAIL ? `…${value.slice(-OUTPUT_TAIL)}` : value;
  return `\n  suite output (tail):\n${clipped.split('\n').map((line) => `    ${line}`).join('\n')}`;
}

function describeRun(run) {
  return run.timedOut ? 'it did not finish' : `it exited ${run.rc}`;
}

/**
 * Classify the run PAIR. `control` is the suite against the unmutated source, `mutant`
 * the same suite against the mutant; both are { rc, timedOut }. Nothing else is consulted,
 * by design - see the header.
 *
 * A suite that does not pass the control run has not measured the mutant: whatever it is
 * doing, the difference between the two runs cannot be attributed to the mutation.
 */
export function classifyPair({ control, mutant }) {
  if (!control || !mutant) {
    return { mode: 'never-ran', problem: 'both the control run and the mutant run are needed; a missing measurement is not a result' };
  }
  if (control.timedOut) {
    return {
      mode: 'never-ran',
      problem: `the suite did not finish on the UNMUTATED source (timeout): nothing was measured, so a hung run cannot count as catching the mutant`,
    };
  }
  if (control.rc !== 0) {
    return {
      mode: 'never-ran',
      problem: `the suite does not pass on the UNMUTATED source (${describeRun(control)}): a suite that already fails the code as written cannot show that the mutant was caught, so nothing was measured. Fix the suite (or the code) first - this is the control run`,
    };
  }
  if (mutant.timedOut) {
    return {
      mode: 'never-ran',
      problem: `the suite did not finish with the mutant in place (timeout): a hang is not a caught mutant, so nothing was measured`,
    };
  }
  if (mutant.rc !== 0) {
    return { mode: 'caught', rc: mutant.rc };
  }
  return { mode: 'passed', rc: 0 };
}

/**
 * The re-check after a catch. A suite that fails on the mutant must pass the unmutated
 * source AGAIN once the mutant is removed: otherwise it is non-deterministic, and its
 * failure cannot be attributed to the mutation.
 */
export function classifyRecheck({ recheck }) {
  if (!recheck) {
    return { mode: 'never-ran', problem: 'the re-check run is missing; a caught mutant needs the restored source to pass again' };
  }
  if (recheck.timedOut) {
    return { mode: 'never-ran', problem: 'the re-check with the mutant removed did not finish (timeout): the suite is not deterministic, so the caught mutant cannot be attributed to the mutation' };
  }
  if (recheck.rc !== 0) {
    return {
      mode: 'never-ran',
      problem: `the suite is not deterministic: it passed the unmutated source, then failed it again once the mutant was removed (${describeRun(recheck)}). A suite that fails on its own cannot prove a caught mutant, so nothing was measured`,
    };
  }
  return { mode: 'reproduced' };
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
  const args = { allowTestMutation: false, dryRun: false, suiteMode: 'node-test', timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--allow-test-mutation') { args.allowTestMutation = true; continue; }
    if (flag === '--dry-run') { args.dryRun = true; continue; }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--file') args.file = value;
    else if (flag === '--from') args.from = value;
    else if (flag === '--to') args.to = value;
    else if (flag === '--suite') args.suite = value;
    else if (flag === '--suite-old') args.suiteOld = value;
    else if (flag === '--build') args.build = value;
    else if (flag === '--suite-mode') {
      if (value !== 'node-test' && value !== 'script') throw new Error(`--suite-mode must be node-test or script, not ${value}`);
      args.suiteMode = value;
    } else if (flag === '--timeout-ms') {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) throw new Error(`--timeout-ms must be a positive number of milliseconds, not ${value}`);
      args.timeoutMs = ms;
    } else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

/** A plain `node` run. Never inherits NODE_TEST_CONTEXT: a parent runner would skip the child. */
function spawnNode(argv, cwd, timeoutMs) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_ISOLATION;
  const result = spawnSync(process.execPath, argv, { cwd, env, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  const timedOut = result.error ? result.error.code === 'ETIMEDOUT' : false;
  return {
    rc: result.status === null ? 1 : result.status,
    timedOut,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/** Run the suite once. The same invocation is used for the control and the mutant run. */
export function runSuite({ suite, cwd, suiteMode = 'node-test', timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return spawnNode(suiteMode === 'script' ? [suite] : ['--test', suite], cwd, timeoutMs);
}

function runBuild(build, cwd, timeoutMs) {
  return spawnSync('bash', ['-lc', build], { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
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
  const targetProblem = mutationTargetProblem(args.file, { allowTestMutation: args.allowTestMutation });
  if (targetProblem) {
    console.error(`mutation-check: refusing: ${targetProblem}`);
    return 3;
  }
  for (const candidate of [args.suite, args.suiteOld].filter(Boolean)) {
    const presence = suitePresenceProblem(candidate, cwd);
    if (presence) {
      console.error(`mutation-check: refusing: ${presence}`);
      return 3;
    }
  }

  const absolute = path.resolve(cwd, args.file);
  const original = fs.readFileSync(absolute, 'utf8');
  const applied = applyMutation(original, args.from, args.to ?? '');
  if (!applied.ok) {
    console.error(`mutation-check: refusing: ${applied.error}`);
    return 3;
  }

  const runArgs = { cwd, suiteMode: args.suiteMode, timeoutMs: args.timeoutMs };

  /**
   * Build once for the phase that is on disk right now, and say which phase it was for.
   * A suite can observe build output (dist/), so every run below needs a build made from
   * the SAME source it is supposed to be measuring (airhorn-br28). Returns false when the
   * build failed: that is a refusal, never a result.
   */
  const buildPhase = (label) => {
    if (!args.build) return true;
    console.log(`build (${label}): ${args.build}`);
    const built = runBuild(args.build, cwd, args.timeoutMs);
    if (built.status === 0) return true;
    console.error(`mutation-check: refusing: the build failed for the ${label} phase (rc=${built.status}) - a run whose build output does not match the source it measures proves nothing${tail(built.stderr || built.stdout)}`);
    return false;
  };

  // The restored source may still be sitting next to build output from a previous run, so
  // the control build comes FIRST: the control run must measure the code as written.
  if (!buildPhase('unmutated')) return 3;

  // An OLD suite needs a control of its own, or "the OLD suite already fails the mutant"
  // cannot be told apart from "the OLD suite crashes on anything" (rc 1 either way).
  if (args.suiteOld) {
    console.log(`old control: ${args.suiteOld} against the unmutated ${args.file}`);
    const oldControl = runSuite({ suite: args.suiteOld, ...runArgs });
    const judged = classifyPair({ control: oldControl, mutant: oldControl });
    if (judged.mode === 'never-ran') {
      console.error(`mutation-check: refusing: the OLD suite ${args.suiteOld} does not pass the unmutated ${args.file} (${describeRun(oldControl)}), so it cannot be used as a baseline - nothing was measured${tail(oldControl.stderr || oldControl.stdout)}`);
      return 3;
    }
    console.log(`old control: ${describeRun(oldControl)} - the OLD suite passes the code as written`);
  }

  // THE CONTROL RUN. Nothing has been written yet, so this is the code as it stands.
  // Everything downstream is only meaningful if this passes.
  console.log(`control: ${args.suite} against the unmutated ${args.file}`);
  const control = runSuite({ suite: args.suite, ...runArgs });
  const preCheck = classifyPair({ control, mutant: control });
  if (preCheck.mode === 'never-ran' && (control.timedOut || control.rc !== 0)) {
    console.error(`mutation-check: refusing: ${preCheck.problem}${tail(control.stderr || control.stdout)}`);
    return 3;
  }
  console.log(`control: ${describeRun(control)} - the suite passes the code as written`);

  if (args.dryRun) {
    console.log(`mutation-check: --dry-run, so nothing was mutated: the control run passed and ${applied.content.length - original.length >= 0 ? '+' : ''}${applied.content.length - original.length} bytes would change in ${args.file}`);
    return 0;
  }

  let mutantRc = null;
  let baselineRc = null;
  let refused = false;
  /**
   * Put the original back and say so. Used by the finally block AND by the signal handlers
   * below: a SIGTERM between the write and the restore must not leave a mutant on disk
   * (airhorn-rf0u). SIGKILL cannot be handled - if the file is ever left mutated, the
   * recovery is `git checkout -- <file>`, which the refusal message below names.
   */
  const restoreNow = (why = '') => {
    try {
      fs.writeFileSync(absolute, original);
    } catch (error) {
      console.error(`mutation-check: could not restore ${args.file}${why ? ` (${why})` : ''}: ${error.message} - recover with \`git checkout -- ${args.file}\``);
      return false;
    }
    const restored = restoreVerified({ original, onDisk: fs.readFileSync(absolute, 'utf8') });
    console.log(`restored ${args.file}: ${restored ? 'verified' : `NOT VERIFIED${why ? ` (${why})` : ''} - recover with \`git checkout -- ${args.file}\``}`);
    return restored;
  };
  const onSignal = (signal) => {
    restoreNow(signal);
    console.error(`mutation-check: interrupted by ${signal} - the mutation was not scored`);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    fs.writeFileSync(absolute, applied.content);
    const check = mutationApplied({ original, onDisk: fs.readFileSync(absolute, 'utf8'), to: args.to });
    if (!check.applied) {
      console.error(`mutation-check: refusing: ${check.reason}`);
      refused = true;
      return 3;
    }
    console.log(`mutant applied to ${args.file} (${applied.content.length - original.length >= 0 ? '+' : ''}${applied.content.length - original.length} bytes), verified on disk`);

    if (!buildPhase('mutant')) {
      refused = true;
      return 3;
    }

    if (args.suiteOld) {
      const old = runSuite({ suite: args.suiteOld, ...runArgs });
      if (old.timedOut) {
        console.error(`mutation-check: refusing: the OLD suite ${args.suiteOld} did not finish against the mutant, so nothing was measured`);
        refused = true;
        return 3;
      }
      baselineRc = old.rc;
    }

    const mutant = runSuite({ suite: args.suite, ...runArgs });
    const classified = classifyPair({ control, mutant });
    if (classified.mode === 'never-ran') {
      console.error(`mutation-check: refusing: ${classified.problem}${tail(mutant.stderr || mutant.stdout)}`);
      refused = true;
      return 3;
    }
    mutantRc = classified.rc;
  } finally {
    if (!restoreNow()) refused = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  // The restore left build output from the mutant behind unless the build runs again, so
  // the tree must be rebuilt from the restored source before anything else measures it
  // (airhorn-br28). This happens whether or not the mutant was caught: dist/ must never
  // keep the mutant bytes for the next invocation.
  if (!buildPhase('restored')) refused = true;

  if (refused) return 3;

  // A catch is only claimed if the restored source still passes: control -> mutant fails ->
  // control passes again. A flaky suite would otherwise manufacture a caught mutant.
  if (mutantRc !== 0) {
    console.log(`re-check: ${args.suite} against the restored ${args.file}`);
    const recheck = runSuite({ suite: args.suite, ...runArgs });
    const verdictOnSuite = classifyRecheck({ recheck });
    if (verdictOnSuite.mode === 'never-ran') {
      console.error(`mutation-check: refusing: ${verdictOnSuite.problem}${tail(recheck.stderr || recheck.stdout)}`);
      return 3;
    }
    console.log(`re-check: ${describeRun(recheck)} - the suite passes the restored source again`);
  }
  const result = verdictFor({ oldRc: args.suiteOld ? baselineRc : null, newRc: mutantRc });
  console.log(`verdict: ${result.verdict} (${result.why})`);
  if (!args.suiteOld) {
    console.log('note: --suite-old was not given, so "mutant-caught" cannot say whether the hole was ever real (that is what "hole-proven" is for)');
  }
  return result.exit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
