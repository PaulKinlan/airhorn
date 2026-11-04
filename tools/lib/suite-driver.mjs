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
const reportPath = process.env.MUTATION_SUITE_REPORT;

const read = () => {
  if (!reportPath) return null;
  try {
    return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    return null;
  }
};

const record = (value) => {
  if (!reportPath) return;
  try {
    fs.writeFileSync(reportPath, JSON.stringify(value));
  } catch {
    /* the caller treats a missing record as "not measured" */
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
