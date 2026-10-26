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
import { main as deriveContractMain, deriveCoverageContract, formatCoverageContract, deriveMapOpinion, extractPendingSuites, isPendingSuite } from '../tools/derive-coverage-contract.mjs';

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

  // And the concerns that share a signal are not accidentally duplicated: the
  // structural suite is the only thing every module row has in common.
  for (const m of ['src/input.js', 'src/badge.js', 'src/launch.js', 'src/install.js', 'src/status.js', 'src/analytics.js']) {
    assert.ok(selectorsFor(m).includes('tests/modules.test.js'), `${m} must be pinned by the structural suite`);
  }
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
  // (b) the coverage it must not have lost with it: the lost-upgrade
  // announcement is authored in index.html, and the suite that runs on this row
  // has to assert that copy. Read both files: the page's copy and the suite's
  // assertion cannot silently diverge into a suite that checks nothing real.
  const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const suite = fs.readFileSync(path.join(root, 'tests', 'resilience-ui.test.mjs'), 'utf8');
  for (const copy of ['The app could not update', 'previous version']) {
    assert.ok(page.includes(copy), `index.html must author the lost-upgrade copy "${copy}"`);
    assert.ok(suite.includes(copy), `resilience-ui must assert the page's lost-upgrade copy "${copy}"`);
  }
  // The worker's own failure story is still the failover suite's job, and the
  // suite still has a row owner (the worker). No page module carries worker code
  // since the split (airhorn-1l04): the registration handler is inline in
  // index.html, which is why the page row above carries the copy assertions.
  assert.ok(listFor('public/sw.js').includes('tests/sw-failover.test.mjs'),
    'public/sw.js must still select the failover suite');
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
