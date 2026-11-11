// Pins for the resilience-audit visibility batch (airhorn-s68m, airhorn-o7ad,
// airhorn-hovu, airhorn-jhf3) - the class where a run LOOKS complete while something
// was silently dropped. Browser-free: the console echo is driven through the exported
// writeReport with stub scenarios; the RESILIENCE_ONLY refusal and the seam warning
// are spawned invocations that exit before any browser is needed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReport, blockedAssetHeadline } from '../tools/resilience-audit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'resilience-audit.mjs');

const stubRow = (id, extra = {}) => ({
  id, name: `scenario ${id}`, status: 'OK', renders: true, hornVisible: true,
  hornUsable: true, explainsItself: true, explanationEvidence: 'e', ...extra,
});

test('s68m: the console echo prints EVERY scenario row, including the last (airhorn-s68m)', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 's68m-'));
  const printedLines = [];
  const origLog = console.log;
  console.log = (...args) => printedLines.push(args.join(' '));
  try {
    writeReport([stubRow('alpha'), stubRow('beta'), stubRow('omega')], out);
  } finally {
    console.log = origLog;
  }
  const echo = printedLines.join('\n');
  for (const id of ['alpha', 'beta', 'omega']) {
    assert.match(echo, new RegExp(`\\b${id} — scenario ${id}\\b`),
      `the console echo is missing scenario '${id}' - a dropped row reads as a complete run`);
  }
});

// airhorn-6oug: both spawned invocations go through startServer(), which reads
// dist/sw.js BEFORE selector validation - in a tree without a build they fail
// naming the shim, not the missing build. Skip with the real cause named.
const distSw = path.join(root, 'dist', 'sw.js');
const needsBuild = { skip: !fs.existsSync(distSw) && 'needs a built dist/ (npm run build) - the tool reads dist/sw.js before selector validation' };

test('o7ad: an unknown RESILIENCE_ONLY selector refuses by name, rc 1, before any browser (airhorn-o7ad)', needsBuild, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'o7ad-'));
  const run = spawnSync(process.execPath, [tool], {
    env: { ...process.env, RESILIENCE_ONLY: 'offlien', RESILIENCE_OUT: out, CHROME_BIN: '/nonexistent-chrome' },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(run.status, 1, `an unknown selector must refuse nonzero (got ${run.status}); without the validation this run measures nothing and greens`);
  assert.match(run.stderr, /RESILIENCE_ONLY names unknown scenario\(s\): offlien/, `stderr must name the unknown selector:\n${run.stderr}`);
});

test('hovu: a seam set to a truthy non-1 value WITH test mode is dropped LOUDLY (airhorn-hovu)', needsBuild, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hovu-'));
  const run = spawnSync(process.execPath, [tool], {
    env: { ...process.env, RESILIENCE_TEST_MODE: '1', RESILIENCE_START_THROWS: 'true', RESILIENCE_ONLY: 'none', RESILIENCE_OUT: out, CHROME_BIN: '/nonexistent-chrome' },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(run.status, 0, `RESILIENCE_ONLY=none is the documented empty run (got ${run.status})`);
  assert.match(run.stderr, /RESILIENCE_START_THROWS=true is honoured only as exactly '1'/,
    `a seam that is set but not honoured must SAY so (was silent with test mode on):\n${run.stderr}`);
});

test('aizv: the note/explains columns carry the reason and the measured document (airhorn-aizv)', () => {
  // Not a whole-table snapshot (s68m owns row count/identity): assert the CONTENT of the
  // reason/doc columns for exactly the rows that exercise them, so the markdown cannot
  // drift (drop the doc, drop the error reason) without this going red.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aizv-'));
  const origLog = console.log;
  console.log = () => {};
  try {
    writeReport([
      stubRow('docrow', { measuredDocument: 'http://x/deep-link' }),
      stubRow('errrow', { status: 'ERROR', error: 'browser exploded', hornVisible: false, hornUsable: false, explainsItself: false, explanationEvidence: 'none' }),
    ], out);
  } finally {
    console.log = origLog;
  }
  const md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
  const lineFor = (id) => md.split('\n').find((l) => l.startsWith(`| ${id} —`));
  assert.ok(lineFor('docrow'), 'the doc row must exist');
  assert.match(lineFor('docrow'), /doc: http:\/\/x\/deep-link/, 'the note column must carry the measured document');
  assert.match(lineFor('docrow'), /yes \(e\)/, 'the explains column must carry the evidence in parentheses');
  assert.ok(lineFor('errrow'), 'the error row must exist');
  assert.match(lineFor('errrow'), /\| ERROR \|/, 'an error row must read ERROR in the renders column');
  assert.match(lineFor('errrow'), /browser exploded/, 'the note column must carry the error reason');
});

test('jhf3: the blocked-asset headline is the subcase that measured a failure, JS first (airhorn-jhf3)', () => {
  const ok = { label: 'css', hornUsable: true, degraded: false, navigationCompleted: true };
  const jsFailed = { label: 'js', hornUsable: false, degraded: false, navigationCompleted: true };
  const cssFailed = { ...ok, label: 'css', degraded: true };
  assert.equal(blockedAssetHeadline(jsFailed, ok).headlineSubcase, 'js',
    'when only JS measured a failure the headline must be the JS subcase, not the CSS spread');
  assert.equal(blockedAssetHeadline(jsFailed, cssFailed).headlineSubcase, 'js',
    'when both measured failures the more basic asset (JS) is named');
  const clean = blockedAssetHeadline(ok, { ...ok });
  assert.equal(clean.headlineSubcase, 'css', 'with no measured failure the CSS subcase stays the representative');
  assert.match(clean.headlineNote, /no subcase measured a failure/);
});
