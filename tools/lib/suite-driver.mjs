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
let exitingForCrash = false;
const markCrash = (kind) => (error) => {
  // A `once` handler is removed by node as it fires, which trips our own removeListener watcher. That artifact used to be
  // disambiguated in the reporter's grammar (airhorn-p0dg); with the monitor it would land AFTER the CRASH line, so it is
  // suppressed at the source instead - a removal we caused by firing is not the suite stripping anything.
  exitingForCrash = true;
  const detail = error && error.stack ? error.stack.split('\n')[0] : String(error);
  // The grammar's CRASH line: valid only AFTER a clean-import line, which the reporter checks.
  record({ crashedOutsideTest: true, reason: `${kind} after the suite loaded: ${detail}` });
  process.exit(0);
};
const onUncaught = markCrash('uncaught exception');
const onRejection = markCrash('unhandled rejection');
// UNCAUGHT EXCEPTIONS GO THROUGH THE MONITOR, not an 'uncaughtException' listener (airhorn-5qdd). Node emits
// 'uncaughtExceptionMonitor' BEFORE any 'uncaughtException' listener and before a capture callback, so listener ORDER stops
// mattering: prependListener, prependOnceListener (which node unwraps before invoking, so an exit-time position check sees
// nothing) and a listener that removes itself all sit downstream of the monitor. Measured: monitor -> prepended-once ->
// plain, and monitor -> capture when a capture callback is installed. Rejections have no monitor, so they keep once().
process.on('uncaughtExceptionMonitor', onUncaught);
process.on('unhandledRejection', onRejection);

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
  if (exitingForCrash) return;
  if ((name === 'uncaughtExceptionMonitor' && fn === onUncaught) || (name === 'unhandledRejection' && fn === onRejection)) {
    record({ handlersStripped: true, reason: "the suite removed the driver's crash handlers - a crash outside any test would now be invisible (suppression, not a measurement)" });
  }
});

// UNHANDLED REJECTIONS have no monitor - node exposes none - so precedence cannot be claimed for them. What can be said is
// narrower and it is checked: our rejection handler is registered first, so a suite can only run ahead of it by PREPENDING,
// and a prepended listener is still in the list at exit. That covers the plain shape; it cannot cover a prepended `once`
// (node unwraps and removes it before invoking) or a listener that removes itself, because neither is in the list by then.
// Measured before writing this: a prepended rejection swallow laundered an out-of-test rejection into "the suite passed"
// (rc 2, no refusal), so this check is the difference between the common shape and none at all.
process.on('exit', () => {
  const listeners = process.listeners('unhandledRejection');
  const index = listeners.indexOf(onRejection);
  if (index > 0) {
    record({ handlersPreceded: true, reason: `the suite installed ${index} unhandledRejection listener(s) AHEAD of the driver's - a rejection it hid cannot be told from a pass (suppression, not a measurement)` });
  }
});

// Two evasions that the monitor closes, recorded here because I shipped the weaker instrument first (airhorn-rnj5, then
// airhorn-5qdd from the review of it): a suite that PREPENDS a swallow ahead of the driver's listener, and one that prepends a
// ONCE listener - node unwraps a `once` wrapper before invoking it, and a self-removing listener is gone by the time anything
// could look at the list. An exit-time POSITION check therefore cannot see either of them, which is exactly what the second
// reviewer measured (rc 2, "fix-does-not-close"). Precedence is the answer, not position: the monitor runs before every
// listener and before a capture callback, so a crash is recorded before any suite code can act. Nothing needs to be checked
// at exit for these shapes, and the check that remains is for what the monitor cannot cover.
//
// Residual, stated rather than implied: a suite that removes THIS monitor first (removeListener/removeAllListeners trips the
// strip watcher above, so it is reported, not silent), and a crash that runs no JS at all - process.abort, OOM, a hard kill -
// where nothing in-process can record anything. Closing the latter needs the suite run in a child the driver owns.
//
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
