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
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = path.join(root, 'tools', 'fast-gate.sh');

// Sentinel cleanup (airhorn-ey1): a bound kill during the symlink pin can
// leave its probe link behind, which would redden the tools parse of the
// NEXT run before the pin gets a chance to clean up. Remove stale probes
// before any test runs - but spare the link THIS run's pin is about to
// create/own (named in GSM_PROBE_NAME), or a pin child would delete its
// parent's live probe and read a false green.
const probeLinkName = (suffix) => `zz-symlink-probe-${suffix}.mjs`;
const keepProbe = process.env.GSM_PROBE_NAME;
for (const f of fs.readdirSync(path.join(root, 'tools'))) {
  if (/^zz-symlink-probe-.+\.mjs$/.test(f) && f !== keepProbe) {
    fs.rmSync(path.join(root, 'tools', f), { force: true });
  }
}

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

test('every tools script parses - recognised extensions at any depth (airhorn-7lm, airhorn-7z5, airhorn-h19)', () => {
  // Glob, not names (airhorn-v1n), and every RECOGNISED script extension,
  // not just .mjs (airhorn-h19: .cjs and .ts were unparseable, extensionless
  // files invisible). A tools file with no parser is a failure, not a skip:
  // teach the checker or list the extension as data here.
  const PARSERS = {
    '.mjs': (f) => execFileSync(process.execPath, ['--check', f]),
    '.js': (f) => execFileSync(process.execPath, ['--check', f]),
    '.cjs': (f) => execFileSync(process.execPath, ['--check', f]),
    '.ts': (f) => execFileSync(path.join(root, 'node_modules', '.bin', 'esbuild'), [f]),
    '.sh': (f) => execFileSync('bash', ['-n', f]),
  };
  const DATA_EXTS = new Set(['.conf', '.tsv', '.json', '.md', '.txt']);
  const entries = fs.readdirSync(path.join(root, 'tools'), { recursive: true, withFileTypes: true });
  let parsed = 0;
  for (const ent of entries) {
    // A symlink can point at a real script: Dirents are lstat-based, so a
    // symlink reports neither file nor directory - resolve it before
    // classifying, or a mirror of a broken script reads as covered
    // (airhorn-0ct). Directories remain containers (airhorn-mo4).
    let isFile = ent.isFile();
    // resolve (not join): parentPath is spelled with the readdir base, which
    // is absolute here - join would double it and read a nonexistent path.
    const full = path.resolve(root, ent.parentPath || ent.path, ent.name);
    if (!isFile && !ent.isDirectory()) {
      let st = null;
      try { st = fs.statSync(full); } catch { st = null; }
      if (!st) assert.fail(`tools/${path.relative(root, full)} is a dangling symlink - remove it or point it at a real file (airhorn-0ct, airhorn-pww)`);
      isFile = st.isFile();
    }
    if (!isFile) continue;
    const rel = path.relative(root, full);
    const ext = path.extname(rel);
    if (DATA_EXTS.has(ext)) continue;
    const parse = PARSERS[ext];
    if (!parse) {
      // Keep h19's guarantee while saying precisely what to do: an
      // extensionless file must become a parseable script or gain an
      // extension this suite can classify.
      const hint = ext === ''
        ? 'add a script extension (.mjs/.js/.cjs/.ts/.sh) so gate-smoke can parse it, or move it - extensionless tools files are assumed to be scripts'
        : 'add a parser for its extension to gate-smoke, or move it to the data list';
      assert.fail(`no parser for ${rel}: ${hint} (airhorn-h19, airhorn-mo4)`);
    }
    parse(path.join(root, rel));
    parsed += 1;
  }
  assert.ok(parsed >= 3, `expected the tools scripts to be present, got ${parsed}`);
});

test('every script-tier suite is gated by a tests/support change (airhorn-dco)', () => {
  // The report hook is runner-injected into EVERY script-tier (*.test.mjs)
  // suite, so a hook edit can break any of them; the support row must name all
  // of them minus the explicit-only acceptance pass (airhorn-i8i), and this
  // assertion - derived from the tree, per run - is what makes that rule
  // fail loudly instead of living in a comment (airhorn-10q, airhorn-n00,
  // airhorn-5t8 were three recurrences of the same drift).
  const supportChange = 'tests/support/report-hook.mjs';
  const selected = listFor(supportChange).sort();
  const scriptTier = fs.readdirSync(path.join(root, 'tests'))
    .filter((f) => /\.test\.mjs$/.test(f) && f !== 'acceptance.mjs')
    .map((f) => `tests/${f}`).sort();
  assert.ok(scriptTier.length >= 6, `expected the script-tier suites to be present, got ${JSON.stringify(scriptTier)}`);
  // EXACT set, not subset (airhorn-cae): over-naming matters as much as
  // under-naming - tests/acceptance.mjs in this row would put a full
  // browser acceptance pass on every support change, and subset-only
  // checking would call that correct.
  assert.deepEqual(selected, scriptTier,
    `the support row must select exactly the script-tier suites:\n  row: ${JSON.stringify(selected)}\n  expected: ${JSON.stringify(scriptTier)}`);
});
// Self-invocation guard with an unguessable key (airhorn-j60): the child
// re-runs this suite; without the guard it would create the probe symlink
// again and recurse forever. The key carries a random suffix so a stray
// GATE_SMOKE_SELF=1 in the environment cannot silently disable the pin.
const guardKey = `GATE_SMOKE_SELF_${crypto.randomBytes(4).toString('hex')}`;
const guardActive = () => Object.keys(process.env).some((k) => /^GATE_SMOKE_SELF_[0-9a-f]{8}$/.test(k));

test('the tools parse fails on a symlinked broken script and passes a valid one (airhorn-0ct)', {
  skip: guardActive() ? 'self-invocation guard' : false,
}, () => {
  // A regression pin that invokes the REAL suite: with a symlinked broken
  // script in tools/, the tools parse must fail; with a valid target, pass.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-smoke-symlink-'));
  const probeName = probeLinkName(crypto.randomBytes(4).toString('hex'));
  const link = path.join(root, 'tools', probeName);
  const runSelf = () => {
    // Strip the runner's NODE_TEST_CONTEXT: a child node --test that inherits
    // it believes it is a managed test child, writes nothing and exits 0 -
    // the silent green that made this pin read as a false pass.
    const childEnv = { ...process.env, [guardKey]: '1', GSM_PROBE_NAME: probeName };
    delete childEnv.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', path.join(root, 'tests', 'gate-smoke.test.js')], {
      cwd: root, encoding: 'utf8',
      env: childEnv,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const lines = out.split('\n').filter((l) => /not ok|pass |fail |SyntaxError|Error/.test(l)).slice(0, 6).join(' || ');
    return { status: r.status, tail: `err=${r.error ? r.error.code : 'none'} ${lines}` };
  };
  try {
    fs.writeFileSync(path.join(tmp, 'broken.mjs'), 'const x = {');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(tmp, 'broken.mjs'), link);
    const brokenRun = runSelf();
    assert.notEqual(brokenRun.status, 0, `a symlinked BROKEN tools script must fail the suite: ${brokenRun.tail}`);

    fs.writeFileSync(path.join(tmp, 'valid.mjs'), 'export const ok = 1;');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(tmp, 'valid.mjs'), link);
    const validRun = runSelf();
    assert.equal(validRun.status, 0, `a symlinked VALID tools script must pass the suite: ${validRun.tail}`);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
