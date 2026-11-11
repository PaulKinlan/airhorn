#!/usr/bin/env node
/*
 * tools/preflight-map.mjs — the map/contract PREFLIGHT (airhorn-1pdt).
 *
 * One command, seconds, no browser: is the map/contract/doc triple coherent on
 * THIS tree? It exists because the merger ran these checks by hand for a day and
 * they caught two staged branches in one second each - a habit in one lane's head
 * is not infrastructure. Run it on a staged tree before a gate:
 *
 *   node tools/preflight-map.mjs
 *
 * Exit 0 prints the artefacts checked; exit 1 names WHICH artefact is stale:
 *   map row    - a row names a missing suite/literal, or a ghost pattern (--validate-map)
 *   contract   - .fleet/coverage-contract.json is stale vs the map (--check)
 *   pointer    - a '# why:' anchor has no doc section (--check-pointers)
 *
 * It deliberately does NOT run suites: the whole value is that it is cheap enough
 * to run before everything. The fast gate calls it unconditionally (guarded on the
 * artefacts existing, so fixture trees without a contract still gate).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DERIVE = path.join(root, 'tools', 'derive-coverage-contract.mjs');

const run = (args) => {
  try {
    execFileSync(process.execPath, [DERIVE, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (err) {
    return { ok: false, out: String(err.stderr || '') + String(err.stdout || '') };
  }
};

// The one-process --preflight does the work; on failure, re-run the modes to NAME the
// artefact (a failure is rare and worth the extra second; a pass pays one process).
const tsv = fs.readFileSync(path.join(root, 'tools', 'suite-map.tsv'), 'utf8');
if (tsv.length === 0) { console.error('FAIL preflight: tools/suite-map.tsv is empty or unreadable'); process.exit(1); }

const fast = run(['--preflight']);
if (fast.ok) {
  console.log('preflight OK: checked map rows, contract freshness, coverage-map pointers');
  process.exit(0);
}
for (const [mode, name] of [['--validate-map', 'MAP ROW'], ['--check', 'CONTRACT'], ['--check-pointers', 'POINTER']]) {
  const r = run([mode]);
  if (!r.ok) {
    console.error(`FAIL preflight: ${name}\n${r.out.trim()}`);
    process.exit(1);
  }
}
console.error(`FAIL preflight: ${fast.out.trim()}`);
process.exit(1);
