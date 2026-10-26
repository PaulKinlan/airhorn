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
  const input = 'src/main.js';
  assert.ok(fs.existsSync(path.join(root, input)), `selector input ${input} is missing from the tree`);
  const suites = listFor(input);
  for (const s of ['tests/a11y.test.mjs', 'tests/webmcp-browser.test.mjs', 'tests/resilience-ui.test.mjs']) {
    assert.ok(suites.includes(s), `src/main.js must select ${s}, got ${JSON.stringify(suites)}`);
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
  // The worker's own upgrade story is still the failover suite's job.
  assert.ok(listFor('src/main.js').includes('tests/sw-failover.test.mjs'),
    'src/main.js must still select the failover suite');
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
  stale['src/main.js'] = stale['src/main.js'].filter((s) => s !== 'tests/sw-failover.test.mjs');
  const problems = contractDrift(stale);
  assert.ok(problems.some((p) => p.startsWith('index.html:') && /sw-failover/.test(p) && /does not run it/.test(p)),
    `an over-named suite must be reported: ${JSON.stringify(problems)}`);
  assert.ok(problems.some((p) => p.startsWith('src/main.js:') && /sw-failover/.test(p) && /omits it/.test(p)),
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

test('a change that selects ZERO suites fails loudly, green only by explicit acknowledgement (airhorn-n0jd)', () => {
  // CONTRIBUTING.md matches the !*.md exemption row: no suite covers it. (README.md
  // used to be the example; it now selects tests/docs-recipe.test.mjs because its
  // Deno recipe is documented behaviour - airhorn-x86p.) That used
  // to exit 0 with a bare 'PASS (0 suite(s))' - so an over-broad `!` row (or a
  // map edit exempting real source) could green a change that ran nothing.
  // Now the verdict is FAIL unless the caller names the acknowledgement; the
  // --list query keeps its exit-0 semantics (it is not a verdict).
  const exemptOnly = 'CONTRIBUTING.md';
  assert.ok(fs.existsSync(path.join(root, exemptOnly)), `selector input ${exemptOnly} is missing from the tree`);
  const run = (args, env = {}) => spawnSync('bash', [gate, ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
  });
  const loud = run(['--changed', exemptOnly]);
  assert.equal(loud.status, 1, `an exempt-only change must not read green: ${loud.stdout}`);
  assert.ok(loud.stdout.includes(`fast-gate: zero-suite: ${exemptOnly} (exempt)`),
    `the exempt file must be named with its reason: ${loud.stdout}`);
  assert.ok(loud.stderr.includes('FAST_GATE_ALLOW_ZERO'),
    `the failure must name the acknowledgement: ${loud.stderr}`);
  const blessed = run(['--changed', exemptOnly], { FAST_GATE_ALLOW_ZERO: '1' });
  assert.equal(blessed.status, 0, `the explicit acknowledgement must pass: ${blessed.stderr}`);
  assert.ok(blessed.stdout.includes('ZERO-SUITE PASS'),
    `the pass must be labelled, not a bare PASS: ${blessed.stdout}`);
  const query = run(['--changed', exemptOnly, '--list']);
  assert.equal(query.status, 0, `--list is a query, not a verdict: ${query.stderr}`);
});

// Builds a throwaway repo around a copy of the REAL gate script: the gate resolves its map
// relative to its own location, so this exercises the real selection/verdict code end to end.
// The map names one landed suite (tests/pass.test.js) and one '~'-pending suite
// (tests/pending.test.js), with a source shape for each outcome under test. Caller cleans up.
const buildGateProbe = () => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-contract-'));
  const toolsDir = path.join(probe, 'tools');
  fs.mkdirSync(toolsDir);
  fs.mkdirSync(path.join(probe, 'tests'));
  fs.copyFileSync(gate, path.join(toolsDir, 'fast-gate.sh'));
  // The runner config is part of the gate: without its pinned TAP reporter the probe's
  // node --test would emit the spec summary and the gate would read the suite as silent.
  fs.copyFileSync(path.join(root, 'tools', 'gate.conf'), path.join(toolsDir, 'gate.conf'));
  fs.copyFileSync(path.join(root, 'tools', 'derive-coverage-contract.mjs'), path.join(toolsDir, 'derive-coverage-contract.mjs'));
  fs.writeFileSync(path.join(probe, 'package.json'),
    JSON.stringify({ name: 'gate-contract-probe', private: true, scripts: { build: 'true' } }));
  fs.writeFileSync(path.join(probe, 'tests', 'pass.test.js'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('one passing case', () => { assert.ok(true); });\n");
  fs.mkdirSync(path.join(probe, 'src'), { recursive: true });
  fs.writeFileSync(path.join(probe, 'src', 'a.js'), '// a');
  fs.writeFileSync(path.join(probe, 'pending-src.txt'), 'pending');
  fs.writeFileSync(path.join(probe, 'mixed-src.js'), '// mixed');
  fs.writeFileSync(path.join(probe, 'README.md'), '# probe');
  fs.writeFileSync(path.join(toolsDir, 'suite-map.tsv'), [
    'src/a.js\ttests/pass.test.js',
    'pending-src.txt\ttests/pending.test.js',
    'mixed-src.js\ttests/pass.test.js tests/pending.test.js',
    'tests/pass.test.js\ttests/pass.test.js',
    '~tests/pending.test.js\ttests/pending.test.js',
    '!*.md',
    '',
  ].join('\n'));
  for (const args of [['init'], ['config', 'user.email', 'probe@example.invalid'], ['config', 'user.name', 'probe'], ['add', '-A'], ['commit', '-m', 'probe']]) {
    const g = spawnSync('git', ['-C', probe, ...args], { encoding: 'utf8' });
    assert.equal(g.status, 0, `probe git ${args[0]} failed: ${g.stderr}`);
  }
  // Strip ambient gate knobs AND the test harness's own markers: node --test sets
  // NODE_TEST_CONTEXT in this process, and a grandchild suite that inherits it believes it
  // is a managed test child, writes nothing and exits 0 (the same silent green the
  // airhorn-0ct pin strips before its own child runs) - so the gate would read a passing
  // suite as silent. Production never runs the gate under these, so the probe must not.
  const cleanEnv = {};
  for (const k of Object.keys(process.env)) {
    if (!k.startsWith('FAST_GATE_') && !k.startsWith('AIRHORN_') && !k.startsWith('NODE_TEST_')) cleanEnv[k] = process.env[k];
  }
  return {
    probe,
    run: (args, env = {}) => spawnSync('bash', [path.join(toolsDir, 'fast-gate.sh'), ...args], {
      cwd: probe, encoding: 'utf8', env: { ...cleanEnv, ...env },
    }),
  };
};

test('the fleet contract recognises every rc-0 verdict line the gate emits (airhorn-3dph)', () => {
  // tools/check.conf is the CONTRACT the coord installs as ~/.fleet/check.conf: it tells
  // fleet-check which gate lines certify a pass. When the gate's verdict lines drift from it,
  // the declared contract silently downgrades blessed passes: airhorn-3dph shipped a
  // ZERO-SUITE PASS line that matched NEITHER contract regex, so the opt-in pass would have
  // read UNKNOWN at the first install that names a contract owner. This pin runs the REAL
  // gate in a throwaway repo, captures one instance of every rc-0 verdict line it can emit,
  // and requires the contract to classify each one - and to classify nothing an rc-1 run prints.
  const conf = spawnSync('bash', [
    '-c', 'source "$1"; printf "%s\\n%s\\n%s\\n%s\\n" "$CHECK_FAST_PASS_RE" "$CHECK_FAST_NO_WORK_RE" "${CHECK_FAST_NO_WORK_POLICY-UNSET}" "${CHECK_FAST_CONTRACT_OWNER-}"',
    'check.conf', path.join(root, 'tools', 'check.conf'),
  ], { encoding: 'utf8' });
  assert.equal(conf.status, 0, `check.conf must source cleanly: ${conf.stderr}`);
  const [passReStr, noWorkReStr, noWorkPolicy, contractOwner] = conf.stdout.split('\n');
  assert.notEqual(contractOwner, '',
    'the contract must name CHECK_FAST_CONTRACT_OWNER: fleet-check UNSETS an ownerless declaration, which is how the airhorn-3dph drift stayed invisible');
  assert.equal(noWorkPolicy, 'pass',
    'the no-work lines must certify (no-work-exempt passes): an unset policy reads them as UNKNOWN');
  for (const [name, re] of [['CHECK_FAST_PASS_RE', passReStr], ['CHECK_FAST_NO_WORK_RE', noWorkReStr]]) {
    assert.ok(re.startsWith('^'), `${name} must be line-anchored: producer-verdict.py refuses unanchored patterns`);
    assert.ok(re.endsWith('$'), `${name} must match whole lines: the dead prefix alternative that hid airhorn-3dph matched by loose prefix`);
  }
  let passRe, noWorkRe;
  try {
    passRe = new RegExp(passReStr);
    noWorkRe = new RegExp(noWorkReStr);
  } catch (err) {
    assert.fail(`contract patterns must be valid regexes: ${err.message}`);
  }

  const { probe, run } = buildGateProbe();
  try {
    const noChanged = run([]);                                       // nothing changed at all
    const positive = run(['--changed', 'src/a.js']);                 // one real suite runs
    const blessedExempt = run(['--changed', 'exempt.md'], { FAST_GATE_ALLOW_ZERO: '1' });
    const blessedPending = run(['--changed', 'pending-src.txt'], { FAST_GATE_ALLOW_ZERO: '1' });
    const refused = run(['--changed', 'exempt.md']);                 // rc 1: zero-suite without the bless
    const deletedSuite = run(['--changed', 'tests/gone.test.js']);   // rc 1: a deleted suite selects nothing (airhorn-wiq9)
    const blessedDeleted = run(['--changed', 'tests/gone.test.js'], { FAST_GATE_ALLOW_ZERO: '1' }); // rc 0: the same bless, deleted-suite composition
    const allPending = run(['--changed', 'pending-src.txt']);        // rc 1: every selected suite '~'-pending (airhorn-dn7d)
    const unmapped = run(['--changed', 'unmapped.txt']);             // rc 1: no row, no exemption
    for (const [name, r] of [['no-changed', noChanged], ['positive', positive], ['blessed-exempt', blessedExempt], ['blessed-pending', blessedPending]]) {
      assert.equal(r.status, 0, `${name} must exit 0:\n${r.stdout}\n${r.stderr}`);
    }
    assert.equal(refused.status, 1, `zero-suite without the acknowledgement must exit 1: ${refused.stdout}`);
    assert.equal(deletedSuite.status, 1, `a deleted-suite-only change without the acknowledgement must exit 1: ${deletedSuite.stdout}`);
    assert.ok(deletedSuite.stdout.includes('fast-gate: zero-suite: tests/gone.test.js (deleted suite; selects nothing by design)'),
      `the deleted suite must be named with its reason: ${deletedSuite.stdout}`);
    assert.ok(deletedSuite.stderr.includes('every one is exempt or a'),
      `the failure must not blame a non-existent exemption row (airhorn-wiq9): ${deletedSuite.stderr}`);
    assert.equal(blessedDeleted.status, 0, `the explicit acknowledgement must pass for a deleted suite too: ${blessedDeleted.stderr}`);
    assert.equal(allPending.status, 1, `an all-pending change without the acknowledgement must exit 1: ${allPending.stdout}`);
    assert.equal(unmapped.status, 1, `an unmapped change must exit 1: ${unmapped.stdout}`);

    // The exact rc-0 verdict lines, pinned so a reformat of any one of them fails HERE, by name.
    const noChangedLine = 'fast-gate: no changed files';
    const positiveLine = 'fast-gate: PASS (1 suite(s), 1 changed file(s))';
    const blessedExemptLine = 'fast-gate: ZERO-SUITE PASS (1 changed file(s), all 1 exempt; FAST_GATE_ALLOW_ZERO=1)';
    const blessedPendingLine = 'fast-gate: ZERO-SUITE PASS (1 changed file(s), all 1 pending; FAST_GATE_ALLOW_ZERO=1)';
    const blessedDeletedLine = 'fast-gate: ZERO-SUITE PASS (1 changed file(s): 0 exempt, 1 deleted-suite; FAST_GATE_ALLOW_ZERO=1)';
    for (const [name, r, line] of [['no-changed', noChanged, noChangedLine], ['positive', positive, positiveLine], ['blessed-exempt', blessedExempt, blessedExemptLine], ['blessed-pending', blessedPending, blessedPendingLine], ['blessed-deleted', blessedDeleted, blessedDeletedLine]]) {
      assert.ok(r.stdout.includes(line), `${name} must print the pinned verdict line ${line}, got:\n${r.stdout}`);
    }
    // The classification is the contract: exactly one regex owns each rc-0 line.
    assert.match(positiveLine, passRe, 'a >=1-suite PASS must certify via CHECK_FAST_PASS_RE');
    assert.doesNotMatch(positiveLine, noWorkRe, 'a suite-running PASS must not classify as no-work');
    for (const line of [noChangedLine, blessedExemptLine, blessedPendingLine, blessedDeletedLine]) {
      assert.match(line, noWorkRe, `a zero-execution rc-0 line must certify via CHECK_FAST_NO_WORK_RE: ${line}`);
      assert.doesNotMatch(line, passRe, `a zero-execution rc-0 line must not read as a suite-running PASS: ${line}`);
    }
    // ...and nothing an rc-1 run prints may classify, in either direction.
    const rc1Lines = [refused, deletedSuite, allPending, unmapped]
      .flatMap((r) => [...r.stdout.split('\n'), ...r.stderr.split('\n')])
      .filter((l) => l.startsWith('fast-gate: '));
    assert.ok(rc1Lines.length >= 6, `the rc-1 runs must have produced contract-visible lines: ${rc1Lines}`);
    for (const line of rc1Lines) {
      assert.doesNotMatch(line, passRe, `an rc-1 line must never read as PASS: ${line}`);
      assert.doesNotMatch(line, noWorkRe, `an rc-1 line must never read as no-work: ${line}`);
    }
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
});

test("an all-'~'-pending change fails loudly: zero executed suites is not green (airhorn-dn7d)", () => {
  // The door airhorn-n0jd closed for '!' rows, still open through '~' rows: a source row
  // naming ONLY a pending suite selected it, skipped it, printed 'PASS (0 suite(s), all
  // pending)' and exited 0 - so a '~' row that never lands (a forgotten sibling branch)
  // keeps every change to its source permanently green with nothing run. Same rule as n0jd:
  // FAIL by default, green only under the explicit FAST_GATE_ALLOW_ZERO acknowledgement,
  // and only with a labelled line - never a bare PASS.
  const { probe, run } = buildGateProbe();
  try {
    const loud = run(['--changed', 'pending-src.txt']);
    assert.equal(loud.status, 1, `a change whose selected suites are all pending must not read green: ${loud.stdout}`);
    assert.ok(loud.stdout.includes('fast-gate: pending: tests/pending.test.js'),
      `the pending suite must be named on stdout: ${loud.stdout}`);
    assert.ok(loud.stderr.includes("all '~'-pending"), `the failure must say why: ${loud.stderr}`);
    assert.ok(loud.stderr.includes('0 suite(s) executed'), `the failure must state the invariant: ${loud.stderr}`);
    assert.ok(loud.stderr.includes('FAST_GATE_ALLOW_ZERO'), `the failure must name the acknowledgement: ${loud.stderr}`);
    const blessed = run(['--changed', 'pending-src.txt'], { FAST_GATE_ALLOW_ZERO: '1' });
    assert.equal(blessed.status, 0, `the explicit acknowledgement must pass: ${blessed.stderr}`);
    assert.ok(blessed.stdout.includes('ZERO-SUITE PASS (1 changed file(s), all 1 pending; FAST_GATE_ALLOW_ZERO=1)'),
      `the pass must be labelled, not a bare PASS: ${blessed.stdout}`);
    // A MIXED selection is untouched: the landed suite still runs, the pending one stays loud.
    const mixed = run(['--changed', 'mixed-src.js']);
    assert.equal(mixed.status, 0, `a change with a landed suite among pending ones must still run it: ${mixed.stderr}`);
    assert.ok(mixed.stdout.includes('fast-gate: pending: tests/pending.test.js'),
      `the pending suite must stay loud: ${mixed.stdout}`);
    assert.ok(mixed.stdout.includes('fast-gate: PASS (1 suite(s), 1 changed file(s))'),
      `the landed suite must run and be the count: ${mixed.stdout}`);
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
});

test('map honesty in fast-gate rejects a literal missing path even with --list (airhorn-onz0)', () => {
  // Round-2 review finding: a literal mapped path that does not exist on disk
  // must fail map honesty even when querying with --list (which bypasses suite execution).
  const { probe, run } = buildGateProbe();
  try {
    fs.appendFileSync(path.join(probe, 'tools', 'suite-map.tsv'), 'src/does-not-exist.js\ttests/pass.test.js\n');
    const res = run(['--list']);
    assert.equal(res.status, 1, `a literal missing path must fail map honesty with rc 1: ${res.stdout}`);
    assert.ok(
      res.stderr.includes('src/does-not-exist.js'),
      `expected stderr to name src/does-not-exist.js, got:\n${res.stderr}`
    );
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
});

test('every tools script parses - recognised extensions at any depth (airhorn-7lm, airhorn-7z5, airhorn-h19)', () => {
  // Glob, not names (airhorn-v1n), and every RECOGNISED script extension,
  // not just .mjs (airhorn-h19: .cjs and .ts were unparseable, extensionless
  // files invisible). A tools file with no parser is a failure, not a skip:
  // teach the checker or list the extension as data here.
  const PARSERS = {
    '.mjs': (f) => esbuild.transformSync(fs.readFileSync(f, 'utf8'), { loader: 'js', sourcefile: f }),
    '.js': (f) => esbuild.transformSync(fs.readFileSync(f, 'utf8'), { loader: 'js', sourcefile: f }),
    '.cjs': (f) => esbuild.transformSync(fs.readFileSync(f, 'utf8'), { loader: 'js', sourcefile: f }),
    '.ts': (f) => esbuild.transformSync(fs.readFileSync(f, 'utf8'), { loader: 'ts', sourcefile: f }),
    '.sh': (f) => execFileSync('bash', ['-n', f]),
  };
  const DATA_EXTS = new Set(['.conf', '.tsv', '.json', '.md', '.txt']);
  const toolsDir = (guardActive() && process.env.GSM_TOOLS_ROOT) ? process.env.GSM_TOOLS_ROOT : path.join(root, 'tools');
  const entries = fs.readdirSync(toolsDir, { recursive: true, withFileTypes: true });
  let parsed = 0;
  const seen = new Set();
  for (const ent of entries) {
    // A symlink can point at a real script: Dirents are lstat-based, so a
    // symlink reports neither file nor directory - resolve it before
    // classifying, or a mirror of a broken script reads as covered
    // (airhorn-0ct). Directories remain containers (airhorn-mo4).
    let isFile = ent.isFile();
    // resolve (not join): parentPath is spelled with the readdir base, which
    // is absolute here - join would double it and read a nonexistent path.
    const full = path.resolve(toolsDir, ent.parentPath || ent.path, ent.name);
    if (!isFile && !ent.isDirectory()) {
      let st = null;
      try { st = fs.statSync(full); } catch { st = null; }
      if (!st) assert.fail(`${path.relative(path.dirname(toolsDir), full)} is a dangling symlink - remove it or point it at a real file (airhorn-0ct, airhorn-pww)`);
      isFile = st.isFile();
    }
    if (!isFile) continue;
    const rel = path.relative(path.dirname(toolsDir), full);
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
    parse(full);
    parsed += 1;
    seen.add(path.basename(rel));
  }
  assert.ok(parsed >= 3, `expected the tools scripts to be present, got ${parsed}`);
  // Silent-loss pin (airhorn-n0sd, from the airhorn-tuuq sweep): parsed >= 3
  // stayed green while six of nine tools were deleted. These are named so a
  // deletion or rename fails HERE, by name. A new tool needs no edit here -
  // the glob above parses it - but removing a pinned one is loud. Superset,
  // not exact set: the airhorn-0ct pin's redirected child run adds probe
  // files to its throwaway copy, and an exact set would fail that valid leg.
  const REQUIRED_TOOLS = [
    'audio-parity.mjs',
    'cache-growth.mjs',
    'fast-gate.sh',
    'install-https-proof.mjs',
    'measure-perf.mjs',
    'preview-evidence.mjs',
    'render-model.mjs',
    'resilience-audit.mjs',
    'soak.mjs',
  ];
  const missingTools = REQUIRED_TOOLS.filter((name) => !seen.has(name));
  assert.deepEqual(missingTools, [], `pinned tools scripts went missing from tools/: ${missingTools.join(', ')} - restore them or update this inventory deliberately`);
});

test('a launch that never starts fails labelled and leaves no profile behind (airhorn-trj7)', () => {
  // No browser is started: a CHROME_BIN that does not exist makes spawn() report
  // through the child's 'error' event, which with no listener is an
  // uncaughtException - it aborts the tool before any teardown and leaves the
  // profile dir mkdtemp'd for the launch behind. TMPDIR (and --out) are per-test
  // so a concurrent lane's tool run cannot be mistaken for this one's leak, and
  // so the probe never writes into the repo. One representative tool: the other
  // two take the same two-line race, and only this one allocates the dir itself.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-launch-'));
  try {
    const res = spawnSync(process.execPath,
      [path.join(root, 'tools', 'install-https-proof.mjs'), '--out', path.join(tmp, 'out')], {
        encoding: 'utf8',
        timeout: 120000,
        env: { ...process.env, CHROME_BIN: path.join(tmp, 'no-such-chrome'), TMPDIR: tmp },
      });
    assert.equal(res.status, 1, `expected a labelled failure (rc 1), got ${res.status}: ${res.stderr}`);
    assert.doesNotMatch(res.stderr, /Unhandled 'error' event/,
      `a spawn error must route into the tool's own teardown, not abort it: ${res.stderr}`);
    assert.match(res.stderr, /chrome launch failed: .*ENOENT/,
      `the launch failure must be labelled: ${res.stderr}`);
    const left = fs.readdirSync(tmp).filter((name) => name !== 'out');
    assert.deepEqual(left, [], `the failed launch left ${JSON.stringify(left)} behind`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an audit whose browser never starts reports a labelled ERROR row and keeps its exit contract (airhorn-r5me)', () => {
  // The audit's contract is "exit 0 and print a table whatever it finds", so a
  // CHROME_BIN that does not exist has to become an ERROR row for that scenario,
  // not an uncaught 'error' event that aborts the run and leaks the launch
  // profile. TMPDIR, RESILIENCE_OUT and the profile live under one per-test dir,
  // so this probe cannot collide with a concurrent lane's audit.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm-audit-'));
  try {
    const res = spawnSync(process.execPath, [path.join(root, 'tools', 'resilience-audit.mjs')], {
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        RESILIENCE_ONLY: 'liefi',
        RESILIENCE_OUT: path.join(tmp, 'evidence'),
        CHROME_BIN: path.join(tmp, 'no-such-chrome'),
        TMPDIR: tmp,
      },
    });
    assert.equal(res.status, 0, `the audit exits 0 whatever it finds; got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /\[liefi\][\s\S]*ERROR chrome launch failed: .*ENOENT/,
      `the scenario must carry a labelled ERROR row: ${res.stdout}`);
    assert.doesNotMatch(res.stderr, /Unhandled 'error' event/,
      `a spawn error must not abort the audit: ${res.stderr}`);
    const left = fs.readdirSync(tmp).filter((name) => name !== 'evidence');
    assert.deepEqual(left, [], `the failed launch left ${JSON.stringify(left)} behind`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a tool holding a handle the peer will not close still exits, and its output survives (airhorn-s1wy)', () => {
  // cache-growth's success path used to set process.exitCode and return, so a
  // peer that swallows the ws close-frame kept the event loop alive after the
  // run had PASSed and the process never exited. Driven as a child so a hang
  // cannot hang the suite, and with no files so it cannot collide with a
  // concurrent lane: the drained exit terminates the process, exitCode alone
  // does not, and 200KB piped through the drain arrives whole (a bare
  // process.exit drops the tail beyond the 64KB pipe buffer).
  const held = 'setInterval(() => {}, 1000); ';
  const drained = spawnSync(process.execPath,
    ['--input-type=module', '-e', held + "process.stdout.write('', () => process.exit(0));"],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(drained.status, 0, `the drained exit must terminate the process: ${drained.error || drained.stderr}`);
  const exitCodeOnly = spawnSync(process.execPath,
    ['--input-type=module', '-e', held + 'process.exitCode = 0;'],
    { encoding: 'utf8', timeout: 500 });
  assert.equal(exitCodeOnly.signal, 'SIGTERM',
    'exitCode alone must NOT terminate a held loop, or this pin proves nothing about the shape it replaced');
  const big = spawnSync(process.execPath, ['--input-type=module', '-e',
    held + "for (let i = 0; i < 200; i++) process.stdout.write('x'.repeat(1000) + '\\n'); " +
    "process.stdout.write('', () => process.exit(0));"], { encoding: 'utf8', timeout: 10000 });
  assert.equal(big.stdout.length, 200200,
    `a piped write must arrive whole before the drained exit fires; got ${big.stdout.length} of 200200`);
  // And the tool itself must still carry that exit: the shape above is what a
  // revert to exitCode-only would silently take away, and no assertion on the
  // mechanism can see a regression in the tool's own tail.
  const source = fs.readFileSync(path.join(root, 'tools', 'cache-growth.mjs'), 'utf8');
  assert.match(source, /main\(\)\.then\(\(code\) => \{[\s\S]{0,1200}?process\.exit\(code\)/,
    'cache-growth\'s success path must hard-exit (drained) - process.exitCode alone hangs on a swallowed close-frame');
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

test('the tools parse fails on a symlinked broken script and passes a valid one (airhorn-0ct)', {
  skip: guardActive() ? 'self-invocation guard' : false,
}, () => {
  // A regression pin that invokes the REAL suite: with a symlinked broken
  // script in tools/, the tools parse must fail; with a valid target, pass.
  // The probe lives in a throwaway copy of tools/ (airhorn-ey1, airhorn-tun),
  // so the live repo tree is never touched and concurrent runs do not collide.
  const defaultToolsDir = path.join(root, 'tools');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-smoke-symlink-'));
  const tmpToolsDir = path.join(tmp, 'tools');
  fs.cpSync(defaultToolsDir, tmpToolsDir, { recursive: true });
  const probeName = `zz-symlink-probe-${crypto.randomBytes(4).toString('hex')}.mjs`;
  const link = path.join(tmpToolsDir, probeName);
  // The child re-runs ONLY the tests this pin is about (airhorn-3wnr): the
  // tools-parse test, which is the one that reads GSM_TOOLS_ROOT, plus this pin
  // itself so its guard skip stays visible. Two reasons, both measured:
  //   - COST: the child used to run the whole suite, and this pin runs it three
  //     times (broken, valid, dangling) - ~36-78 s of gate-smoke's runtime, i.e.
  //     roughly half of it, on a suite that every tools/ change pays for.
  //   - HONESTY: a child that runs everything fails for reasons that have
  //     nothing to do with symlinks (a tree without dist/, or any other flaky
  //     test), so the pin read red for the wrong thing.
  const CHILD_TESTS = '^(every tools script parses|the tools parse fails)';
  const runSelf = () => {
    // Strip the runner's NODE_TEST_CONTEXT: a child node --test that inherits
    // it believes it is a managed test child, writes nothing and exits 0 -
    // the silent green that made this pin read as a false pass.
    const childEnv = {
      ...process.env,
      [guardKey]: guardToken,
      GATE_SMOKE_SELF: `${guardKey}:${guardToken}`,
      GSM_TOOLS_ROOT: tmpToolsDir,
    };
    delete childEnv.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath,
      ['--test', '--test-reporter=tap', `--test-name-pattern=${CHILD_TESTS}`, path.join(root, 'tests', 'gate-smoke.test.js')], {
        cwd: root, encoding: 'utf8',
        env: childEnv,
      });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    // The child MUST have skipped this pin via the guard pairing
    // (airhorn-5os): a green child that RAN its own pin would be
    // recursion, and a guard that never engages is invisible.
    assert.ok(/# SKIP[-\s]*self-invocation guard/.test(out), `the pin child must report the guard skip: ${out.slice(0, 200)}`);
    // And it must be SCOPED (airhorn-3wnr): the tools-parse test ran for real,
    // and the rest of gate-smoke did not. Without this, a later edit that drops
    // the name pattern silently restores the triple cost.
    assert.ok(/ok \d+ - every tools script parses/.test(out),
      `the child must run the tools-parse test: ${out.slice(0, 400)}`);
    assert.ok(!out.includes('a change that selects ZERO suites'),
      `the child must not run the rest of gate-smoke (it would pay gate-smoke three times - airhorn-3wnr): ${out.slice(0, 400)}`);
    const lines = out.split('\n').filter((l) => /not ok|pass |fail |SyntaxError|Error/.test(l)).slice(0, 6).join(' || ');
    return { status: r.status, out, tail: `err=${r.error ? r.error.code : 'none'} ${lines}` };
  };
  try {
    fs.writeFileSync(path.join(tmp, 'broken.mjs'), 'const x = {');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(tmp, 'broken.mjs'), link);
    const brokenRun = runSelf();
    assert.notEqual(brokenRun.status, 0, `a symlinked BROKEN tools script must fail the suite: ${brokenRun.tail}`);
    assert.ok(brokenRun.out.includes(probeName), `broken leg must mention probe name: ${brokenRun.out.slice(0, 300)}`);
    assert.ok(!brokenRun.out.includes('tools/tools/'), `broken leg must not contain doubled prefix: ${brokenRun.out.slice(0, 300)}`);

    fs.writeFileSync(path.join(tmp, 'valid.mjs'), 'export const ok = 1;');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(tmp, 'valid.mjs'), link);
    const validRun = runSelf();
    assert.equal(validRun.status, 0, `with a VALID symlink the child tools-parse test must stay green: ${validRun.tail}`);
    assert.ok(!validRun.out.includes('tools/tools/'), `valid leg must not contain doubled prefix: ${validRun.out.slice(0, 300)}`);

    // Dangling: the resolution must fail LOUDLY, not silently skip - a
    // 'continue' here reads as coverage KNOWN over a hole (airhorn-56e).
    // The child must report the link's REAL path - a doubled or wrong
    // prefix still fails the suite but lies about the file (airhorn-b1n).
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(tmp, 'never-created.mjs'), link);
    const danglingRun = runSelf();
    assert.notEqual(danglingRun.status, 0, `a DANGLING symlinked tools script must fail the suite: ${danglingRun.tail}`);

    const expectedDanglingMsg = `tools/${probeName} is a dangling symlink`;
    const occurrences = danglingRun.out.split(expectedDanglingMsg).length - 1;
    assert.equal(occurrences, 1, `child output must contain '${expectedDanglingMsg}' exactly once, got ${occurrences}: ${danglingRun.out.slice(0, 400)}`);
    assert.ok(!danglingRun.out.includes('tools/tools/'), `child output must not contain 'tools/tools/': ${danglingRun.out.slice(0, 400)}`);
    assert.ok(!danglingRun.out.includes('never-created.mjs is a dangling symlink'), 'must report the probe path, not target path');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    // The repo tree is never touched (airhorn-ey1, airhorn-tun, airhorn-8r4):
    // verify no probe was ever created in the real tools/ directory.
    const realToolsEntries = fs.readdirSync(path.join(root, 'tools'));
    assert.equal(
      realToolsEntries.filter((f) => f.includes('probe')).length,
      0,
      `repo tools/ must contain no probe file, found: ${realToolsEntries.filter((f) => f.includes('probe')).join(', ')}`
    );
  }
});

test('ambient GSM_TOOLS_ROOT redirection is impossible without the minted guard pairing', {
  skip: guardActive() ? 'self-invocation guard' : false,
}, () => {
  // The decoy is a tools dir whose only script is broken: if the ambient var
  // were honoured the child would fail; it must pass and never name the decoy.
  // GSM_TOOLS_ROOT is honoured ONLY when guardActive() is true (airhorn-2de).
  const tmpDecoy = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-smoke-decoy-'));
  try {
    fs.writeFileSync(path.join(tmpDecoy, 'broken.mjs'), 'const x = {');
    // The child is filtered to the ONE test under observation
    // (--test-name-pattern), so it neither recurses into its own pins nor
    // needs a skip variable: an ambient 'GSM_DECOY_CHILD'-style escape hatch
    // would be the same silently-skipped pin airhorn-2de reported.
    const childEnv = { ...process.env, GSM_TOOLS_ROOT: tmpDecoy };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.GATE_SMOKE_SELF;
    for (const k of Object.keys(childEnv)) {
      if (k.startsWith('GATE_SMOKE_SELF_')) delete childEnv[k];
    }
    const r = spawnSync(process.execPath, [
      '--test',
      '--test-reporter=tap',
      '--test-name-pattern=recognised extensions at any depth',
      path.join(root, 'tests', 'gate-smoke.test.js'),
    ], {
      cwd: root, encoding: 'utf8',
      env: childEnv,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    assert.equal(r.status, 0, `child must pass when ambient GSM_TOOLS_ROOT is ignored: ${out.slice(0, 300)}`);
    assert.match(out, /# pass [1-9]/, `the decoy child must actually RUN the tools parse, not skip it: ${out.slice(0, 300)}`);
    assert.ok(!out.includes(tmpDecoy), `child output must not mention the decoy path: ${out.slice(0, 300)}`);
    assert.ok(!out.includes('broken.mjs'), `child output must not mention decoy scripts: ${out.slice(0, 300)}`);
  } finally {
    fs.rmSync(tmpDecoy, { recursive: true, force: true });
  }
});

// The audit's render instrument as a decision TABLE (airhorn-0w9, -cpi, -9py,
// -7s3, -4jw, -s52). Every fact below is what Chrome 155 MEASURED for that
// arrangement - checkVisibility without visibilityProperty ('boxChain'), the
// computed display/content-visibility/visibility/opacity, innerText - so this
// table is the browser's behaviour in Node form. The audit injects this
// module's SOURCE into the page, so the model tested here is the model
// Chromium runs: no second copy, no drift.
//
// The class this replaces: 'shown' was checkVisibility(el) and 'text' came
// from a separate walk, so every disagreement WAS a finding (a c-v:auto
// skipped region read shown:true over innerText '', a display:contents region
// with visible text read shown:false). Here one walk decides both, and the
// verdict is three-state: 'none' prunes a subtree, 'own' drops only this
// node's own text (so a visibility override below it survives), 'text'
// collects.
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
