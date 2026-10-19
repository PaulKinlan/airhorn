/*
 * tests/gate-smoke.test.mjs — the gate's own selection contract and the
 * tools scripts' syntax, as a REAL suite (airhorn-1ye): mapping tools/* to
 * this suite means a change to tools/fast-gate.sh or tools/resilience-audit.mjs
 * is placed by coverage that actually exercises the file, not by a nominal
 * unit suite that never reads it.
 *
 * Everything here is browser-free and fast: --list runs the map, no suites.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = path.join(root, 'tools', 'fast-gate.sh');

const listFor = (changed) =>
  execFileSync('bash', [gate, '--changed', changed, '--list'], { cwd: root, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);

test('a worker change selects the offline + failover suites', () => {
  const suites = listFor('public/sw.js');
  // Subset, not equality: the map may legitimately add suites (the pending
  // test/ spellings, or suites arriving on other branches) and this contract
  // must survive that.
  for (const s of ['tests/sw-offline.test.mjs', 'tests/sw-failover.test.mjs']) {
    assert.ok(suites.includes(s), `public/sw.js must select ${s}, got ${JSON.stringify(suites)}`);
  }
  assert.ok(!suites.includes('tests/horn.test.js'),
    `a worker change must not select the horn unit suite, got ${JSON.stringify(suites)}`);
});

test('a page change selects the page suites', () => {
  const suites = listFor('src/main.js');
  for (const s of ['tests/a11y.test.mjs', 'tests/webmcp-browser.test.mjs', 'tests/resilience-ui.test.mjs']) {
    assert.ok(suites.includes(s), `src/main.js must select ${s}, got ${JSON.stringify(suites)}`);
  }
});

test('an audit-tool change selects this suite (the tools/* row is real)', () => {
  const suites = listFor('tools/resilience-audit.mjs');
  assert.ok(suites.includes('tests/gate-smoke.test.js'),
    `tools/resilience-audit.mjs must select the gate smoke suite, got ${JSON.stringify(suites)}`);
});

test('the dev server still parses (esbuild transform = the syntax check it gets)', () => {
  // server.ts is TypeScript outside the Vite bundle graph; the honest smoke
  // is a parse, via the esbuild that vite already ships (airhorn-1ye).
  execFileSync(path.join(root, 'node_modules', '.bin', 'esbuild'), [path.join(root, 'server.ts')], { stdio: 'pipe' });
});

test('the gate script parses (bash -n)', () => {
  execFileSync('bash', ['-n', gate]);
});

test('every tools script parses - any extension, any depth (airhorn-7lm, airhorn-7z5)', () => {
  // Glob, not names (airhorn-v1n), and EVERY script extension, not just .mjs:
  // the tools/* placement must be real for any script in the tree, present or
  // future - a NEW tools script with a syntax error must fail this suite, not
  // report coverage KNOWN.
  const entries = fs.readdirSync(path.join(root, 'tools'), { recursive: true });
  const scripts = entries.filter((f) => /\.(mjs|js|sh)$/.test(f));
  assert.ok(scripts.length >= 3, `expected the tools scripts to be present, got ${JSON.stringify(scripts)}`);
  for (const s of scripts) {
    const full = path.join(root, 'tools', s);
    if (/\.sh$/.test(s)) execFileSync('bash', ['-n', full]);
    else execFileSync(process.execPath, ['--check', full]);
  }
});

test('every script-tier suite is gated by a tests/support change (airhorn-dco)', () => {
  // The report hook is runner-injected into EVERY script-tier (*.test.mjs)
  // suite, so a hook edit can break any of them; the support row must name all
  // of them minus the explicit-only acceptance pass (airhorn-i8i), and this
  // assertion - derived from the tree, per run - is what makes that rule
  // fail loudly instead of living in a comment (airhorn-10q, airhorn-n00,
  // airhorn-5t8 were three recurrences of the same drift).
  const supportChange = 'tests/support/report-hook.mjs';
  const selected = new Set(listFor(supportChange));
  const scriptTier = fs.readdirSync(path.join(root, 'tests'))
    .filter((f) => /\.test\.mjs$/.test(f) && f !== 'acceptance.mjs')
    .map((f) => `tests/${f}`);
  assert.ok(scriptTier.length >= 6, `expected the script-tier suites to be present, got ${JSON.stringify(scriptTier)}`);
  for (const s of scriptTier) {
    assert.ok(selected.has(s), `a support-file change must select ${s} (the hook runs under it), got ${JSON.stringify([...selected])}`);
  }
});
