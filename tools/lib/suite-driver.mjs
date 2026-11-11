/*
 * tools/lib/suite-driver.mjs — the file the OUTER test runner is pointed at, for mutation-check.
 *
 * It exists because "did this suite ever run?" cannot be answered from names: node names the
 * file-level event with the path AS PASSED, so `--suite sub/suite.mjs` once made a crashing import
 * look like a failed test - a false "mutant-caught" (airhorn-lnme). Any answer built from spellings,
 * comments or import syntax is defeatable by text, so the answer comes from execution.
 *
 * WHY THERE ARE NOW TWO PROCESSES (airhorn-14ht, the successor to airhorn-dzsi).
 *
 * This file used to IMPORT the suite into its own process and write its records on stdout. Measured
 * consequence: the suite shares that stdout, so it could write record lines too, and every defence
 * came down to a GRAMMAR - a list of shapes. A grammar is only ever a shape a forger can imitate;
 * on the unlanded fleet/812k-guard one forged `yieldedToHarness` line plus process.abort() scored
 * "mutant-caught" rc 0. A nonce does not fix it either: MUTATION_RUN_NONCE was readable from
 * /proc/self/environ (proved by a reviewer and reproduced here), because proc shows the EXEC-TIME
 * environment, so an environment secret is provenance theatre.
 *
 * So the writer and the code under test are now in DIFFERENT processes:
 *
 *   outer runner  ->  THIS DRIVER (supervisor)  ->  child runner  ->  the suite
 *
 *   * This driver spawns the suite as a child, run by its own test runner whose reporter sends the
 *     event facts back on a PIPE THIS PROCESS OWNS (fd 3 of the child runner). The suite executes in
 *     that runner's WORKER, which does not inherit that fd (measured: a suite's fs.writeSync(3, ...)
 *     dies EINVAL), so the suite cannot write the facts.
 *   * Every byte the child emits on stdout/stderr is QUOTED with QUOTE_PREFIX before it reaches this
 *     process's stdout, which is the only stream the outer reporter reads records from. A line
 *     starting at column 0 with RECORD_PREFIX can therefore only have been written by THIS file.
 *
 * TRUST STATEMENT (airhorn-14ht) — what a record means and who can write it:
 *   A record is this supervisor's CLAIM about the child it spawned: whether the suite loaded, and
 *   the event facts the child's own runner reported. Only this process can write one, because the
 *   child's output is quoted and the fact pipe is not inherited by the suite.
 *   A forged line (any route: env, argv, a file, /proc, the child's stdout) reaches the outer
 *   reporter only inside QUOTE_PREFIX, where it is DATA and never a record. KNOWN-LIMIT: this file
 *   itself runs in the worker that hosts nothing but this supervisor - if the suite could execute
 *   code in THIS process it could write records, and it cannot: it has its own process.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RECORD_PREFIX = 'MUTATION-DRIVER-RECORD ';
// Quoted child bytes start with this. The outer reporter treats a line carrying it as DATA: the
// suite can print any record shape it likes and it will never be read as a record.
export const QUOTE_PREFIX = '  | ';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORTER = path.join(here, 'suite-mode-reporter.mjs');
// The suite-process sentinel (airhorn-5wns, the re-target of airhorn-5qdd onto this design):
// loaded via --import, which node --test propagates into the per-file process it spawns
// (measured: the guard's argv is the suite's path, and nothing else in the chain imports it).
// It watches the suite's own listener lists and refuses by dying non-clean, because a fact
// written from the suite's process would arrive here as quoted data. See suite-guard.mjs.
const GUARD = path.join(here, 'suite-guard.mjs');

const suite = process.env.MUTATION_SUITE_FILE;
const nonce = process.env.MUTATION_RUN_NONCE || null;

// CAPTURED AT LOAD TIME, before anything else runs in this process, so a later patch cannot stop a
// record being written (the supervisor has no untrusted imports, but the habit is cheap).
const writeRecordSync = fs.writeSync;
const record = (value) => {
  try {
    writeRecordSync.call(fs, 1, `${RECORD_PREFIX}${JSON.stringify(value)}\n`);
  } catch {
    /* the parent reports a missing record as a named refusal, never as a verdict */
  }
};

// Scrub the machinery from this process's environment (narrow value: this process's own children
// inherit it, so the CHILD env is built explicitly below rather than inherited).
for (const name of ['MUTATION_RUN_NONCE', 'MUTATION_SUITE_CHANNEL', 'MUTATION_SUITE_FILE', 'MUTATION_DRIVER_FILE', 'NODE_TEST_CONTEXT', 'NODE_TEST_WORKER_ID']) {
  delete process.env[name];
}

/** Forward the child's bytes quoted, one prefix per line, so nothing reaches column 0 unquoted. */
function quotingForwarder(stream) {
  let partial = '';
  const emit = (text) => {
    if (!text) return;
    // Split on newlines and prefix every line, including a trailing fragment.
    const lines = text.split('\n');
    let out = '';
    for (let i = 0; i < lines.length; i += 1) {
      const isLast = i === lines.length - 1;
      if (!isLast) out += `${QUOTE_PREFIX}${lines[i]}\n`;
      else if (lines[i].length > 0) out += `${QUOTE_PREFIX}${lines[i]}`;
    }
    if (out) {
      try { writeRecordSync.call(fs, 1, out); } catch { /* the verdict never rests on log text */ }
    }
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    partial += chunk;
    const cut = partial.lastIndexOf('\n');
    if (cut === -1) return;
    emit(partial.slice(0, cut + 1));
    partial = partial.slice(cut + 1);
  });
  stream.on('end', () => { emit(partial); partial = ''; });
}

if (!suite) {
  record({ importFailed: true, reason: 'MUTATION_SUITE_FILE was not set, so no suite was loaded' });
} else {
  const child = spawn(process.execPath, ['--import', GUARD, '--test', '--test-reporter', REPORTER, suite], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    // The child runner's reporter writes its facts on fd 3, a pipe THIS process owns. NODE_TEST_*
    // must be absent or the nested runner skips the child entirely (it refuses to run recursively).
    env: {
      ...process.env,
      MUTATION_SUITE_CHANNEL: '3',
      MUTATION_RUN_NONCE: nonce === null ? '' : nonce,
      // The suite IS the child's wrapper file: telling the reporter that keeps the file-level
      // failure of the suite separate from the suite's own tests, exactly as when this driver
      // imported it (airhorn-a6ch attribution).
      MUTATION_DRIVER_FILE: suite,
      // ...and by NAME, because in the child the wrapper and the tests share a file (measured: a
      // passing suite reported realTests 0 until the file-level entry was identified by its name).
      MUTATION_WRAPPER_BY_NAME: '1',
    },
    cwd: process.cwd(),
  });
  quotingForwarder(child.stdout);
  quotingForwarder(child.stderr);

  const facts = child.stdio[3];
  let channel = '';
  if (facts) {
    facts.setEncoding('utf8');
    facts.on('data', (chunk) => { channel += chunk; });
  }

  const closed = await new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
    child.on('error', (error) => resolve({ code: null, signal: null, error }));
  });

  // The last nonce-bearing final line is the child reporter's report. A line without this run's
  // nonce is not evidence (and cannot come from the suite: the suite has no handle on this pipe).
  let childReport = null;
  let nonceMismatch = false;
  for (const line of channel.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || parsed.kind !== 'final') continue;
    if (nonce !== null && parsed.nonce !== nonce) { nonceMismatch = true; continue; }
    childReport = parsed;
  }

  const exitCode = closed.code === null ? 1 : closed.code;
  const how = closed.signal ? `killed by ${closed.signal}` : `exited ${exitCode}`;
  if (nonceMismatch) {
    // The child's facts did not carry this run's nonce. Refused by name rather than judged.
    record({ importFailed: true, reason: 'the child report did not carry this run\'s nonce', nonceMismatch: true });
  } else if (!childReport) {
    // No facts at all: the child never reached its reporter (it died before the runner started, or
    // it was killed). Nothing about the mutant can be claimed.
    record({ importFailed: true, reason: `the child runner produced no report (${how}${closed.error ? `, ${closed.error.message}` : ''})` });
  } else {
    // The child's reporter reports the suite file as the wrapper: a file-level failure with no real
    // test means the suite never loaded. Everything else is the suite's own verdict.
    const importFailed = childReport.fileLevelFailed === true && (childReport.realTests || 0) === 0;
    // A file-level failure means something failed OUTSIDE any test. It is refused whether or not a test
    // also failed: when the crash lands while a test is in flight, node marks that test failed too, and
    // reading that as a catch is the false-green direction (measured: an indirect async throw at 5 ms
    // scored 'mutant-caught' rc 0 in one run and refused rc 3 in another - a race, depending only on
    // whether the throw beat the test's completion). Under-claiming here costs a re-run; over-claiming
    // ships a hole as caught.
    const crashedOutsideTest = !importFailed && exitCode !== 0 && childReport.fileLevelFailed === true;
    record({
      importFailed,
      ...(importFailed ? { reason: `the suite file failed to load or threw before registering a test (${how})` } : {}),
      ...(crashedOutsideTest ? { crashedOutsideTest: true, reason: `the suite run failed outside its tests and ${how}${(childReport.realFailed || 0) > 0 ? ' (a test was in flight when it failed, which is not the same as a test asserting about the mutant)' : ''}` } : {}),
      childReport,
    });
  }
  // The outer run's exit code carries the child's, so classifyRun's "non-zero with no failing test"
  // refusal (the plain-abort shape) still fires without any in-process handler.
  if (closed.signal) process.kill(process.pid, closed.signal);
  else process.exitCode = exitCode;
}
