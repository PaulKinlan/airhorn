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
 * Usage:
 *   node tools/mutation-check.mjs --file src/badge.js --from "a" --to "b" \
 *     --suite tests/multitab.test.mjs [--suite-old /tmp/old-suite.mjs] \
 *     [--build "npx --no-install vite build"] [--allow-test-mutation] [--dry-run]
 *
 * Exit: 0 hole-proven, 1 not-reproducible, 2 fix-does-not-close, 3 refused/error.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCT_PREFIXES_TO_REFUSE = ['tests/', 'test/'];

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
  const args = { allowTestMutation: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--allow-test-mutation') { args.allowTestMutation = true; continue; }
    if (flag === '--suite-mode') { args.suiteMode = argv[++i]; continue; }
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
    else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

function run(command, shellArgs, cwd, { captureStderr = false, env = process.env } = {}) {
  const result = spawnSync(command, shellArgs, {
    cwd,
    env,
    stdio: captureStderr ? ['ignore', 'inherit', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (captureStderr && result.stderr) process.stderr.write(result.stderr);
  return { rc: result.status === null ? 1 : result.status, stderr: result.stderr || '' };
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
export function classifyRun({ report, exitCode, suiteMode = 'node-test' }) {
  if (suiteMode === 'script') {
    return exitCode === 0 ? { mode: 'passed', rc: 0 } : { mode: 'caught', rc: exitCode };
  }
  if (!report || !report.driver) {
    return { mode: 'never-ran', problem: `produced no record of the suite loading (exit ${exitCode}), so nothing was measured - a suite that never ran proves nothing about the mutant` };
  }
  if (report.driver.importFailed) {
    return { mode: 'never-ran', problem: `threw while loading (${report.driver.reason || 'no reason reported'}), so NO test ever ran and this is not a caught mutant (exit ${exitCode}, ${report.realTests} test event(s) seen). If this is a script suite whose top-level assertion failed, say so with --suite-mode script` };
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
    return { mode: 'caught', rc: 1, failing: report.failing };
  }
  if (exitCode !== 0) {
    return { mode: 'threw-outside-a-test', problem: `the run exited ${exitCode} with no failing test (${report.wrapperEvents || 0} driver-level event(s)), so something failed outside the tests and nothing about the mutant was measured` };
  }
  return { mode: 'passed', rc: 0 };
}

const REPORTER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'suite-mode-reporter.mjs');
const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'suite-driver.mjs');

/**
 * The suite must run as its own test-runner invocation. A parent `node --test` exports
 * NODE_TEST_CONTEXT, and the runner then SKIPS the child ("run() is being called recursively"),
 * producing no report - which would read as never-ran for every case when the mutation checker is
 * itself under test.
 */
function childEnv(reportPath, suitePath) {
  const env = {
    ...process.env,
    MUTATION_SUITE_REPORT: reportPath,
    MUTATION_SUITE_FILE: suitePath,
    MUTATION_DRIVER_FILE: DRIVER,
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_ISOLATION;
  return env;
}

function runSuite(suite, cwd, label, suiteMode) {
  const presence = suitePresenceProblem(suite, cwd);
  if (presence) return { problem: presence };
  if (suiteMode === 'script') {
    const ran = run(process.execPath, [suite], cwd, { captureStderr: true });
    const classified = classifyRun({ report: null, exitCode: ran.rc, suiteMode });
    if (classified.problem) return { problem: `${label} [${classified.mode}] ${classified.problem}` };
    return { rc: classified.rc };
  }
  const reportPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-report-')), 'report.json');
  // Run under the test runner with the reporting hook: the runner tells us whether any test
  // executed, instead of us guessing the suite's kind from its text (airhorn-u1v2).
  // The runner is pointed at the driver, not at the suite: the driver records whether the suite
  // LOADED, which is the only spelling-proof evidence that any test could have run (airhorn-lnme).
  const ran = run(process.execPath, ['--test', '--test-reporter', REPORTER, DRIVER], cwd, {
    captureStderr: true,
    env: childEnv(reportPath, path.resolve(cwd, suite)),
  });
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    report = null;
  }
  const classified = classifyRun({ report, exitCode: ran.rc, suiteMode });
  // The state is NAMED in the refusal, not just implied by the exit code (airhorn-so88): a reader
  // must be able to tell "never-ran" from "threw-outside-a-test" without reading prose.
  if (classified.problem) return { problem: `${label} [${classified.mode}] ${classified.problem}` };
  return { rc: classified.rc };
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

  const absolute = path.resolve(cwd, args.file);
  const original = fs.readFileSync(absolute, 'utf8');
  const applied = applyMutation(original, args.from, args.to ?? '');
  if (!applied.ok) {
    console.error(`mutation-check: refusing: ${applied.error}`);
    return 3;
  }

  let mutantRc = 3;
  let baselineRc = null;
  try {
    fs.writeFileSync(absolute, applied.content);
    const check = mutationApplied({ original, onDisk: fs.readFileSync(absolute, 'utf8'), to: args.to });
    if (!check.applied) {
      console.error(`mutation-check: refusing: ${check.reason}`);
      mutantRc = 3;
      return 3;
    }
    console.log(`mutant applied to ${args.file} (${applied.content.length - original.length >= 0 ? '+' : ''}${applied.content.length - original.length} bytes), verified on disk`);

    if (args.build) {
      console.log(`building: ${args.build}`);
      const buildRc = run('bash', ['-lc', args.build], cwd).rc;
      if (buildRc !== 0) {
        console.error(`mutation-check: the build failed (rc=${buildRc}) - a mutant that does not build proves nothing`);
        mutantRc = 3;
        return 3;
      }
    }

    // A suite that could not run is UNMEASURED, never "caught the mutant" (airhorn-cmr1).
    if (args.suiteOld) {
      const baseline = runSuite(args.suiteOld, cwd, 'the OLD suite', args.suiteMode || 'node-test');
      if (baseline.problem) {
        console.error(`mutation-check: refusing: ${baseline.problem}`);
        mutantRc = 3;
        return 3;
      }
      baselineRc = baseline.rc;
    }
    const judged = runSuite(args.suite, cwd, 'the suite', args.suiteMode || 'node-test');
    if (judged.problem) {
      console.error(`mutation-check: refusing: ${judged.problem}`);
      mutantRc = 3;
      return 3;
    }
    mutantRc = judged.rc;
  } finally {
    fs.writeFileSync(absolute, original);
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
