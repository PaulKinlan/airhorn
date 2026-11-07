/*
 * tools/lib/suite-driver.mjs — the file the test runner is pointed at, for mutation-check.
 *
 * It exists because "did this suite ever run?" cannot be answered from names. The previous
 * attempt compared the file-level test event's name to the suite's basename; node names that
 * event with the path AS PASSED, so `--suite sub/suite.mjs` made a crashing import look like a
 * failed test - a false "mutant-caught" (airhorn-lnme, review of airhorn-u1v2). Any answer built
 * from spellings, comments or import syntax is defeatable by text.
 *
 * So the answer is produced by an event that only EXECUTION can cause: this driver imports the
 * suite and records whether the import threw. A throw means no test ever ran; a clean import
 * means the suite's own tests were registered and the runner will run them, and their failures
 * (counted by tools/lib/suite-mode-reporter.mjs) are the suite's real verdict.
 *
 * Written before the tests run, so the record is never confused with a test outcome.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const suite = process.env.MUTATION_SUITE_FILE;
// The report CHANNEL to the parent is fd 3, a pipe the parent is the only reader of (airhorn-
// gwcm) - but this process is the runner's GRANDCHILD and does not inherit it (measured: fd 3
// closed here, writeSync EINVAL). The record therefore travels over this process's STDOUT:
// the runner forwards it to the reporter as test:stdout events, and the reporter relays it on
// the pipe (measured: pre-test and post-test top-level writes both arrive).
//
// There is NO FILE any more (airhorn-y3d6, both rounds). The old record file's path sat in this
// process's environment - readable by the suite directly, and via /proc/<pid>/environ even after
// the env was scrubbed, because proc shows the EXEC-TIME environment - and a rewrite or atomic
// rename of the file turned a named refusal into 'fix-does-not-close'. Same process and same
// uid mean NO secret can be kept from the suite at all: env leaks via /proc, files are
// same-uid readable, and the grandchild inherits no extra fds. So the design keeps no secret:
// forgery is DETECTED, not prevented. The honest sequence is a grammar the reporter validates:
//   IMPORT            (one line: { importFailed } - the only line when the import decides it)
//   IMPORT, CRASH     (a clean import followed by a crash outside any test, airhorn-so88)
// Any other sequence - a forged line before, between or after - is tampering, and the parent
// refuses by name. A forgery cannot SUPPRESS the real line (the suite shares the stdout but
// cannot unwrite it), so a forged record always makes the sequence invalid.
const DRIVER_RECORD_PREFIX = 'MUTATION-DRIVER-RECORD ';

const record = (value) => {
  try {
    // Sync write to fd 1: an async console.log can be truncated by the crash handler's exit.
    fs.writeSync(1, `${DRIVER_RECORD_PREFIX}${JSON.stringify(value)}\n`);
  } catch {
    /* the parent reports a missing record as a named refusal, never as a verdict */
  }
};

/*
 * A failure that happens AFTER a clean import - a module-level setTimeout that throws, a rejected
 * promise nobody awaited - is not a test failing: no test ever ran (airhorn-so88). node's runner
 * reports it as a failure of the DRIVER file, which the reporter would otherwise count as a caught
 * mutant. These handlers are installed before the import so they are first in line, and they turn
 * the failure into a record instead of a verdict.
 */
const markCrash = (kind) => (error) => {
  const detail = error && error.stack ? error.stack.split('\n')[0] : String(error);
  // The grammar's CRASH line: valid only AFTER a clean-import line, which the reporter checks.
  record({ crashedOutsideTest: true, reason: `${kind} after the suite loaded: ${detail}` });
  process.exit(0);
};
const onUncaught = markCrash('uncaught exception');
const onRejection = markCrash('unhandled rejection');
process.once('uncaughtException', onUncaught);
process.once('unhandledRejection', onRejection);

// SUPPRESSION detection (airhorn-p0dg, corrected after the first fix FAILed review): a suite
// can strip these two handlers, install a swallow that exits 0, and then crash - the CRASH
// line is never written and a named refusal became 'fix-does-not-close' (measured: rc 2).
// The report is SYNCHRONOUS at strip time: stdout cannot be unwritten, and the swallow's
// exit(0) cannot pre-empt a line already written. The first attempt deferred the write to a
// microtask to dodge the once() self-removal false positive - and the one-timer attack (strip
// AND swallow AND throw in ONE timer callback) exits before any microtask runs (measured by
// the reviewer: still rc 2). The false positive is instead solved in the GRAMMAR: a strip
// line followed by a CRASH line is the once() artifact - after a REAL strip the driver holds
// no handler that could write CRASH, so that sequence cannot come from suppression.
// Residual, stated plainly: a suite that first removes THIS watcher (removeAllListeners
// ('removeListener') or a full strip) strips silently; nothing in-process is unremovable at
// the same uid. The tool prints this boundary once per run (airhorn-p0dg).
process.on('removeListener', (name, fn) => {
  if ((name === 'uncaughtException' && fn === onUncaught) || (name === 'unhandledRejection' && fn === onRejection)) {
    record({ handlersStripped: true, reason: "the suite removed the driver's crash handlers - a crash outside any test would now be invisible (suppression, not a measurement)" });
  }
});

// Scrub the driver machinery's variables BEFORE the suite loads (airhorn-y3d6): the suite
// shares this process and inherits this environment. Stated plainly: /proc/<pid>/environ shows
// the EXEC-TIME environment, so this scrub does not hide anything from a suite that reads proc -
// its value is narrower: the suite's own process.env and anything it SPAWNS carry none of the
// machinery. The forgery defence is the sequence grammar above, not secrecy.
for (const name of ['MUTATION_RUN_NONCE', 'MUTATION_SUITE_CHANNEL', 'MUTATION_SUITE_FILE', 'MUTATION_DRIVER_FILE']) {
  delete process.env[name];
}

if (!suite) {
  record({ importFailed: true, reason: 'MUTATION_SUITE_FILE was not set, so no suite was loaded' });
} else {
  try {
    await import(pathToFileURL(suite).href);
    record({ importFailed: false, suite });
  } catch (error) {
    record({ importFailed: true, reason: error && error.message ? error.message : String(error) });
  }
}
