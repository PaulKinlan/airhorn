import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
// Pin for airhorn-nxuv.9: the sounded probe must count a start() only when playback
// actually STARTED. 18c0ad7 carried this fix and a later merge took the other side of
// the PROBE section, restoring increment-before-call - so a start() that THREW still
// read as a buffer started, and absence looked like success. These tests drive the REAL
// PROBE string the audit injects (no copy) against a mock AudioContext, browser-free.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCoreFieldGate, applyShotEvidenceGate, auditExitCode } from '../tools/resilience-audit.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const runProbe = (PROBE, { throwOnStart = false } = {}) => {
  const window = { __errors: [], addEventListener() {} };
  const node = {
    start() {
      if (throwOnStart) throw new Error('InvalidStateError: cannot start twice');
    },
  };
  class MockAC {
    createBufferSource() { return { ...node, start: node.start.bind(node) }; }
    createOscillator() { return { ...node, start: node.start.bind(node) }; }
  }
  window.AudioContext = MockAC;
  const fn = new Function('window', 'navigator', `${PROBE.replace(/^`|`$/g, '')}`);
  fn(window, {});
  return window;
};

test('a successful start() increments the counter (the honest world)', async () => {
  const { PROBE } = await import('../tools/resilience-audit.mjs');
  const window = runProbe(PROBE);
  const src = new (window.AudioContext)().createBufferSource();
  src.start();
  assert.equal(window.__probe.bufferStarts, 1);
  assert.equal(window.__probe.startThrows, 0);
});

test('a start() that THROWS is not counted as a start (the nxuv.9 defect world)', async () => {
  const { PROBE } = await import('../tools/resilience-audit.mjs');
  const window = runProbe(PROBE, { throwOnStart: true });
  const src = new (window.AudioContext)().createBufferSource();
  assert.throws(() => src.start(), /InvalidStateError/);
  assert.equal(window.__probe.bufferStarts, 0,
    'a throwing start() incremented bufferStarts - the probe records intent, not playback');
  assert.equal(window.__probe.startThrows, 1, 'the throw must be an explicit outcome');
  assert.match(window.__probe.lastStartError, /InvalidStateError/);
});

test('the mutation seam makes the same world without app cooperation (RESILIENCE_START_THROWS)', async () => {
  process.env.RESILIENCE_TEST_MODE = '1';
  process.env.RESILIENCE_START_THROWS = '1';
  try {
    const { PROBE } = await import(`../tools/resilience-audit.mjs?seam=${Date.now()}`);
    const window = runProbe(PROBE); // app start() is HEALTHY here; the seam replaces it
    const src = new (window.AudioContext)().createBufferSource();
    assert.throws(() => src.start(), /forced to throw/);
    assert.equal(window.__probe.bufferStarts, 0, 'the seam world must read NOT sounded');
    assert.equal(window.__probe.startThrows, 1);
  } finally {
    delete process.env.RESILIENCE_TEST_MODE;
    delete process.env.RESILIENCE_START_THROWS;
  }
});


/* batch D row 1: a scenario row must fail when its own declared claim fields come back
 * false / absent / 'unmeasurable' - before, only a thrown error failed a scenario, so a
 * measured failure printed in the verdict line and the audit exited 0. */
test('the core-field gate fails a row whose declared claim is false, named', () => {
  const row = applyCoreFieldGate({ id: 'x', name: 'x', status: 'OK', navigationCompleted: true, renders: false, hornUsable: true },
    ['navigationCompleted', 'renders', 'hornUsable']);
  assert.equal(row.status, 'FAILED');
  assert.match(row.error, /renders is false/);
  assert.equal(auditExitCode([row]), 1, 'the exit code must see the gated failure');
});

test('the core-field gate fails an absent declared field as unmeasured, and an unmeasurable string the same', () => {
  const absent = applyCoreFieldGate({ id: 'x', status: 'OK', renders: true }, ['renders', 'hornUsable']);
  assert.equal(absent.status, 'FAILED');
  assert.match(absent.error, /hornUsable.*never produced/);
  const unmeasurable = applyCoreFieldGate({ id: 'x', status: 'OK', recoveredAfterSwUpdate: 'unmeasurable: state unreadable' }, ['recoveredAfterSwUpdate']);
  assert.equal(unmeasurable.status, 'FAILED');
});

test('the core-field gate passes a row whose claims held, and never masks a thrown error', () => {
  const ok = applyCoreFieldGate({ id: 'x', status: 'OK', renders: true, hornUsable: true }, ['renders', 'hornUsable']);
  assert.equal(ok.status, 'OK');
  const already = { id: 'x', status: 'ERROR', error: 'threw' };
  assert.equal(applyCoreFieldGate(already, ['renders']), already, 'a thrown error passes through untouched');
});

/* batch D row 2 (coord's decision): a missing shot is NOT automatically a failure -
 * it is recorded as degraded evidence on the row; a scenario that declares its shot
 * REQUIRED fails (FAILED) when it is absent; one that does not stays green with the
 * state visible. */
test('a required-but-missing shot fails the row, named as degraded evidence', () => {
  const row = applyShotEvidenceGate({ id: 'x', status: 'OK', renders: true, screenshot: null }, true);
  assert.equal(row.status, 'FAILED');
  assert.match(row.error, /degraded evidence: screenshot/);
  assert.equal(auditExitCode([row]), 1, 'the exit code must see FAILED');
});

test('a missing shot on a shot-optional scenario stays green WITH the state visible', () => {
  const row = applyShotEvidenceGate({ id: 'x', status: 'OK', renders: true, screenshot: null }, false);
  assert.equal(row.status, 'OK', 'not every scenario is its screenshot');
  assert.match(row.screenshotState, /degraded evidence/);
  assert.equal(auditExitCode([row]), 0);
});

test('a captured shot leaves the row untouched, and the array form is checked too', () => {
  const ok = { id: 'x', status: 'OK', screenshot: 'out/1-offline.png' };
  assert.equal(applyShotEvidenceGate(ok, true), ok);
  const partial = applyShotEvidenceGate({ id: 'y', status: 'OK', screenshots: ['a.png', null] }, true);
  assert.equal(partial.status, 'FAILED');
});


/* Side-effect pin (coord 2026-11-09, the import-purity check's documented blind spot):
 * importing the audit must not create its evidence directory - the enumeration found
 * the module-scope mkdirSync(OUT) and it was made lazy. A child process keeps the
 * world hermetic (the import happens there, not in this test's own module graph). */
test('importing resilience-audit creates no evidence directory (side-effect pin)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-import-pure-'));
  try {
    const evidenceDir = path.join(tmp, 'evidence');
    const run = spawnSync(process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(root, 'tools', 'resilience-audit.mjs')).href)});`],
      { env: { ...process.env, RESILIENCE_OUT: evidenceDir }, encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, `import itself must succeed: ${run.stderr}`);
    assert.ok(!fs.existsSync(evidenceDir), 'an import must not create the evidence directory - writers make it on first use');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
