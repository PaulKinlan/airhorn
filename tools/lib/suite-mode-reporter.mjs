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

/**
 * Do two spellings name the same file? Four ways, all from the event's own fields - equal strings,
 * equal basenames, the same realpath, or the same resolved path - so neither the caller's spelling
 * of the suite nor the OS's normalisation of the path can move the answer (airhorn-u1v2).
 *
 * A real test whose file shares the driver's BASENAME answers yes, which under-claims, and
 * under-claiming is the safe direction for this tool.
 */
export function exportedSameFile(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  if (a === b) return true;
  try { if (path.basename(a) === path.basename(b)) return true; } catch { /* not a path */ }
  try { if (path.resolve(a) === path.resolve(b)) return true; } catch { /* not a path */ }
  try { if (fs.realpathSync(a) === fs.realpathSync(b)) return true; } catch { /* one side is gone */ }
  return false;
}

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
  let wrapperEventsCount = 0;
  // "caught" may only be claimed when a test actually STARTED inside the suite and failed
  // (airhorn-so88). A start is the runner's own evidence that execution reached a test, so it
  // cannot be forged by text, and it is distinct from a failure the runner reports for its own
  // synthetic file-level event.
  let startedTests = 0;
  // airhorn-u1v2 (unique delta): an event the reporter cannot ATTRIBUTE to a file is not allowed
  // to become a real test by default. The old attribution was one comparison - the event's
  // realpath against the driver's - so a missing data.file or a realpath that failed on one side
  // only turned the driver's own file-level event into a "real failing test": a false caught mutant
  // from a run where no test executed. Attribution is now total (exportedSameFile, four ways), and
  // an event that cannot be attributed is COUNTED and reported, never silently scored.
  let unattributed = 0;
  /**
   * Is this event the DRIVER's own file-level entry?
   *
   * Four ways, all from the event's own fields, so neither the caller's spelling of the suite nor
   * the OS's normalisation of the path can move it: equal strings; equal basenames; the two
   * canonicalise (realpath) to the same file; or the two resolve to the same path. In the other
   * direction - a real test whose name happens to equal the driver's basename - the answer is
   * "wrapper", which under-claims, and under-claiming is the safe direction for this tool.
   */
  const sameFile = exportedSameFile;
  const isDriverEvent = (data) => Boolean(driverFile) && sameFile(data.file, driverFile);
  /**
   * A describe() block is a CONTAINER, not a test: it starts, passes and fails without any
   * assertion, and a suite whose only node is a container used to answer "a test started" with no
   * test in it (airhorn-u1v2).
   *
   * It cannot be recognised AT THE START: measured on node 24, `test:start` carries no
   * `details.type`, while `test:complete` / `test:pass` / `test:fail` carry `type: 'suite'` for a
   * container and `'test'` for a test, and `test:complete` arrives BEFORE the `test:start` of the
   * same entry. So containers are collected first and subtracted from the started set at the end.
   *
   * They are subtracted by testId, NOT by (file, name, nesting): those three are not unique - a
   * top-level describe('group') and a top-level test('group') have the same file, the same name and
   * the same nesting, so a keyed subtraction erased the REAL test's start, startedTests fell to 0,
   * and a genuinely caught mutant was refused as threw-outside-a-test (airhorn-glhj). testId is
   * unique per node and present on start as well as on pass/fail/complete.
   */
  // ONE container node reports BOTH test:complete and test:pass with type 'suite' (measured on node
  // 24), so containers are counted by testId, never by event count.
  const containerIds = new Set();
  let containersWithoutId = 0;
  const starts = [];
  let startsWithoutId = 0;

  // The driver's record arrives as stdout lines from the driver FILE's process (airhorn-y3d6,
  // second round - there is no record file any more). The honest sequence is a grammar:
  //   IMPORT                one line { importFailed: ... }
  //   IMPORT, CRASH         a clean import followed by { crashedOutsideTest: true } (airhorn-so88)
  //   IMPORT, STRIP[, STRIP]  a clean import followed by the strip watcher's { handlersStripped: true }
  //                         line(s) and NO crash line - named SUPPRESSION, not a broken record (airhorn-co4h)
  //   IMPORT, STRIP, CRASH  the once() self-removal artifact, which is a real crash (airhorn-p0dg)
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
    const data = event.data || {};
    const isTestEvent = event.type === 'test:start' || event.type === 'test:pass' || event.type === 'test:fail';
    const attributed = typeof data.file === 'string' && data.file.length > 0;
    // Only TEST events are attributable-or-not; a diagnostic, a stdout chunk or the driver's own
    // record line has no file and is not a measurement of anything.
    if (isTestEvent && !attributed) unattributed += 1;
    if (data.details && data.details.type === 'suite') {
      if (data.testId) containerIds.add(data.testId);
      else containersWithoutId += 1;
    }
    if (event.type === 'test:start') {
      if (attributed && !isDriverEvent(data)) {
        starts.push(data.testId ?? null);
        if (!data.testId) startsWithoutId += 1;
      }
      continue;
    }
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const name = typeof data.name === 'string' ? data.name : '<unnamed>';
    if (isDriverEvent(data)) {
      wrapperEventsCount += 1;
      if (event.type === 'test:fail') fileLevelFailed = true;
      continue;
    }
    // A container is not a test that failed, so it is never counted as one and never named as a
    // failing test (airhorn-u1v2: 'group' appeared beside the real failure 'inside').
    if (data.details && data.details.type === 'suite') continue;
    if (!attributed) continue;
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

  // The driver's record says whether the suite LOADED at all, and it is the only thing that decides
  // "never ran" - no name or path comparison anywhere. There is NO record file any more (airhorn-
  // y3d6, second round): it arrives as stdout lines, which the suite can ADD to but cannot UNWRITE,
  // so a forgery breaks the grammar above and is refused by the parent rather than believed. The
  // counts that decide "caught" are unaffected either way - they are read from the runner's events
  // in THIS process, which the suite does not share.

  // THE GRAMMAR, as a total classification of the record SET rather than a list of line spellings
  // (airhorn-co4h). The strip watcher writes its line WHENEVER the suite removes an instrument - at the top
  // of the suite (BEFORE the import record is written), in a timer (after it), or twice - so an honest run's
  // line ORDER varies in ways length/order matching cannot express. Measured on master 191d5ded: a top-level
  // strip produced [STRIP, IMPORT] and the operator was told "a record was forged or broken" about their own
  // deliberate strip. The rules are a set, with only the orders that mean something:
  //
  //   STRIP*     strip lines, in any position (one per removed instrument; a forgery of one buys nothing, it
  //              can only produce a refusal - see classifyRun)
  //   IMPORT     exactly one { importFailed: boolean }
  //   CRASH      at most one { crashedOutsideTest: true }, and it must be LAST: the handler writes it and
  //              exits, so a record line after it can only be forged
  //   PRECEDED   at most one { handlersPreceded: true }, written by the exit-time rejection position check
  //
  // Anything else - an unknown line, a duplicate IMPORT/CRASH/PRECEDED, a line after a CRASH - is tampering.
  const imports = driverLines.filter((line) => line && typeof line.importFailed === 'boolean');
  const crashes = driverLines.filter((line) => line && line.crashedOutsideTest === true);
  const strips = driverLines.filter((line) => line && line.handlersStripped === true);
  const precededs = driverLines.filter((line) => line && line.handlersPreceded === true);
  const knownLines = imports.length + crashes.length + strips.length + precededs.length;
  const stripFields = strips.length > 0
    ? {
      handlersStripped: true,
      strippedLines: strips.length,
      strippedReason: strips.map((line) => (typeof line.reason === 'string' && line.reason ? line.reason : null)).find(Boolean) || null,
    }
    : {};
  // A tampered record still CARRIES the strip (airhorn-co4h): the sequence is invalid either way, but the
  // operator is told the crash handlers were removed as well instead of only that something was forged.
  const invalid = (why) => ({ tampered: true, lines: driverLines.length, why, ...stripFields });

  let driver = null;
  if (driverLines.length === 0) {
    driver = null;                                            // nothing recorded: the parent names never-ran
  } else if (knownLines !== driverLines.length) {
    driver = invalid('a line was not a driver record at all');
  } else if (imports.length > 1 || crashes.length > 1 || precededs.length > 1) {
    driver = invalid('a record kind appeared twice');
  } else if (crashes.length === 1) {
    // CRASH (airhorn-so88/5qdd): the crash is real. The CRASH line must be LAST - the handler writes it and exits, so a
    // record line after it can only be forged. Strip lines BESIDE it are carried, because they are real removals: the
    // once() self-removal artifact the p0dg branch was written for NO LONGER EXISTS (measured: the driver installs plain
    // process.on listeners, and a plain listener firing emits no 'removeListener' event), so dropping them would hide a
    // genuine suppression that happened alongside a crash the monitor still caught. classifyRun names both.
    if (driverLines[driverLines.length - 1] !== crashes[0]) driver = invalid('a record line arrived after the crash');
    else driver = { importFailed: imports.length === 1 ? imports[0].importFailed : false, ...crashes[0], ...stripFields };
  } else if (precededs.length === 1 && imports.length === 1) {
    // IMPORT + PRECEDED (airhorn-rnj5/5qdd): a rejection listener ahead of ours. Rejections have no monitor, so
    // this exit-time position check is the one place a position check still earns its keep. Refused as
    // untrustworthy rather than read as a pass.
    driver = { ...imports[0], handlersPreceded: true, precededReason: precededs[0].reason, ...stripFields };
  } else if (imports.length === 1) {
    // IMPORT, with strip lines before it (a top-level strip), after it (a timer), or both: the honest shapes.
    driver = { ...imports[0], ...stripFields };
  } else if (strips.length > 0) {
    // STRIP lines and NO import record: the suite removed an instrument and the process ended before the import
    // finished. That is a suppression report, not a forgery - there is nothing here that was forged.
    driver = { ...stripFields };
  } else {
    driver = invalid('the sequence fitted no honest shape');
  }
  // A start only counts if the entry was a TEST: everything the runner later reported as a suite
  // container is subtracted here, because the start event itself carries no type. By id where the
  // events carry one (they do on node 24); by COUNT otherwise, which also cannot collide.
  // When every event carries a testId the subtraction is exact. If one does not, subtract NOTHING:
  // the two directions are not equally bad - erasing a real start refuses a genuinely caught mutant
  // (airhorn-glhj, visible and wrong), while leaving a container in the count only makes "a test
  // started" slightly easier to satisfy on a runtime that does not identify its own nodes.
  startedTests = startsWithoutId === 0 && containersWithoutId === 0
    ? starts.filter((id) => !containerIds.has(id)).length
    : starts.length;
  const report = { driver, startedTests, realTests, realPassed, realFailed, fileLevelFailed, wrapperEvents: wrapperEventsCount, unattributed, failing: failing.slice(0, 10) };
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
