/*
 * tests/gate-map.test.mjs - the gate's MAP AND SELECTION contract, with no process
 * pins: every case here answers "what does this change select / is the map honest /
 * is the contract fresh". Split out of tests/gate-smoke.test.js (airhorn-gkqu) so a
 * lane asking that question gets a verdict in tens of seconds instead of paying for
 * the launch and parse pins, which stayed behind.
 *
 * Boundary rule: if a case runs the gate in a probe repo, spawns a browser or parses
 * every tools/ script, it belongs in gate-smoke; if it reads the map, the contract or
 * a module's own logic, it belongs here. The preamble is deliberately duplicated in
 * the two files rather than shared through a module: a shared helper under
 * tests/support/** is mapped to every browser suite, so editing it would select the
 * whole battery (measured: an 18-suite selection and a 900 s kill).
 */

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
import esbuild from 'esbuild';
import { makeRenderModel } from '../tools/render-model.mjs';
import { READ_STATE } from '../tools/resilience-audit.mjs';
import { main as deriveContractMain, deriveCoverageContract, formatCoverageContract, deriveMapOpinion, extractPendingSuites, isPendingSuite, importersOf, suiteFiles, checkCoverageMapPointers } from '../tools/derive-coverage-contract.mjs';
import { assertGuardedCall } from '../tools/guarded-call.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = path.join(root, 'tools', 'fast-gate.sh');

// Self-invocation guard with an unguessable key AND a per-run token
// (airhorn-j60, airhorn-5os, airhorn-2de): the child re-runs this suite;
// without the guard it would recurse forever. The skip fires only when
// the key's VALUE matches the token THIS pin minted - an inherited key
// (any value) cannot satisfy it, so a stray can neither disable the pin
// nor make it skip silently: a top-level run without the exact token
// always RUNS the pin.
//
// Probe isolation (airhorn-ey1, airhorn-je9, airhorn-tun, airhorn-8r4): the
// pin never writes into the repo's own tools/ directory. Instead, it copies
// tools/ into a throwaway temp directory and passes GSM_TOOLS_ROOT to the
// child. GSM_TOOLS_ROOT is honoured ONLY when guardActive() is true, so an
// ambient/stray env var cannot redirect or weaken a real gate run. This
// eliminates sentinel cleanup, PID-tagged probe names, and concurrency
// collisions between overlapping runs.
const guardKey = `GATE_SMOKE_SELF_${crypto.randomBytes(4).toString('hex')}`;
const guardToken = crypto.randomBytes(8).toString('hex');
// GATE_SMOKE_SELF carries "key:token" - BOTH minted by the pin process.
// A child re-checks env[key] === token against the INHERITED names, so the
// pairing survives process boundaries; a stray value (no colon, wrong
// name, wrong token) fails the parse or the lookup and the pin RUNS.
// Both halves must have the minted shapes - an ambient 'HOME:<value>'
// or any other bystander pair must not satisfy the lookup (airhorn-2de).
const guardActive = () => {
  const spec = process.env.GATE_SMOKE_SELF || '';
  const i = spec.indexOf(':');
  if (i < 0) return false;
  const key = spec.slice(0, i);
  const token = spec.slice(i + 1);
  if (!/^GATE_SMOKE_SELF_[0-9a-f]{8}$/.test(key)) return false;
  if (!/^[0-9a-f]{16}$/.test(token)) return false;
  return process.env[key] === token;
};

const listFor = (changed) =>
  execFileSync('bash', [gate, '--changed', changed, '--list'], { cwd: root, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);

// --- the fleet coverage contract vs the map (airhorn-ona) --------------------
// tools/suite-map.tsv is THE map the gate runs; .fleet/coverage-contract.json
// restates it for ~/fleet/remote/check-coverage.py, the independent oracle that
// cannot read a TSV. Two hand-maintained copies of one opinion drift - they did
// (airhorn-ona: index.html still named the failover suite, src/main.js was
// missing it) - so the drift is now a test instead of a comment asking politely.
const contractPath = path.join(root, '.fleet', 'coverage-contract.json');
const readContract = () => JSON.parse(fs.readFileSync(contractPath, 'utf8'));

// `**` and `*` are the same opinion spelled differently by the two files; the
// oracle treats both as "everything under this directory".
const normPattern = (p) => p.replace(/\/\*\*$/, '/*');

const defaultPendingDeclared = extractPendingSuites(fs.readFileSync(path.join(root, 'tools', 'suite-map.tsv'), 'utf8'));
const isPendingSpelling = (suite) => isPendingSuite(suite, defaultPendingDeclared, (rel) => fs.existsSync(path.join(root, rel)));

// The rows the contract restates: every path the map places, exemptions (`!`)
// and pending suites (`~`) aside. Single-sourced from deriveMapOpinion so
// gate-smoke and derive-coverage-contract never disagree (airhorn-56dj).
const CONTRACT_EXEMPT_EXT = new Set(['.json', '.md', '.txt', '.lock', '.png', '.svg', '.jpg']);

// Every disagreement, in both directions: a suite the contract over-names makes
// the oracle report a truthful PARTIAL as a false one, and a suite it UNDER-names
// is a blind spot the oracle cannot see (it reports KNOWN while a covering suite
// never ran). Prose/data paths (package.json, *.md) are compared when the
// contract names them, but not required: the oracle exempts those extensions
// itself, so a missing entry costs nothing there.
const contractDrift = (contract, tsvText = fs.readFileSync(path.join(root, 'tools', 'suite-map.tsv'), 'utf8')) => {
  const pendingDeclared = extractPendingSuites(tsvText);
  const fileExists = (rel) => fs.existsSync(path.join(root, rel));
  const isPending = (suite) => isPendingSuite(suite, pendingDeclared, fileExists);

  const want = deriveMapOpinion(tsvText, { root, fileExists });
  const problems = [];
  const seen = new Set();
  for (const [pattern, suites] of Object.entries(contract)) {
    const key = normPattern(pattern);
    seen.add(key);
    const row = want.get(key);
    if (!row) {
      problems.push(`${pattern}: the contract names it, the map places nothing there`);
      continue;
    }
    const got = new Set((Array.isArray(suites) ? suites : [suites]).filter((s) => !isPending(s)));
    const missing = [...row].filter((s) => !got.has(s));
    const extra = [...got].filter((s) => !row.has(s));
    if (missing.length) problems.push(`${pattern}: the map runs ${missing.join(', ')}, the contract omits it`);
    if (extra.length) problems.push(`${pattern}: the contract names ${extra.join(', ')}, the map does not run it`);
  }
  for (const [key, suites] of want) {
    if (seen.has(key)) continue;
    if (CONTRACT_EXEMPT_EXT.has(path.extname(key))) continue;
    problems.push(`${key}: the map places it (${[...suites].join(', ')}), the contract has no entry`);
  }
  return problems;
};

test('a worker change selects the offline + failover suites', () => {
  const input = 'public/sw.js';
  // The selector's changed-file input must exist: a deleted input would make
  // this check pass while selecting nothing real (airhorn-n0sd).
  assert.ok(fs.existsSync(path.join(root, input)), `selector input ${input} is missing from the tree`);
  const suites = listFor(input);
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
  // Since the split (airhorn-1l04) src/main.js is the COMPOSITION root: what a
  // change there can break is the wiring itself, so its row is the structural
  // suite that pins the wiring plus the two browser suites that assert the
  // composition contract no static check can see (the boot marker and the
  // WebMCP registration). Behavioural coverage moved to the concern rows below.
  const input = 'src/main.js';
  assert.ok(fs.existsSync(path.join(root, input)), `selector input ${input} is missing from the tree`);
  // One real selector run, then both directions are read off it: `--list` costs
  // ~0.5 s, and this suite is on the tools/* row.
  const suites = listFor(input);
  for (const s of ['tests/modules.test.js', 'tests/webmcp-browser.test.mjs', 'tests/resilience-ui.test.mjs']) {
    assert.ok(suites.includes(s), `src/main.js must select ${s}, got ${JSON.stringify(suites)}`);
  }
  // The other direction: the composition row must NOT be paying for the app.
  for (const s of ['tests/horn.test.js', 'tests/multitab.test.mjs', 'tests/shortcuts.test.mjs']) {
    assert.ok(!suites.includes(s), `src/main.js must not select the concern suite ${s}, got ${JSON.stringify(suites)}`);
  }
});

test('the split gives every concern its own row, and the gate cost tracks blast radius (airhorn-1l04)', () => {
  // Read the map through y7mx's single-sourced derivation (deriveMapOpinion), not
  // by spawning `fast-gate.sh --list` once per path and not with a second parser:
  // each spawn costs ~0.5 s, and a local parseSuiteMap copy was deleted when the
  // mapping was single-sourced (airhorn-48ce) - which is exactly how this test
  // rebased onto a ReferenceError. The SELECTOR is exercised for real by the
  // page-change test above; this one is about the rows.
  const byPattern = deriveMapOpinion(fs.readFileSync(path.join(root, 'tools', 'suite-map.tsv'), 'utf8'), { root });
  const selectorsFor = (file) => [...(byPattern.get(file) || [])];

  // Every module under src/ is mapped: a new module with no row would make the
  // fast gate report 'unmapped' - loud, but only once someone edited it. This is
  // the cheap direction of the same check, at rest.
  const modules = fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js')).sort();
  assert.ok(modules.length >= 8, `src/ must hold the split modules, found ${JSON.stringify(modules)}`);
  const unmapped = modules.filter((f) => selectorsFor(`src/${f}`).length === 0);
  assert.deepEqual(unmapped, [], `these src modules select no suite: ${unmapped.join(', ')}`);

  // The point of the split, as a measurable: a concern-only change runs its own
  // suites, not the eight the single module used to select. These two are the
  // narrowest concerns - a badge fix and a deep-link fix - and both must stay
  // off the horn's interaction suites.
  const badge = selectorsFor('src/badge.js');
  assert.ok(badge.includes('tests/multitab.test.mjs'),
    `a badge change must run multitab, got ${JSON.stringify(badge)}`);
  for (const s of ['tests/keyboard.test.mjs', 'tests/horn.test.js', 'tests/a11y.test.mjs', 'tests/shortcuts.test.mjs']) {
    assert.ok(!badge.includes(s), `a badge change must not run ${s}, got ${JSON.stringify(badge)}`);
  }
  const launch = selectorsFor('src/launch.js');
  assert.ok(launch.includes('tests/shortcuts.test.mjs'),
    `a deep-link change must run shortcuts, got ${JSON.stringify(launch)}`);
  for (const s of ['tests/horn.test.js', 'tests/a11y.test.mjs', 'tests/resilience-ui.test.mjs']) {
    assert.ok(!launch.includes(s), `a deep-link change must not run ${s}, got ${JSON.stringify(launch)}`);
  }

  // And the concerns that share a signal are not accidentally duplicated: across
  // THIS set of rows the structural suite must be the only thing they have in
  // common. Asserted, not just described (airhorn-auoa): the previous version
  // only checked that each row includes it, so a second suite quietly added to
  // all six - the over-naming drift that re-widens the gate - would have passed.
  // horn.js and webmcp.js are deliberately outside this set: their rows are not
  // pinned by the structural suite (horn is the interaction suites' business,
  // webmcp the tool suites'), so "every module row" would have been false.
  const pinned = ['src/input.js', 'src/badge.js', 'src/launch.js', 'src/install.js', 'src/status.js', 'src/analytics.js'];
  const rows = pinned.map((m) => new Set(selectorsFor(m)));
  const shared = [...rows[0]].filter((suite) => rows.every((row) => row.has(suite))).sort();
  assert.deepEqual(shared, ['tests/modules.test.js'],
    `the structural suite must be the only suite shared by these rows; shared: ${JSON.stringify(shared)}`);
});

test('the page row keeps the failover suite off it - and the branch it lost is covered anyway (airhorn-906)', () => {
  // Two halves of one decision, pinned together so neither can drift alone.
  // (a) the cost decision: the 14s SW-update suite stays off the most-edited
  // file (airhorn-iwf).
  const pageRow = listFor('index.html');
  assert.ok(!pageRow.includes('tests/sw-failover.test.mjs'),
    `index.html must not select the SW-update suite, got ${JSON.stringify(pageRow)}`);
  assert.ok(pageRow.includes('tests/resilience-ui.test.mjs'),
    `index.html must select resilience-ui, got ${JSON.stringify(pageRow)}`);
  // (b) the page authors the copy - in public/sw-register.js as of airhorn-xnd1
  // (it was inline in index.html, which the CSP no longer allows); the selected
  // suite delegates its live observation to an enforcer whose failure is proven
  // by its own browser-free
  // unit test. Do not scan the suite's prose for copy: a comment/non-enforcing
  // action used to pass that check (airhorn-rrme), and so did a commented-out
  // call, a stringified call and a swallowed call (airhorn-nqje).
  //
  // The pin asks the SYNTAX TREE (tools/guarded-call.mjs) whether the call is
  // there, whether it resolves to the tested import, and whether it can actually
  // run. It deliberately does NOT police swallowing shapes (try/catch, a wrapper,
  // a .catch()): an earlier revision did, and the next shape was found within
  // minutes of review (airhorn-f96y), because "can this throw reach the harness"
  // depends on the whole calling graph. That class is closed at the ENFORCER
  // instead: a missing copy schedules a non-zero exit that a caught throw cannot
  // cancel, and tests/lost-upgrade-copy.test.mjs proves it in child processes for
  // try/catch, a catch-all wrapper and a promise .catch() - including a caller that
  // stubs process.exit. So a wrapped call here is GREEN because it is harmless, and
  // the enforcement is measured rather than inferred from a call expression.
  const page = fs.readFileSync(path.join(root, 'public', 'sw-register.js'), 'utf8');
  const suite = fs.readFileSync(path.join(root, 'tests', 'resilience-ui.test.mjs'), 'utf8');
  for (const copy of ['The app could not update', 'previous version']) {
    assert.ok(page.includes(copy), `public/sw-register.js must author the lost-upgrade copy "${copy}"`);
  }
  assertGuardedCall(suite, { callee: 'assertLostUpgradeNotice', from: './support/lost-upgrade-copy.mjs' },
    'tests/resilience-ui.test.mjs');
  // The worker's own failure story is still the failover suite's job, and the
  // suite still has a row owner (the worker). No page module carries worker code
  // since the split (airhorn-1l04): the registration handler lives in
  // public/sw-register.js (inline in index.html until airhorn-xnd1), which is why
  // that file's row carries the copy assertions and the page row still selects
  // the suite that drives it.
  assert.ok(listFor('public/sw.js').includes('tests/sw-failover.test.mjs'),
    'public/sw.js must still select the failover suite');
  // (c) the REPLACEMENT coverage, asserted here rather than left implied. Before
  // the split this test's "covered anyway" half was `src/main.js` selecting
  // sw-failover, which the split made false. Dropping it must not leave the
  // composition root ungated: if main.js stops selecting the suites that actually
  // exercise it, this must fail. The pointer/keyboard path it wires is input.js's
  // (its row owns the interaction suites), and main.js's own wiring is pinned by
  // the browser-free structural suite - so both ends are named, not assumed.
  const compositionRow = listFor('src/main.js');
  for (const s of ['tests/modules.test.js', 'tests/resilience-ui.test.mjs']) {
    assert.ok(compositionRow.includes(s),
      `src/main.js must still select ${s} - the composition root cannot lose its coverage when the page row drops a suite, got ${JSON.stringify(compositionRow)}`);
  }
  const inputRow = listFor('src/input.js');
  for (const s of ['tests/keyboard.test.mjs', 'tests/horn.test.js']) {
    assert.ok(inputRow.includes(s),
      `src/input.js must still select ${s} - the P0 pointer/keyboard semantics live there, got ${JSON.stringify(inputRow)}`);
  }
});

test('the fleet coverage contract restates the map, not a stale opinion (airhorn-ona)', () => {
  const problems = contractDrift(readContract());
  assert.deepEqual(problems, [],
    `the coverage contract and tools/suite-map.tsv disagree:\n  ${problems.join('\n  ')}`);
});

test('contractDrift recognizes ~-declared pending suites on live rows (airhorn-x0xr, airhorn-m03d)', () => {
  const syntheticTsv = [
    '~tests/future-suite.test.mjs\ttests/future-suite.test.mjs',
    'src/main.js\ttests/horn.test.js tests/future-suite.test.mjs',
  ].join('\n');
  const contract = {
    'src/main.js': ['tests/horn.test.js'],
  };
  const problems = contractDrift(contract, syntheticTsv);
  assert.deepEqual(problems, [],
    `contractDrift must recognize ~-declared pending suites and report no drift, got: ${problems.join(', ')}`);
});

test('deriveMapOpinion and contractDrift handle self-rows with pending suites identically (airhorn-56dj)', () => {
  const syntheticTsv = [
    'src/extra.js\tsrc/extra.js test/notyet.test.mjs\n',
  ].join('\n');
  const contract = deriveCoverageContract(syntheticTsv, { root });
  assert.equal(contract['src/extra.js'], undefined, 'self-row with pending suite must be omitted from contract');
  const problems = contractDrift(contract, syntheticTsv);
  assert.deepEqual(problems, [], 'contractDrift must agree with generator on self-row omission');
});

test('deriveMapOpinion and contractDrift union repeated patterns across multiple rows (airhorn-56dj)', () => {
  const syntheticTsv = [
    'src/main.js\ttests/horn.test.js',
    'src/main.js\ttests/visual-overrides.test.mjs',
  ].join('\n');
  const contract = deriveCoverageContract(syntheticTsv, { root });
  assert.deepEqual(contract['src/main.js'], ['tests/horn.test.js', 'tests/visual-overrides.test.mjs']);
  const problems = contractDrift(contract, syntheticTsv);
  assert.deepEqual(problems, [], 'contractDrift must union repeated patterns without drift');
});

test('the drift check fails when the two files disagree (airhorn-ona)', () => {
  // A comparator nobody has seen fail is a comparator nobody can trust: pin the
  // EXACT drift airhorn-ona reported, and the under-naming direction, without
  // touching either file.
  const contract = readContract();
  const stale = structuredClone(contract);
  stale['index.html'] = [...stale['index.html'], 'tests/sw-failover.test.mjs'];
  // After the split, src/badge.js is the sole carrier of the cross-tab count, so
  // that is the row the under-naming direction is exercised on; master's version
  // mutated src/main.js/sw-failover, which is no longer that pair (airhorn-1l04).
  stale['src/badge.js'] = stale['src/badge.js'].filter((s) => s !== 'tests/multitab.test.mjs');
  const problems = contractDrift(stale);
  assert.ok(problems.some((p) => p.startsWith('index.html:') && /sw-failover/.test(p) && /does not run it/.test(p)),
    `an over-named suite must be reported: ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => p.startsWith('src/badge.js:') && /multitab/.test(p) && /omits it/.test(p)),
    `an under-named suite must be reported: ${JSON.stringify(problems)}`);
  delete stale['server.ts'];
  assert.ok(contractDrift(stale).some((p) => p.startsWith('server.ts:') && /no entry/.test(p)),
    'a map-placed path missing from the contract must be reported');
});

test('every suite the contract names exists (airhorn-ona)', () => {
  // A stale contract naming a deleted suite would ask the oracle for evidence
  // that can never arrive - it fails closed (unmapped) but it also fails for
  // the wrong reason. The map's own reverse check never looked at this file.
  const missing = [];
  const typos = [];
  for (const [pattern, suites] of Object.entries(readContract())) {
    for (const suite of Array.isArray(suites) ? suites : [suites]) {
      if (isPendingSpelling(suite)) {
        // `test/x` is the pending-suite spelling - but only while `tests/x`
        // does not exist. Once it does, the entry is a typo that the skip
        // would hide forever: the check would pass with the real suite
        // unnamed (airhorn-n0sd).
        if (fs.existsSync(path.join(root, 'tests', suite.slice('test/'.length)))) {
          typos.push(`${pattern} -> ${suite} (tests/${suite.slice('test/'.length)} exists)`);
        }
        continue;
      }
      if (!fs.existsSync(path.join(root, suite))) missing.push(`${pattern} -> ${suite}`);
    }
  }
  assert.deepEqual(typos, [], `contract entries spell test/ for suites that exist under tests/ - fix the spelling: ${typos.join(', ')}`);
  assert.deepEqual(missing, [], `the contract names suites that are not in the tree: ${missing.join(', ')}`);
});

test('the fleet coverage contract is fresh and derived from tools/suite-map.tsv (airhorn-y7mx)', () => {
  const committed = fs.readFileSync(contractPath, 'utf8');
  const tsv = fs.readFileSync(path.join(root, 'tools', 'suite-map.tsv'), 'utf8');
  const generated = formatCoverageContract(deriveCoverageContract(tsv, { root }));
  assert.equal(committed, generated,
    'the coverage contract does not match the generated output from tools/suite-map.tsv. Run node tools/derive-coverage-contract.mjs to regenerate.');
});

test('the freshness guard BITES: a hand-edited contract fails --check (airhorn-bja9)', () => {
  // This replaces a tautology (airhorn-y7mx's test asserted that two strings which
  // differ by construction differ). A guard nobody has seen fire is a guess, so run
  // the ACTUAL guard - main(['--check']) - against a temp root: it must pass on a
  // freshly derived contract and fail, naming the fix, on one edited by hand.
  //
  // existsFn resolves mapped paths against this checkout: the temp root holds only
  // tools/suite-map.tsv and .fleet/coverage-contract.json, so without it the
  // derivation would treat every mapped source as missing and a FRESH contract
  // would report drift, which is the opposite of the thing under test.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-fresh-guard-'));
  const err = [];
  const realError = console.error;
  try {
    const tsv = fs.readFileSync(path.join(root, 'tools', 'suite-map.tsv'), 'utf8');
    const generated = formatCoverageContract(deriveCoverageContract(tsv, { root }));
    fs.mkdirSync(path.join(tempRoot, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, '.fleet'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'tools', 'suite-map.tsv'), tsv);
    for (const d of ['src', 'public', 'tests', 'test', 'docs', 'preview']) {
      const srcDir = path.join(root, d);
      const dstDir = path.join(tempRoot, d);
      if (fs.existsSync(srcDir) && !fs.existsSync(dstDir)) {
        fs.symlinkSync(srcDir, dstDir);
      }
    }
    for (const d of fs.readdirSync(path.join(root, 'tools'), { withFileTypes: true })) {
      if (d.isDirectory()) {
        fs.symlinkSync(path.join(root, 'tools', d.name), path.join(tempRoot, 'tools', d.name));
      }
    }
    for (const f of fs.readdirSync(root, { withFileTypes: true })) {
      if (!f.isDirectory() && f.name.endsWith('.md')) {
        fs.symlinkSync(path.join(root, f.name), path.join(tempRoot, f.name));
      }
    }
    const contractFile = path.join(tempRoot, '.fleet', 'coverage-contract.json');
    const opts = { root: tempRoot, existsFn: (rel) => fs.existsSync(path.join(root, rel)) };

    console.error = (...args) => { err.push(args.join(' ')); };
    try {
      fs.writeFileSync(contractFile, generated);
      assert.equal(deriveContractMain(['--check'], opts), 0,
        `a freshly derived contract must pass --check; it reported: ${err.join(' | ')}`);

      // Hand-edit exactly the way a person would: one suite renamed in the JSON.
      const handEdited = generated.replace('tests/horn.test.js', 'tests/tampered.test.js');
      assert.notEqual(handEdited, generated, 'mutation must differ');
      fs.writeFileSync(contractFile, handEdited);
      assert.equal(deriveContractMain(['--check'], opts), 1,
        'a hand-edited contract must FAIL --check - this is the guard the old test claimed to cover');
      assert.ok(err.some((line) => /out of date with tools\/suite-map\.tsv/.test(line)),
        `the guard must say what is wrong; it said: ${err.join(' | ')}`);
      assert.ok(err.some((line) => /Run "node tools\/derive-coverage-contract\.mjs" to regenerate/.test(line)),
        `the guard must name the fix; it said: ${err.join(' | ')}`);
    } finally {
      console.error = realError;
    }
  } finally {
    console.error = realError;
    fs.rmSync(tempRoot, { recursive: true, force: true });
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

test('every suite the map can select has a declared tier, so the gate can run what the map promises (airhorn-w1ow)', () => {
  // tests/acceptance.mjs was mapped to itself - the map promising "changing this file runs the
  // acceptance flow" - while tools/gate.conf SUITE_TIERS had no entry for it, so every change to
  // that file failed the gate with "no runner for tier 'undeclared'". The map is the gate, so a
  // row the gate cannot run is a false promise. Derived here from the ROWS *and the TREE*
  // (airhorn-xh81: a suite maps to itself with no row, so a row-derived check would stop seeing the
  // suites whose only row was a tautology) - never from the derived contract, which excludes self-rows
  // by design and is exactly why this went unseen - so the failure names the suites that have no tier
  // instead of relying on someone noticing.
  const gateConf = fs.readFileSync(path.join(root, 'tools', 'gate.conf'), 'utf8');
  const block = gateConf.slice(gateConf.indexOf('SUITE_TIERS="') + 'SUITE_TIERS="'.length);
  const declared = new Set(block.slice(0, block.indexOf('"')).split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => line.slice(0, line.indexOf('='))));
  const tsv = fs.readFileSync(path.join(root, 'tools', 'suite-map.tsv'), 'utf8');
  const suites = new Set();
  for (const raw of tsv.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!') || line.startsWith('~')) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const pattern = line.slice(0, tab);
    const tokens = line.slice(tab + 1).trim().split(/\s+/).filter(Boolean);
    const except = tokens.filter((tok) => tok.startsWith('except=')).map((tok) => tok.slice('except='.length));
    const selected = tokens.includes('@importers')
      ? importersOf(pattern, { root, tsvText: tsv }).filter((s) => !except.includes(s))
      : tokens;
    for (const suite of selected) suites.add(suite);
  }
  // Only suites that EXIST are in scope: a row may name a path this tree does not carry yet (a
  // '~'-pending sibling, or a row written before its file), and requiring a tier for those would fail
  // this pin for a reason that is not about what the gate promises.
  //
  // The TREE is in scope too, not just the rows (airhorn-xh81): a suite present in the tree maps to
  // itself with no row, so a suite whose only row used to be a tautology would vanish from a row-derived
  // check while still being selectable - and the gate then fails its change as 'undeclared tier'. The
  // gate's own audit (verify_suite_tiers) walks tests/*.test.* at depth 1; this walks the whole tree.
  for (const suite of suiteFiles(tsv, { root })) suites.add(suite);
  const undeclared = [...suites]
    .filter((suite) => fs.existsSync(path.join(root, suite)))
    .filter((suite) => !declared.has(suite)).sort();
  assert.deepEqual(undeclared, [],
    'every suite the map selects must be declared in tools/gate.conf SUITE_TIERS, or the gate fails that '
    + `change as 'undeclared tier' instead of running it: ${JSON.stringify(undeclared)}`);
});

test('the map carries no tautological self-row: a suite maps to itself with no row (airhorn-xh81)', () => {
  // 45 rows of the form `tests/x.test.mjs -> tests/x.test.mjs` used to carry one property: a change to a
  // suite runs the suite. The gate derives that itself (suites_for), so the rows were a tautology that
  // cost every new suite an edit on the repo's hottest file and was the single most mistyped thing in it
  // (airhorn-ahxh: `test/` instead of `tests/`, silently dropped). airhorn-xh81 deleted them and the gate
  // stopped demanding them; this pin keeps them from creeping back.
  // tests/acceptance.mjs is the ONE exception and is named here so it cannot grow silently: it is not
  // spelled *.test.*, so a row is the only thing that makes it a suite at all (airhorn-i8i, airhorn-w1ow).
  const ALLOWED_SELF_ROWS = new Map([
    ['tests/acceptance.mjs', 'not spelled *.test.*: the row is what makes it a suite at all (explicit-only, airhorn-i8i)'],
  ]);
  const map = fs.readFileSync(path.join(root, 'tools', 'suite-map.tsv'), 'utf8');
  const offenders = [];
  for (const raw of map.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const pattern = line.slice(0, tab);
    const tokens = line.slice(tab + 1).trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && tokens[0] === pattern && !ALLOWED_SELF_ROWS.has(pattern)) offenders.push(line);
  }
  assert.deepEqual(offenders, [],
    'a row naming only itself is a tautology - the gate already maps a suite to itself; delete these rows: '
    + JSON.stringify(offenders));
  // ...and the exception is still real: if acceptance.mjs ever loses its row it stops being a suite at all.
  for (const [suite, why] of ALLOWED_SELF_ROWS) {
    assert.ok(fs.existsSync(path.join(root, suite)), `${suite} is listed as a kept self-row but is gone: ${why}`);
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
  assert.ok(fs.existsSync(path.join(root, supportChange)), `selector input ${supportChange} is missing from the tree`);
  const selected = listFor(supportChange).sort();
  // The script tier is the DECLARED one (gate.conf SUITE_TIERS, airhorn-z4cn), not
  // the .mjs extension: eight .test.mjs suites are declared node-test now, and the
  // hook is injected only under the script runner. Deriving by extension drifted the
  // moment tiers were declared (airhorn-x3f1).
  const gateConf = fs.readFileSync(path.join(root, 'tools', 'gate.conf'), 'utf8');
  const scriptTier = gateConf.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('=script'))
    .map((line) => line.slice(0, -'=script'.length))
    .filter((f) => f !== 'tests/acceptance.mjs')
    .sort();
  assert.ok(scriptTier.length >= 6, `expected the script-tier suites to be present, got ${JSON.stringify(scriptTier)}`);
  // EXACT set, not subset (airhorn-cae): over-naming matters as much as
  // under-naming - tests/acceptance.mjs in this row would put a full
  // browser acceptance pass on every support change, and subset-only
  // checking would call that correct.
  assert.deepEqual(selected, scriptTier,
    `the support row must select exactly the script-tier suites:\n  row: ${JSON.stringify(selected)}\n  expected: ${JSON.stringify(scriptTier)}`);
});

test('a shared helper\'s selection is DERIVED from the tree, not hand-listed (airhorn-ooqm)', () => {
  // The first attempt at this bead hand-edited the row and then asserted it with a regex that only
  // understood `from '...'`/`require('...')`. It therefore missed the COMPUTED reference
  // (tests/test-support.test.js: path.join(import.meta.dirname, 'cdp-command-bound.mjs')) and the
  // DYNAMIC one (tests/horn.test.js: await import('./support/browser.mjs')), and because it only
  // asserted "every importer I found is selected" it would have stayed green even if the row had lost
  // suites - a false green inside the fix for false greens. What is pinned now:
  //   1. the scan itself, on fixtures in each import SHAPE (static, require, dynamic, template,
  //      computed path.join) and on a prose mention that must NOT count;
  //   2. the TRUE reference count in this tree, by name of the suites (15 for cdp-command-bound.mjs - the 13th is tests/csp-boot.test.mjs, added by airhorn-yxxq, the 15th is tests/csp-enforced.test.mjs, added by airhorn-xnd1);
  //   3. the gate's selection for that module == that set minus the explicit-only acceptance pass
  //      (14), as EXACT set equality - over- and under-selection both fail;
  //   4. the row is an `@importers` row, so re-hand-listing it fails here;
  //   5. the derived contract restates the same set, so the fleet oracle cannot drift from the gate.
  const tsv = fs.readFileSync(path.join(root, 'tools', 'suite-map.tsv'), 'utf8');
  const helper = 'tests/cdp-command-bound.mjs';
  const EXPLICIT_ONLY = ['tests/acceptance.mjs'];

  // 1. the scan is import-shape-agnostic. A fixture tree, not this repo, so the shapes are deliberate.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'importers-'));
  try {
    fs.mkdirSync(path.join(fixture, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'tests', 'helper.mjs'), 'export const x = 1;\n');
    const shapes = {
      'tests/static.test.mjs': "import { x } from './helper.mjs';\n",
      'tests/require.test.js': "const { x } = require('./helper.mjs');\n",
      'tests/dynamic.test.mjs': "const { x } = await import('./helper.mjs');\n",
      'tests/dynamictpl.test.mjs': 'const { x } = await import(`./helper.mjs`);\n',
      'tests/computed.test.js': "const h = await import(pathToFileURL(path.join(import.meta.dirname, 'helper.mjs')).href);\n",
      // NOT dependencies, and each one is a shape that would fool a looser scan:
      'tests/prose.test.mjs': "// this suite never imports helper.mjs (see path.join(dir, 'helper.mjs'))\nimport assert from 'node:assert/strict';\nassert.ok(true);\n",
      'tests/naming.test.mjs': "const row = 'helper.mjs';\nconst label = \"helper.mjs is the bounded CDP helper\";\n",
    };
    for (const [rel, body] of Object.entries(shapes)) fs.writeFileSync(path.join(fixture, rel), body);
    const fixtureMap = ['tests/helper.mjs\t@importers', ...Object.keys(shapes).map((r) => `${r}\t${r}`), ''].join('\n');
    const found = importersOf('tests/helper.mjs', { root: fixture, tsvText: fixtureMap });
    for (const rel of ['tests/static.test.mjs', 'tests/require.test.js', 'tests/dynamic.test.mjs', 'tests/dynamictpl.test.mjs', 'tests/computed.test.js']) {
      assert.ok(found.includes(rel), `the scan must see the ${path.basename(rel)} import shape, got ${JSON.stringify(found)}`);
    }
    assert.ok(!found.includes('tests/prose.test.mjs'), `a comment that spells a resolution is not a dependency, got ${JSON.stringify(found)}`);
    assert.ok(!found.includes('tests/naming.test.mjs'), `naming the file without resolving it is not a dependency, got ${JSON.stringify(found)}`);
    assert.equal(found.length, 5, `exactly the five resolution shapes must be found, got ${JSON.stringify(found)}`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }

  // 2. the true reference count in THIS tree, spelled out: losing a caller from the row must fail.
  const all = importersOf(helper, { root, tsvText: tsv });
  assert.equal(all.length, 15, `every suite that references ${helper} must be found, got ${JSON.stringify(all, null, 2)}`);
  assert.ok(all.includes('tests/test-support.test.js'),
    'the computed path.join reference in tests/test-support.test.js must count - it is the one the old regex missed');
  assert.ok(!all.includes('tests/horn.test.js'), 'tests/horn.test.js references the browser helper, not this one');
  const expected = all.filter((s) => !EXPLICIT_ONLY.includes(s));
  assert.equal(expected.length, 14, `14 suites minus the explicit-only acceptance pass must remain, got ${JSON.stringify(expected)}`);

  // 3. what the REAL gate does, as exact set equality.
  const selected = listFor(helper);
  assert.deepEqual(selected, expected,
    `the gate must select exactly the referencing suites (acceptance excepted):\n  selected: ${JSON.stringify(selected)}\n  expected: ${JSON.stringify(expected)}`);

  // 4. the row is the derivation, not a list: a hand-edit back to names fails here.
  const row = tsv.split('\n').find((line) => line.split('\t')[0] === helper);
  assert.ok(row, `${helper} must have a map row`);
  assert.ok(row.split('\t').slice(1).join(' ').includes('@importers'),
    `the row must stay an @importers row, not a list that goes stale: ${row}`);
  assert.equal(row.split('\t').slice(1).join(' ').split(/\s+/).filter((t) => t === 'except=tests/acceptance.mjs').length, 1,
    `the acceptance exception must stay explicit and singular: ${row}`);

  // 5. the derived contract restates the same set.
  const contractEntry = deriveCoverageContract(tsv, { root })[helper];
  assert.deepEqual(contractEntry, expected,
    `.fleet/coverage-contract.json must restate the derived set for ${helper}: ${JSON.stringify(contractEntry)}`);
});
test('the render model: shown IS visible text; a skipped node contributes nothing (airhorn-0w9, -cpi, -9py, -s52)', () => {
  const model = makeRenderModel();
  const base = { boxChain: true, visibility: 'visible', opacity: 1 };
  const el = (facts = {}, ownText = '', elements = [], shadow = null) => ({
    facts: { type: 'element', display: 'block', contentVisibility: 'visible', ...base, ...facts },
    ownText, elements, shadow,
  });
  const shadowRoot = (...elements) => ({ facts: { type: 'shadow' }, ownText: '', elements, shadow: null });
  const cases = [
    { name: 'a plain visible region', tree: el({}, 'plain visible status'), text: 'plain visible status' },
    // Chrome: a c-v:hidden element reports checkVisibility TRUE and innerText
    // '' - the skip is invisible to checkVisibility, so innerText is the
    // evidence. Its subtree is pruned whole.
    { name: 'its own content-visibility:hidden', tree: el({ contentVisibility: 'hidden', hasTextContent: true, renderedText: '' }, 'alpha', [el({}, 'kid')]), text: '' },
    { name: 'its own content-visibility:auto, skipped off-screen', tree: el({ contentVisibility: 'auto', hasTextContent: true, renderedText: '' }, 'auto skipped status'), text: '' },
    { name: 'its own content-visibility:auto, rendered', tree: el({ contentVisibility: 'auto', hasTextContent: true, renderedText: 'auto visible' }, 'auto visible'), text: 'auto visible' },
    { name: 'a skipped element inside a rendered region', tree: el({}, '', [el({ contentVisibility: 'hidden', hasTextContent: true, renderedText: '' }, 'invisible kid')]), text: '' },
    // A display:contents element has no box, so it is decided by its own
    // computed visibility/opacity plus the box chain of its nearest boxed
    // ancestor - Chrome reports no box chain for a contents element even while
    // it is plainly painted. Without that, its own text read shown:true from
    // visibility:hidden, opacity:0 and display:none (airhorn-s52).
    { name: 'display:contents region with its own text', tree: el({ display: 'contents' }, 'contents region text'), text: 'contents region text' },
    { name: 'display:contents region with its own text, visibility:hidden', tree: el({ display: 'contents', visibility: 'hidden' }, 'hidden contents own text'), text: '' },
    { name: 'display:contents region with its own text, opacity:0', tree: el({ display: 'contents', opacity: 0 }, 'contents opacity zero'), text: '' },
    { name: 'display:contents region with its own text under a display:none ancestor', tree: el({ display: 'contents', boxChain: false }, 'contents own text under display none'), text: '' },
    { name: 'display:contents region with a visibility:visible override under a hidden ancestor', tree: el({ display: 'contents' }, 'contents visible override'), text: 'contents visible override' },
    { name: 'display:contents region with text in a visible child', tree: el({ display: 'contents' }, '', [el({}, 'contents visible child')]), text: 'contents visible child' },
    { name: 'display:contents region whose only child is unrendered', tree: el({ display: 'contents' }, '', [el({ boxChain: false }, 'gone')]), text: '' },
    // THE od1 MIRROR (airhorn-s52): a visibility:hidden element still has a
    // box, so its subtree must NOT be pruned - a visibility:visible descendant
    // is painted and its text belongs in the walk. Only the hidden element's
    // OWN text is dropped.
    { name: 'a hidden element with a visible descendant', tree: el({ visibility: 'hidden' }, 'hidden own text', [el({}, 'kept child text')]), text: 'kept child text' },
    // MEASURED browser facts (airhorn-9bki, the collapse probe on the bead): a collapsed table
    // row's own text is NOT painted (innerText omits it, box height 0), but a visibility:visible
    // descendant inside it IS painted (a real rect; innerText carries its text). So collapse is
    // 'own', not 'none': own text dropped, subtree walked. The nxuv27 branch's whole-subtree
    // prune was the wrong direction.
    { name: 'a collapsed row: own text is not painted', tree: el({ visibility: 'collapse' }, 'collapsed row text'), text: '' },
    { name: 'a collapsed row with a visibility:visible descendant: the override is painted', tree: el({ visibility: 'collapse' }, 'collapsed own text', [el({}, 'override span text')]), text: 'override span text' },
    { name: 'a region inside a display:none ancestor', tree: el({ boxChain: false }, 'hidden ancestor status'), text: '' },
    { name: 'a visibility:visible region inside a visibility:hidden ancestor', tree: el({}, 'visible override region'), text: 'visible override region' },
    { name: 'an opacity:0 region', tree: el({ boxChain: false, opacity: 0 }, 'echo opacity zero'), text: '' },
    { name: 'a region in closed <details>', tree: el({ boxChain: false }, 'closed details alert'), text: '' },
    { name: 'a message only in an open shadow root', tree: el({}, '', [], shadowRoot(el({}, 'shadow alert text'))), text: 'shadow alert text' },
    { name: 'a message in a nested shadow root', tree: el({}, '', [el({}, '', [], shadowRoot(el({}, 'nested shadow text')))]), text: 'nested shadow text' },
  ];
  for (const c of cases) {
    const adapt = (n) => n; // the fixture nodes already have the adapter's shape
    const text = model.renderedText(c.tree, adapt);
    assert.equal(text, c.text, `${c.name}: expected ${JSON.stringify(c.text)}, got ${JSON.stringify(text)}`);
    // One decision (airhorn-0w9): 'shown' is not a second answer that can
    // disagree with the text it reports.
    assert.equal(model.isShown(c.tree, adapt), text !== '',
      `${c.name}: shown must BE "has visible text" - a second visibility path is the bug`);
  }
});

// The instrument the audit actually runs - READ_STATE, the page code - driven
// here against a fake DOM (airhorn-0w9, -cpi, -9py, -s52). The model test
// pins the decisions; this pins the ADAPTER, the only bridge between them and
// browser facts. A dropped `contentVisibility` or a misspelled fact here would
// restore a verdict bug in the browser with every other test green, and would
// have been invisible: nothing used to test READ_STATE at all.

test('the page instrument turns DOM facts into the model verdict (airhorn-0w9, -cpi, -9py, -s52)', () => {
  const descendants = (node) => node.children.flatMap((c) => [c, ...descendants(c)]);
  const wire = (node) => {
    node.querySelectorAll = (sel) => descendants(node).filter((d) => (sel === '*' ? true : !!d.role));
    return node;
  };
  const textOf = (node) => [node.ownText, ...node.children.map(textOf)].filter(Boolean).join(' ');
  const mk = (facts = {}, ownText = '', children = [], extra = {}) => {
    const node = {
      nodeType: 1, facts, children, shadowRoot: extra.shadow || null, role: extra.role || null,
      childNodes: ownText ? [{ nodeType: 3, textContent: ownText }] : [],
    };
    node.ownText = ownText;
    node.textContent = textOf(node);
    for (const c of children) c.parentElement = node;
    // Chrome 155 facts: the box chain (asked without visibilityProperty) is
    // FALSE for display:none, opacity:0, closed <details> and c-v skips and
    // for any descendant of them, but TRUE for a visibility:hidden element -
    // its visibility is a separate fact, so its visible descendants survive.
    node.checkVisibility = (opts) => (facts.boxChain !== false);
    Object.defineProperty(node, 'innerText', { get: () => (facts.renderedText !== undefined ? facts.renderedText : node.textContent) });
    node.getAttribute = (k) => (k === 'role' ? node.role : null);
    return wire(node);
  };
  const shadowOf = (host, ...children) => wire({ nodeType: 11, host, children, shadowRoot: null, childNodes: [] });
  const styleOf = (n) => ({
    display: n.facts ? n.facts.display || 'block' : 'block',
    contentVisibility: n.facts ? n.facts.contentVisibility || 'visible' : 'visible',
    visibility: n.facts && n.facts.visibility ? n.facts.visibility : 'visible',
    opacity: n.facts && n.facts.opacity !== undefined ? String(n.facts.opacity) : '1',
  });
  const instrument = (regions, extraBody = []) => {
    const body = mk({}, '', [...extraBody, ...regions]);
    const document = wire({ nodeType: 9, children: [body], shadowRoot: null, childNodes: [], querySelector: () => null, title: 'fixture', readyState: 'complete' });
    // Inject the real page code with the browser globals it reads.
    const run = new Function('document', 'getComputedStyle', 'performance', 'navigator', 'location', 'window',
      `return ${READ_STATE}`);
    return run(document, styleOf, { getEntriesByType: () => [] }, { onLine: true }, { href: 'about:blank' }, {});
  };
  const plain = mk({}, 'plain visible status', [], { role: 'status' });
  const skippedAuto = mk({ contentVisibility: 'auto', renderedText: '' }, 'auto skipped status', [], { role: 'status' });
  const contents = mk({ display: 'contents' }, 'contents region text', [], { role: 'status' });
  const contentsHidden = mk({ display: 'contents', visibility: 'hidden' }, 'hidden contents own text', [], { role: 'status' });
  const host = mk({}, '', [], { role: 'status' });
  host.shadowRoot = shadowOf(host, mk({}, 'shadow alert text'));
  // A visibility:hidden wrapper with a visible status region inside it: the
  // wrapper's own text must not count, the region inside must (airhorn-s52).
  const wrapper = mk({ visibility: 'hidden' }, 'hidden wrapper text', [mk({}, 'kept region text', [], { role: 'status' })]);
  const state = instrument([plain, skippedAuto, contents, contentsHidden, host], [wrapper]);
  // DOM order: the wrapper's region comes first.
  assert.deepEqual(state.live.map((l) => l.shown), [true, true, false, true, false, true],
    `shown must follow visible text: ${JSON.stringify(state.live)}`);
  assert.deepEqual(state.live.map((l) => l.text),
    ['kept region text', 'plain visible status', '', 'contents region text', '', 'shadow alert text'],
    `text must be the rendered text only: ${JSON.stringify(state.live)}`);
  for (const l of state.live) {
    assert.equal(l.shown, l.text !== '', `shown must BE "has visible text": ${JSON.stringify(l)}`);
  }
  // The body read is the same instrument: skipped text is not in it (it used
  // to be, and earned 'explains itself' for nothing), and a visibility
  // override below a hidden wrapper is not lost (airhorn-s52).
  assert.ok(!state.bodyText.includes('auto skipped status'), `bodyText leaked skipped text: ${state.bodyText}`);
  assert.ok(!state.bodyText.includes('hidden wrapper text'), `bodyText leaked hidden own text: ${state.bodyText}`);
  assert.ok(state.bodyText.includes('contents region text'), `bodyText lost rendered text: ${state.bodyText}`);
  assert.ok(state.bodyText.includes('kept region text'), `bodyText lost a visibility override: ${state.bodyText}`);
});

// The import-purity lint lives in tests/gate-conf-merge.test.js, NOT here: this file imports
// tools/render-model.mjs and tools/derive-coverage-contract.mjs, and a scan host that imports
// its targets can be exited at import time by the very defect it polices (observed live: a
// probe that removed derive-coverage-contract's guard ran main() at import and the harness
// counted the early exit(0) as a green run - the fc98 mechanism masking itself).


/* airhorn-m85h: the map's prose lives in docs/coverage-map.md and each non-obvious row
 * points at its section. A pointer whose section is gone (renamed heading, deleted
 * section) is a dead reference - a reader follows it into a wall. Pin the link. */
test('every coverage-map pointer in suite-map.tsv resolves to a section in the doc (airhorn-m85h)', () => {
  const map = fs.readFileSync(path.join(root, 'tools', 'suite-map.tsv'), 'utf8');
  const doc = fs.readFileSync(path.join(root, 'docs', 'coverage-map.md'), 'utf8');
  // The check lives in the derive tool (airhorn-1pdt) so the fast gate's unconditional
  // preflight and this pin share ONE implementation.
  // The sanity must count POINTER-SHAPED lines, not any '# why:' comment (airhorn-8yaj):
  // a map that lost the docs/coverage-map.md# shape would otherwise pass vacuously.
  const pointers = [...map.matchAll(/^# why: docs\/coverage-map\.md#([a-z0-9-]+)$/gm)].map((m) => m[1]);
  assert.ok(pointers.length > 10, 'the map must carry the pointers (sanity: the move happened)');
  const dead = checkCoverageMapPointers(map, doc);
  assert.deepEqual(dead, [], 'every pointer must resolve to a doc section; dead: ' + dead.join(', '));
});
