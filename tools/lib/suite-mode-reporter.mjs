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

export default async function* suiteModeReporter(source) {
  let realTests = 0;
  let realPassed = 0;
  let realFailed = 0;
  let fileLevelFailed = false;
  const failing = [];
  let n = 0;

  // The DRIVER's own file-level event is the wrapper node emits when the driver file fails as a
  // whole (an async crash after the suite loaded). It is identified by `data.file` pointing at the
  // driver - an absolute path this tool chose - so nothing the suite's TEXT says can impersonate it,
  // and it stays separable even if the suite strips the driver's uncaughtException handlers
  // (airhorn-a6ch). Note nesting does NOT separate them: measured on node 24, real tests and the
  // wrapper both report nesting 0.
  // Compare REAL paths: an invocation through a symlink, or any path spelling the OS normalises,
  // must not stop the driver's own event from being recognised as the driver's. Without this the
  // wrapper silently re-enters the "real test" counts under a different spelling of the same file
  // (airhorn-a6ch).
  let driverFile = process.env.MUTATION_DRIVER_FILE || null;
  if (driverFile) {
    try { driverFile = fs.realpathSync(driverFile); } catch {}
  }
  const fileOf = (data) => {
    if (typeof data.file !== 'string') return null;
    try { return fs.realpathSync(data.file); } catch { return data.file; }
  };
  let wrapperEvents = 0;
  // "caught" may only be claimed when a test actually STARTED inside the suite and failed
  // (airhorn-so88). A start is the runner's own evidence that execution reached a test, so it
  // cannot be forged by text, and it is distinct from a failure the runner reports for its own
  // synthetic file-level event.
  let startedTests = 0;

  // The driver's record arrives as stdout lines from the driver FILE's process (airhorn-y3d6,
  // second round - there is no record file any more). The honest sequence is a grammar:
  //   IMPORT          one line { importFailed: ... }
  //   IMPORT, CRASH   a clean import followed by { crashedOutsideTest: true } (airhorn-so88)
  // A forged line from the suite cannot suppress the real one (stdout cannot be unwritten), so
  // a forgery always makes the sequence invalid - DETECTED, then refused by the parent.
  const driverLines = [];
  const DRIVER_RECORD_PREFIX = 'MUTATION-DRIVER-RECORD ';

  for await (const event of source) {
    if (event.type === 'test:stdout') {
      const data = event.data || {};
      const message = typeof data.message === 'string' ? data.message : '';
      for (const line of message.split('\n')) {
        if (line.startsWith(DRIVER_RECORD_PREFIX)) {
          try {
            driverLines.push(JSON.parse(line.slice(DRIVER_RECORD_PREFIX.length)));
          } catch {
            driverLines.push({ malformed: true });
          }
        }
      }
      continue;
    }
    if (event.type === 'test:start') {
      const data = event.data || {};
      if (!(driverFile && fileOf(data) === driverFile)) startedTests += 1;
      continue;
    }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const data = event.data || {};
    const name = typeof data.name === 'string' ? data.name : '<unnamed>';
    if (driverFile && fileOf(data) === driverFile) {
      wrapperEvents += 1;
      if (event.type === 'test:fail') fileLevelFailed = true;
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

  // The driver's record says whether the suite LOADED at all. It is written before any test runs,
  // and it is the only thing that decides "never ran" - no name or path comparison anywhere.
  // It arrives BY FILE, because the driver runs in the runner's grandchild where the parent's pipe
  // (fd 3) is closed. That file IS writable by the suite, which shares the driver's process, so it
  // is not trusted on its own: this reporter - the process the suite does not share - merges it into
  // the ONE nonce-tagged record it sends the parent over the pipe, and the parent decides from that
  // (airhorn-gwcm). The residual trust is a suite lying about its OWN load result; measured that the
  // lie cannot reach a false "caught".

  let driver = null;
  if (driverLines.length === 1 && typeof driverLines[0].importFailed === 'boolean' && !driverLines[0].crashedOutsideTest) {
    driver = driverLines[0];                                    // IMPORT
  } else if (driverLines.length === 2
      && typeof driverLines[0].importFailed === 'boolean' && driverLines[0].importFailed === false
      && driverLines[1].crashedOutsideTest === true) {
    driver = { ...driverLines[0], ...driverLines[1] };          // IMPORT, CRASH
  } else if (driverLines.length > 0) {
    driver = { tampered: true, lines: driverLines.length };     // any other sequence: forged or broken
  }
  const report = { driver, startedTests, realTests, realPassed, realFailed, fileLevelFailed, wrapperEvents, failing: failing.slice(0, 10) };
  const channelFd = Number(process.env.MUTATION_SUITE_CHANNEL);
  if (Number.isInteger(channelFd)) {
    try {
      fs.writeSync(channelFd, `${JSON.stringify({ kind: 'final', nonce: process.env.MUTATION_RUN_NONCE || null, ...report })}\n`);
    } catch {
      /* the parent reports a missing record as a named refusal, never as a verdict */
    }
  }
  console.log(`# suite-mode: ${JSON.stringify(report)}`);
}
