/*
 * Harness-level case reporting for the script-tier suites (airhorn-n00).
 *
 * The suites in this repo report in three different ways: `tests/horn.test.js`
 * registers with node:test (so per-case names reach the TAP summary), while
 * `tests/a11y.test.mjs`, `tests/sw-offline.test.mjs`, `tests/webmcp-browser.test.mjs`
 * and `tests/webmcp.test.mjs` are assert-scripts that narrate and exit. Under
 * `node --test` each script is one file-level test, so a failure says "the suite
 * failed" and nothing about which step, and the gate summary has no counts.
 *
 * This preload (`node --import tests/support/report-hook.mjs <suite>`) records what
 * the suite already tells us, without the suites being rewritten:
 *   - every narration line becomes a timed event;
 *   - a line beginning `##case## <name>` is an explicit case boundary, for suites
 *     that want real case names (one line per case, no control-flow change);
 *   - the exit code decides pass/fail, and the last narration or error line
 *     before exit is reported as the failing case.
 *
 * It writes `<resultsDir>/<suite>.json` and prints a single `##RESULT## {json}`
 * line, which `tools/fast-gate.sh` reads to print per-case results and to build
 * one aggregate summary. It never swallows output: the originals still run.
 *
 * Convention for suite authors (documented in tools/gate.conf):
 *   console.log('##case## <name>')     explicit, named case - preferred;
 *   any other console.log/console.error  a step event, timed and attributable;
 *   throwing / process.exit(non-zero)    failure, attributed to the last event.
 */
import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

const MAX_EVENTS = 200;
const MAX_TEXT = 300;

const suitePath = process.argv[1] || '<unknown>';
const suite = path.relative(process.cwd(), suitePath) || suitePath;
const resultsDir = process.env.AIRHORN_RESULTS_DIR || '/tmp/airhorn-test-results';
const startedAt = Date.now();

const events = [];
const cases = [];
let last = null;
let lastStep = null;
let failure = null;
let written = false;

const clip = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text);

const record = (level, args) => {
  const text = format(...args);
  last = { at: Date.now() - startedAt, level, text: clip(text) };
  if (events.length < MAX_EVENTS) events.push(last);
  // Three ways a suite can name a case, none of which requires rewriting it:
  // the documented `##case## <name>` marker, or the TAP-ish `ok - <name>` /
  // `not ok - <name>` lines that tests/webmcp.test.mjs already prints.
  const named = /^##case## (.+)$/.exec(text) ||
    /^ok - (.+)$/.exec(text) ||
    /^not ok - (.+)$/.exec(text);
  if (named) {
    cases.push({
      name: named[1].trim(),
      at: last.at,
      status: text.startsWith('not ok') ? 'fail' : 'pass',
    });
  }
  // The suites report the cause on the way out; keep the last one that looks like
  // an error so the summary can name it even when exitCode is all we get.
  const looksLikeFailure =
    level === 'error' || /^(Test failed|Error|AssertionError|.*\buncaught\b)/i.test(text);
  if (looksLikeFailure) {
    failure = last;
  } else {
    // The step a failure is attributed to: the last thing the suite said it was
    // doing before the error, which is what a reader actually needs.
    lastStep = last;
  }
};

const originalLog = console.log.bind(console);
const originalError = console.error.bind(console);
console.log = (...args) => {
  record('log', args);
  originalLog(...args);
};
console.error = (...args) => {
  record('error', args);
  originalError(...args);
};

const finish = () => {
  if (written) return;
  written = true;
  const code = process.exitCode ?? 0;
  const status = code === 0 ? 'pass' : 'fail';
  const failingCase = status === 'fail' ? (failure || last) : null;
  const result = {
    suite,
    tier: 'script',
    status,
    exitCode: code,
    durationMs: Date.now() - startedAt,
    events: events.length,
    cases: cases.length,
    caseNames: cases.map((c) => c.name),
    lastEvent: last,
    failingCase,
  };
  try {
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(
      path.join(resultsDir, `${suite.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`),
      JSON.stringify(result, null, 2),
    );
  } catch (err) {
    originalError(`report-hook: could not write results: ${err.message}`);
  }
  originalLog(`##RESULT## ${JSON.stringify(result)}`);

  // One human line for the gate to echo, so it needs no JSON parser of its own.
  const quote = (event) => (event ? JSON.stringify(event.text.replace(/\s+/g, ' ').slice(0, 120)) : 'none');
  const failedNamed = cases.filter((c) => c.status === 'fail').map((c) => c.name);
  const parts = [
    `suite=${suite}`,
    `tier=script`,
    `status=${status}`,
    `events=${result.events}`,
    `named-cases=${result.cases}`,
    `duration=${result.durationMs}ms`,
    `last-step=${quote(status === 'fail' ? lastStep : last)}`,
  ];
  if (failedNamed.length) parts.push(`failed-cases=${JSON.stringify(failedNamed.join(', '))}`);
  if (status === 'fail') parts.push(`cause=${quote(failure || last)}`);
  originalLog(`##CASES## ${parts.join(' ')}`);
};

process.on('exit', finish);
// A suite killed by a signal or an uncaught throw still exits; the hook reports
// what it saw, and the gate keeps treating "no result + non-zero" as a failure.
process.on('uncaughtExceptionMonitor', (err) => {
  failure = { at: Date.now() - startedAt, level: 'uncaught', text: clip(`Uncaught ${err && err.stack || err}`) };
});
