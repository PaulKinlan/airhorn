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
// The report CHANNEL is fd 3, a pipe the parent is the only reader of - never a path (airhorn-
// gwcm). A path handed to this process is a path the suite (or a sibling it spawns) can poll and
// rewrite after the final write, which is how a green suite once scored "mutant-caught".
// This runs in the test-runner's GRANDCHILD, which does not inherit the parent's pipe (measured:
// fd 3 is closed there, writeSync throws EINVAL), so the driver's own record travels by file. That
// file IS writable by the suite - the driver and the suite share this process - so it is not
// trusted on its own: the reporter (which runs in the runner process, not here) merges it into the
// single record it sends the parent over the pipe, and the parent decides from THAT. A crash that
// kills this process also prevents the reporter's final record, which the parent refuses by name
// (airhorn-gwcm).
const nonce = process.env.MUTATION_RUN_NONCE || null;
const driverReportPath = process.env.MUTATION_DRIVER_REPORT || null;

const read = () => {
  if (!driverReportPath) return null;
  try {
    return JSON.parse(fs.readFileSync(driverReportPath, 'utf8'));
  } catch {
    return null;
  }
};

const record = (value) => {
  globalThis.__mutationDriverRecord = value;
  if (!driverReportPath) return;
  try {
    fs.writeFileSync(driverReportPath, JSON.stringify({ nonce, ...value }), { mode: 0o600 });
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
  record({ ...(read() || {}), crashedOutsideTest: true, reason: `${kind} after the suite loaded: ${detail}` });
  process.exit(0);
};
process.once('uncaughtException', markCrash('uncaught exception'));
process.once('unhandledRejection', markCrash('unhandled rejection'));

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
