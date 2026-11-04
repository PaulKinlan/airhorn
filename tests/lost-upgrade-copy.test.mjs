import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertLostUpgradeNotice, lostUpgradeVerdicts, LOST_UPGRADE_COPY } from './support/lost-upgrade-copy.mjs';
import { guardedCallProblem } from '../tools/guarded-call.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const enforcer = path.join(here, 'support', 'lost-upgrade-copy.mjs');
const notice = 'The app could not update - you are still on the previous version.';
const bad = 'a notice that says nothing useful';
const SPEC = { callee: 'assertLostUpgradeNotice', from: './support/lost-upgrade-copy.mjs' };

// Run `body` in its own node process with the enforcer imported as `assertLostUpgradeNotice`,
// so the exit backstop can be observed without killing this test process.
function runInChild(body) {
  const script = `
    import { assertLostUpgradeNotice } from ${JSON.stringify(enforcer)};
    ${body}
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
}

test('the actual lost-upgrade notice passes the enforcer', () => {
  assert.doesNotThrow(() => assertLostUpgradeNotice(notice));
  assert.deepEqual(LOST_UPGRADE_COPY, ['The app could not update', 'previous version']);
});

test('the enforcer records that it ran and what it decided (airhorn-6829)', () => {
  const before = lostUpgradeVerdicts().length;
  assertLostUpgradeNotice(notice);
  const verdicts = lostUpgradeVerdicts().slice(before);
  assert.deepEqual(verdicts, [{ ran: true, ok: true }],
    'a passing call must be recorded as having run - the caller cannot fake this');
});

test('a non-enforcing announcement fails the PROCESS, naming the missing copy (airhorn-rrme)', () => {
  const res = runInChild(`assertLostUpgradeNotice(${JSON.stringify(bad)});`);
  assert.equal(res.status, 1, `a bad notice must end the process non-zero (got ${res.status}): ${res.stderr}`);
  assert.match(res.stderr, /the lost-upgrade notice is missing "The app could not update"/,
    'the failure must name the missing copy');
});

// The four worlds below are the answer to review findings airhorn-nqje and airhorn-f96y. The first
// two failed text pins; the last two failed shape rules. They are all refused by the same mechanism
// now - a scheduled non-zero exit that a caught throw cannot cancel - so no calling shape can honour
// a failure the suite swallowed.

test('airhorn-f96y: a caller that CATCHES the throw is still failed - try/catch', () => {
  const res = runInChild(`
    try { assertLostUpgradeNotice(${JSON.stringify(bad)}); } catch {}
    setTimeout(() => console.log('the suite carried on'), 50);
  `);
  assert.equal(res.status, 1, `try/catch must not be able to swallow the failure (got ${res.status})`);
  assert.match(res.stderr, /missing "The app could not update"/);
  assert.doesNotMatch(res.stdout, /the suite carried on/,
    'the failure must land before the caller continues');
});

test('airhorn-f96y: a WRAPPER that catches for the caller is still failed - the reviewer repro', () => {
  // The exact shape the reviewer used: discardFailure(callback) catches the callback's exception.
  const res = runInChild(`
    function discardFailure(callback) { try { callback(); } catch {} }
    discardFailure(() => { assertLostUpgradeNotice(${JSON.stringify(bad)}); });
  `);
  assert.equal(res.status, 1, `a wrapper must not be able to swallow the failure (got ${res.status})`);
  assert.match(res.stderr, /missing "The app could not update"/);
});

test('airhorn-f96y: a promise .catch() handler is still failed, and a stubbed process.exit does not help', () => {
  const res = runInChild(`
    process.exit = () => {};            // a caller that tries to neutralise the backstop
    Promise.resolve().then(() => assertLostUpgradeNotice(${JSON.stringify(bad)})).catch(() => {});
  `);
  assert.equal(res.status, 1, `stubbing process.exit must not swallow the failure (got ${res.status})`);
  assert.match(res.stderr, /missing "The app could not update"/);
});

test('the shipped shape is GREEN and unchanged: a correct notice exits 0', () => {
  const res = runInChild(`assertLostUpgradeNotice(${JSON.stringify(notice)});`);
  assert.equal(res.status, 0, `a correct notice must not fail the process: ${res.stderr}`);
  assert.equal(res.stderr, '');
});

// The static pin: presence, resolution and reachability. Swallowing is not its job any more - the
// enforcer closes that by construction (above) - which is why a wrapper is GREEN here and still fails
// at runtime.
test('the pin is GREEN for the shipped delegation shape and for a wrapping call', () => {
  const shipped = [
    "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';",
    '',
    'async function testBootWatchdog() {',
    '  const lost = await readLost();',
    '  await shot("lost-upgrade-announced");',
    '  assertLostUpgradeNotice(lost.text);',
    '}',
    'testBootWatchdog().catch((err) => { console.error(err); process.exit(1); });',
  ].join('\n');
  assert.equal(guardedCallProblem(shipped, SPEC), null);

  const wrapped = [
    "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';",
    'function discardFailure(callback) { try { callback(); } catch {} }',
    "test('lost upgrade', () => {",
    '  discardFailure(() => { assertLostUpgradeNotice(lost.text); });',
    '});',
  ].join('\n');
  assert.equal(guardedCallProblem(wrapped, SPEC), null,
    'a wrapper cannot swallow the enforcer (see the child-process proofs above), so it is not a pin failure');
});

test('the pin is RED when the call is deleted, commented out or stringified', () => {
  for (const body of [
    '',
    '  // assertLostUpgradeNotice(lost.text);',
    '  /* assertLostUpgradeNotice(lost.text); */',
    "  const note = 'assertLostUpgradeNotice(lost.text);';",
  ]) {
    const source = [
      "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';",
      'async function testBootWatchdog() {',
      '  const lost = await readLost();',
      body,
      '}',
    ].join('\n');
    assert.match(guardedCallProblem(source, SPEC) ?? '', /never calls assertLostUpgradeNotice/,
      `a call that is not in the tree must be RED: ${JSON.stringify(body)}`);
  }
});

test('the pin is RED when the call is replaced by a local lookalike', () => {
  const lookalike = [
    "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';",
    'function assertLostUpgradeNotice(text) { return text; }',
    'async function run() {',
    '  assertLostUpgradeNotice(lost.text);',
    '}',
  ].join('\n');
  assert.match(guardedCallProblem(lookalike, SPEC) ?? '', /declares its own assertLostUpgradeNotice/,
    'a local replacement can return instead of enforcing');

  const viaVariable = [
    "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';",
    'const assertLostUpgradeNotice = (text) => text;',
    'async function run() {',
    '  assertLostUpgradeNotice(lost.text);',
    '}',
  ].join('\n');
  assert.match(guardedCallProblem(viaVariable, SPEC) ?? '', /declares its own assertLostUpgradeNotice/);

  const noImport = [
    'function assertLostUpgradeNotice(text) { return text; }',
    'async function run() {',
    '  assertLostUpgradeNotice(lost.text);',
    '}',
  ].join('\n');
  assert.match(guardedCallProblem(noImport, SPEC) ?? '', /must import assertLostUpgradeNotice/);
});

test('the pin is RED when the call may never run', () => {
  const head = "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';\nasync function run() {\n";
  for (const [label, body] of [
    ['if (false) { ... }', '  if (false) { assertLostUpgradeNotice(lost.text); }'],
    ['a ternary', '  const ok = lost ? assertLostUpgradeNotice(lost.text) : true;'],
    ['&& short-circuit', '  lost && assertLostUpgradeNotice(lost.text);'],
    ['a for loop', '  for (const one of list) assertLostUpgradeNotice(one.text);'],
    ['a discarded result', '  void assertLostUpgradeNotice(lost.text);'],
  ]) {
    const problem = guardedCallProblem(`${head}${body}\n}`, SPEC);
    assert.ok(problem, `${label} must be RED, got GREEN`);
  }
  // A try/catch around the call does NOT make it unreachable, and the enforcer survives it.
  const inTry = `${head}  try { assertLostUpgradeNotice(lost.text); } catch (err) { throw err; }\n}`;
  assert.equal(guardedCallProblem(inTry, SPEC), null,
    'a rethrowing catch is reachable and cannot discard the scheduled exit');
});
