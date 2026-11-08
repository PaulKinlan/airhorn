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
import { epipeExitCode, rehearsalExitCode } from '../tools/rollback-rehearsal.mjs';

test('nnbu: EPIPE exit code is honest about whether the ledger was written', () => {
  assert.equal(epipeExitCode(true), 0, 'a completed rehearsal (report.txt on disk) may exit 0 even if the display pipe died');
  assert.equal(epipeExitCode(false), 1, 'an EPIPE before the ledger is written must not report success');
});


test('a rehearsal that checked NOTHING exits nonzero (batch D row 3)', () => {
  assert.equal(rehearsalExitCode(0, 0), 1, 'zero checked steps is a rehearsal that measured nothing');
  assert.equal(rehearsalExitCode(3, 0), 0, 'checked and matched passes');
  assert.equal(rehearsalExitCode(3, 1), 1, 'a mismatch fails');
});
