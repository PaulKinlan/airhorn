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
import net from 'node:net';
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
 * world hermetic (the import happens there, not in this test's own module graph).
 * airhorn-nrmn: the pin also covers the SPAWN the first enumeration missed - with
 * RESILIENCE_OUT unset, makeEvidenceDir() execSyncs git; a marker git shim in PATH
 * proves no child is spawned at import. */
test('importing resilience-audit creates no evidence directory and spawns no git (side-effect pin)', () => {
  // airhorn-4ve4: name what the instrument OBSERVES - a git spawn (the shim is a file
  // named git). And the marker path travels via ENV, not shell interpolation: the
  // unquoted-interpolation form word-splits on a TMPDIR with a space and turns the pin
  // into a silent false green. The tmp root here deliberately CONTAINS a space so the
  // quoting is load-bearing forever, not just when someone's TMPDIR is unusual.
  const spacedParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ra import-pure-'));
  const tmp = fs.mkdtempSync(path.join(spacedParent, 'w'));
  try {
    const evidenceDir = path.join(tmp, 'evidence');
    const marker = path.join(tmp, 'git-spawned');
    fs.writeFileSync(path.join(tmp, 'git'), '#!/bin/sh\nprintf x > "$AIRHORN_PIN_MARKER"\nexec /usr/bin/git "$@"\n');
    fs.chmodSync(path.join(tmp, 'git'), 0o755);
    const run = spawnSync(process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(root, 'tools', 'resilience-audit.mjs')).href)});`],
      { env: { ...process.env, RESILIENCE_OUT: evidenceDir }, encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, `import itself must succeed: ${run.stderr}`);
    assert.ok(!fs.existsSync(evidenceDir), 'an import must not create the evidence directory - writers make it on first use');
    // airhorn-nrmn: with RESILIENCE_OUT UNSET, makeEvidenceDir() would execSync git
    // if it ran at import; the marker shim proves no child is spawned.
    const runNoEnv = spawnSync(process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(root, 'tools', 'resilience-audit.mjs')).href)});`],
      { env: { ...process.env, PATH: `${tmp}:${process.env.PATH}`, RESILIENCE_OUT: undefined, AIRHORN_PIN_MARKER: marker }, encoding: 'utf8', timeout: 30000 });
    assert.equal(runNoEnv.status, 0, `import without RESILIENCE_OUT must succeed: ${runNoEnv.stderr}`);
    assert.ok(!fs.existsSync(marker), 'an import must not spawn git (airhorn-nrmn) - the evidence dir resolves lazily on first use');
  } finally {
    fs.rmSync(spacedParent, { recursive: true, force: true });
  }
});

/* ---- airhorn-017s: the harness origin's request path is decoded and contained by the
 * shared helper, not by hand. The hand-rolled version threw URIError inside the request
 * listener for a malformed escape (uncaught -> the whole run dies with a stack instead of
 * answering), and matched containment with a lexical path prefix (a sibling directory
 * sharing the root's prefix, or a symlink under the root, left the served tree).
 * These drive the REAL startServer() over a real socket. */

const rawGet = (port, target) => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => {
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  });
  let data = '';
  socket.setEncoding('utf8');
  socket.setTimeout(15000, () => socket.destroy(new Error('the origin never answered')));
  socket.on('data', (chunk) => { data += chunk; });
  socket.on('error', reject);
  socket.on('close', () => resolve(data));
});

const statusOf = (response) => Number((response.match(/^HTTP\/1\.1 (\d{3})/) || [])[1]);

test('the harness origin answers a malformed escape with a named 400 and keeps serving (017s)', async () => {
  const { startServer } = await import('../tools/resilience-audit.mjs');
  const { server, port } = await startServer();
  try {
    const bad = await rawGet(port, '/%zz');
    assert.equal(statusOf(bad), 400, `a malformed escape must be a 400, not a thrown URIError: ${bad.slice(0, 200)}`);
    assert.match(bad, /bad percent-escape/, 'the refusal must name the cause, not answer a bare status');
    // The crash this pins was process-fatal: the run never got to its teardown or report.
    const after = await rawGet(port, '/index.html');
    assert.equal(statusOf(after), 200, 'the origin must still answer after refusing a malformed request');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the harness origin refuses a request that resolves outside the served root (017s)', async () => {
  const { startServer } = await import('../tools/resilience-audit.mjs');
  const { server, port } = await startServer();
  try {
    const escape = await rawGet(port, '/../outside.txt');
    assert.equal(statusOf(escape), 403, `traversal must be refused, not served: ${escape.slice(0, 200)}`);
    assert.match(escape, /outside the served root/, 'the refusal must name what it refused');
    const contained = await rawGet(port, '/index.html');
    assert.equal(statusOf(contained), 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the SW version stamp proves the SERVED worker declares the bumped version (airhorn-7fol)', async () => {
  // The stamp's guard used to be "the text changed" (some replace() happened), which is a weaker property than
  // "the new build is a DIFFERENT build": the reviewer's repro put 'const version = "0.9.0-legacy";' in a COMMENT,
  // the substitution rewrote the comment, the served worker still declared the old build, and the run reported a
  // successful stamp while the update scenario compared the same build twice. The served bytes are now checked
  // per request: exactly one declaration, and it must read the version the audit bumped to.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '7fol-dist-'));
  const swPath = path.join(dir, 'sw.js');
  const clean = 'const CACHE = "airhorn";\nconst version = "__BUILD_HASH__";\n';
  fs.writeFileSync(swPath, clean);
  process.env.RESILIENCE_AUDIT_DIST = dir;
  try {
    // A fresh module instance: distDir is read at import time, so the query string is what points it here.
    const { startServer } = await import(`../tools/resilience-audit.mjs?7fol=${Date.now()}`);
    const { server, port } = await startServer();
    try {
      const ok = await rawGet(port, '/sw.js');
      assert.equal(statusOf(ok), 200, `a coherent sw.js must be served: ${ok.slice(0, 300)}`);
      assert.match(ok, /const version = "2\.0\.0-audit-base";/, 'the served worker declares the bumped version');
      assert.doesNotMatch(ok, /__BUILD_HASH__/, 'and never the build placeholder');

      // The decoy appears AFTER start() validated the file, which is the reviewer's exact sequence.
      fs.writeFileSync(swPath, `// migrated: was const version = "0.9.0-legacy";\n${clean}`);
      const decoy = await rawGet(port, '/sw.js');
      assert.equal(statusOf(decoy), 500, `an ambiguous stamp must refuse to serve: ${decoy.slice(0, 300)}`);
      assert.match(decoy, /2 'const version = "\.\.\.";' declarations/, 'and name how many declarations it found');
      assert.doesNotMatch(decoy, /const version = "2\.0\.0-audit-base";/, 'nothing may be served as a stamped worker');
      assert.doesNotMatch(decoy, /new build/, 'the run must not be told the update was stamped');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    delete process.env.RESILIENCE_AUDIT_DIST;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a stamp the harness could not serve reaches the operator with the scenario error (airhorn-mgsz)', async () => {
  // The 500 body goes to the BROWSER, so the operator used to read "service worker never activated (timed_out) ...
  // unregistered" and chase an SW/browser fault for what is really a drift in the served worker. The named cause
  // must travel with the ERROR, which is what these three worlds check.
  const { stampFailureNote, assertSwActive } = await import('../tools/resilience-audit.mjs');
  const swFailed = { active: false, reason: 'timed_out', detail: 'service worker never activated within 6000ms' };

  assert.equal(stampFailureNote({}), '', 'no stamp failure means no note - the scenario message stays as it was');
  assert.equal(stampFailureNote(null), '', 'and a missing state cannot invent one');
  assert.throws(() => assertSwActive(swFailed, 'update', { swStampFailure: 'the sw.js stamp did not land in the served worker' }),
    (error) => {
      assert.match(error.message, /failed to activate \(timed_out\)/, 'the activation failure is still named');
      assert.match(error.message, /the harness could not serve a stamped sw.js: the sw\.js stamp did not land/,
        `the harness cause must ride along with the scenario error: ${error.message}`);
      return true;
    });

  // The live wiring: a real serve of a decoy worker records the failure on the state the scenarios read, and a
  // good serve clears it (a stale note must not be attached to a later, unrelated failure).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgsz-dist-'));
  const swPath = path.join(dir, 'sw.js');
  const clean = 'const version = "__BUILD_HASH__";\n';
  fs.writeFileSync(swPath, clean);
  process.env.RESILIENCE_AUDIT_DIST = dir;
  try {
    const { startServer } = await import(`../tools/resilience-audit.mjs?mgsz=${Date.now()}`);
    const { server, port, state } = await startServer();
    try {
      assert.equal(stampFailureNote(state), '', 'a coherent worker leaves no note');
      fs.writeFileSync(swPath, `// was const version = "0.9.0-legacy";\n${clean}`);
      assert.equal(statusOf(await rawGet(port, '/sw.js')), 500);
      assert.match(stampFailureNote(state), /the harness could not serve a stamped sw\.js: the served sw\.js carries 2/,
        'the refusal is recorded where the scenarios can read it');
      fs.writeFileSync(swPath, clean);
      assert.equal(statusOf(await rawGet(port, '/sw.js')), 200);
      assert.equal(stampFailureNote(state), '', 'and a good serve clears it');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    delete process.env.RESILIENCE_AUDIT_DIST;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
