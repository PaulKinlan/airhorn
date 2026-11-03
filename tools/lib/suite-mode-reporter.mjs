/*
 * tools/lib/suite-mode-reporter.mjs — a node:test REPORTER that records what actually EXECUTED
 * (airhorn-u1v2, review of airhorn-ba6d).
 *
 * The previous attempt guessed the suite's kind by reading its source for `node:test`. A reviewer
 * killed that with two lines: an INDIRECT import defeats the regex, and merely adding the comment
 * `// from "node:test"` to a script flipped a real assertion failure into "nothing was measured".
 * A classification that a comment can change is not a measurement.
 *
 * So the runner reports instead of being guessed at. This reporter sees the structured event
 * stream and separates three things that only look alike from the outside:
 *
 *   REAL TESTS          test:pass / test:fail with nesting >= 1 - the file registered and ran
 *                       actual tests. Whether they failed is the suite's own verdict.
 *   FILE-LEVEL FAILURE  the wrapper (nesting 0) failed: the file threw while loading, a dependency
 *                       was missing, it did not parse, or a script suite asserted at top level.
 *                       With zero real tests this means NO TEST EVER RAN.
 *   NOTHING             no events worth reporting.
 *
 * It writes that as JSON to $MUTATION_SUITE_REPORT and prints TAP-ish lines so the log still reads.
 * Nothing here looks at source text, module specifiers or comments, so the classification cannot
 * be moved by any of them.
 */
import fs from 'node:fs';
import path from 'node:path';

export default async function* suiteModeReporter(source) {
  let realTests = 0;
  let realPassed = 0;
  let realFailed = 0;
  let fileLevelFailed = false;
  let fileLevelPassed = false;
  const failing = [];
  let n = 0;

  // The runner reports the FILE WRAPPER under the suite's own name; everything else is a test.
  // Identity comparison, not text analysis: nothing about the source can change this.
  const suiteName = process.env.MUTATION_SUITE_FILE ? path.basename(process.env.MUTATION_SUITE_FILE) : null;

  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data || {};
    const name = typeof data.name === 'string' ? data.name : '<unnamed>';

    if (suiteName !== null && name === suiteName) {
      // The file wrapper: the only pass/fail that exists when nothing inside it ran.
      if (event.type === 'test:fail') fileLevelFailed = true;
      else fileLevelPassed = true;
      continue;
    }

    realTests += 1;
    if (event.type === 'test:fail') {
      realFailed += 1;
      failing.push(name);
      console.log(`not ok ${n += 1} - ${name}`);
    } else {
      realPassed += 1;
      console.log(`ok ${n += 1} - ${name}`);
    }
  }

  const report = { realTests, realPassed, realFailed, fileLevelFailed, fileLevelPassed, failing: failing.slice(0, 10) };
  const target = process.env.MUTATION_SUITE_REPORT;
  if (target) {
    try {
      fs.writeFileSync(target, JSON.stringify(report));
    } catch {
      /* the caller treats a missing report as "not measured" */
    }
  }
  console.log(`# suite-mode: ${JSON.stringify(report)}`);
}
