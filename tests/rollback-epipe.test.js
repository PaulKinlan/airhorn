// Pin for airhorn-nnbu: an EPIPE before the rehearsal's ledger is persisted must NOT exit 0 -
// `node tools/rollback-rehearsal.mjs | head -1` used to green-light a rehearsal that never
// completed. The decision is the exported pure epipeExitCode; the handlers and the
// reportWritten flag are the wiring. Residual, stated plainly: deleting the handler's call
// greens this suite (the one-line-call gap every inline wiring has) - the honest world needs
// a real pipe closing mid-run, which means a browser drill; that proof is ad-hoc on the bead.
// The import being pure at all is itself pinned by the fc98 lesson: tools/rollback-rehearsal.mjs
// guards main() with invokedAsScript, so this import cannot launch a browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { epipeExitCode, rehearsalExitCode } from '../tools/rollback-rehearsal.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('nnbu: EPIPE exit code is honest about whether the ledger was written', () => {
  assert.equal(epipeExitCode(true), 0, 'a completed rehearsal (report.txt on disk) may exit 0 even if the display pipe died');
  assert.equal(epipeExitCode(false), 1, 'an EPIPE before the ledger is written must not report success');
});


test('a rehearsal that checked NOTHING exits nonzero (batch D row 3)', () => {
  assert.equal(rehearsalExitCode(0, 0), 1, 'zero checked steps is a rehearsal that measured nothing');
  assert.equal(rehearsalExitCode(3, 0), 0, 'checked and matched passes');
  assert.equal(rehearsalExitCode(3, 1), 1, 'a mismatch fails');
});


/* Same side-effect pin as resilience-audit's (the enumeration's second hit):
 * importing the rehearsal must not create its evidence directory. OUT derives from
 * os.homedir(), so the child runs with HOME pointed at a tmp dir. */
test('importing rollback-rehearsal creates no evidence directory (side-effect pin)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-import-pure-'));
  try {
    const run = spawnSync(process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(root, 'tools', 'rollback-rehearsal.mjs')).href)});`],
      { env: { ...process.env, HOME: tmp }, encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, `import itself must succeed: ${run.stderr}`);
    assert.ok(!fs.existsSync(path.join(tmp, 'rollback-rehearsal-evidence')),
      'an import must not create the evidence directory - writers make it on first use');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
