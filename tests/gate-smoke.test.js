/*
 * tests/gate-smoke.test.js - the gate's PROCESS pins: the self-invocation guard, the
 * tools-parse sweep, the launch/exit pins, the verdict-line probe and the
 * GSM_TOOLS_ROOT isolation. These spawn real processes (and one browser), so they are
 * slow by nature; the map and selection contract moved to tests/gate-map.test.mjs
 * (airhorn-gkqu). The preamble is duplicated on purpose - see the note in that file
 * about tests/support/** selecting every suite.
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

// Records the probe's dist/ as the CURRENT tree's, the way a real build does. The gate
// exposes this as --stamp-dist (a repair/testing query): it asserts that what is on disk
// is current, and if either side changes afterwards the next decision rebuilds.
const stampProbeDist = (probe) => {
  const res = probe.run(['--stamp-dist']);
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
};

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
    "// serves files out of dist/\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('one passing case', () => { assert.ok(true); });\n");
  fs.mkdirSync(path.join(probe, 'src'), { recursive: true });
  fs.writeFileSync(path.join(probe, 'src', 'a.js'), '// a');
  fs.writeFileSync(path.join(probe, 'pending-src.txt'), 'pending');
  fs.writeFileSync(path.join(probe, 'mixed-src.js'), '// mixed');
  fs.writeFileSync(path.join(probe, 'README.md'), '# probe');
  // dist/ is gitignored in the real repo, so it never appears as a CHANGED path. The
  // probe must mirror that or every case that plants a dist/ would report it unmapped.
  fs.writeFileSync(path.join(probe, '.gitignore'), 'dist/\nnode_modules/\n');
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
        timeout: 60000,
        env: {
          ...process.env,
          CHROME_BIN: path.join(tmp, 'no-such-chrome'),
          TMPDIR: tmp,
          // Pin the steal seam healthy, exactly as airhorn-r5me does (airhorn-cl29):
          // this test is about a launch that cannot START, so the launch has to be
          // ATTEMPTED. Without the pin the preflight refuses first on a loaded host
          // and the test fails for the wrong reason - it asserted about the machine.
          // The 60s spawn bound stays (f129557): the sanctioned answer to host
          // starvation is the steal-aware preflight pinned here, not a wider timeout
          // that masks genuine stalls.
          AIRHORN_TEST_CONTEXT: '1',
          CHROME_STEAL_OVERRIDE: '0',
        },
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
  // The exit contract distinguishes WHY a row is bad (airhorn-w1wh rounds 3-8):
  //   - a row with status ERROR is an infrastructure/scenario failure - a browser
  //     that cannot start, a scenario callback that throws - so the audit EXITS
  //     NONZERO. A starved host reporting a green audit was the bug this pins.
  //   - an audit that completes and reports findings is a SUCCESSFUL audit: its
  //     rows are status OK and it exits 0, however bad the findings.
  //   - an intentionally empty selection (RESILIENCE_ONLY=none) also exits 0.
  // This fixture is the ERROR case: CHROME_BIN does not exist, so the launch fails
  // and that must be a labelled ERROR row plus a written report, not an uncaught
  // 'error' event that aborts the run and leaks the launch profile. The steal seam
  // is pinned healthy so the launch is actually attempted here - otherwise the
  // preflight refuses first on a starved host and this test would assert about the
  // machine rather than about the audit. TMPDIR, RESILIENCE_OUT and the profile live
  // under one per-test dir, so this probe cannot collide with a concurrent lane.
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
        AIRHORN_TEST_CONTEXT: '1',   // opt into the seam so the launch is attempted
        CHROME_STEAL_OVERRIDE: '0',  // ...and a starved host cannot intercept here
      },
    });
    // An ERROR row is an infrastructure failure, so the audit fails (airhorn-w1wh
    // rounds 3-8); a completed audit that merely FINDS problems still exits 0, which
    // is the distinction, not "nonzero whenever the news is bad".
    assert.notEqual(res.status, 0,
      `an ERROR row must fail the audit; got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout, /\[liefi\][\s\S]*ERROR cannot launch a browser for the audit, so no scenario was measured: .*ENOENT/,
      `the scenario must carry a labelled ERROR row naming the launch failure: ${res.stdout}`);
    assert.ok(fs.existsSync(path.join(tmp, 'evidence', 'report.md')),
      'the report is the deliverable: it must be written even when the browser never started');
    assert.ok(fs.existsSync(path.join(tmp, 'evidence', 'report.json')));
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

test('--build-plan answers for an exempt-only or unmapped change, without building (airhorn-ocqw)', () => {
  // The query used to sit at the BOTTOM of the script, below the unmapped and zero-suite exits, so
  // the two changes a human most wants to ask "would this build?" about were the two that exited
  // before answering. It now answers first and names WHY the selection is empty. It must also stay
  // READ-ONLY: build_decision inspects, and the query exits before the build section - proved here
  // by pointing the probe's own build script at a marker file that must never appear.
  const { probe, run } = buildGateProbe();
  try {
    // Read-only proof: if anything ever builds, this file appears. Committed, so the probe tree is
    // still CLEAN - an uncommitted fixture file is itself a changed path, and the empty-change leg
    // below must genuinely have nothing to report.
    fs.writeFileSync(path.join(probe, 'package.json'),
      JSON.stringify({ name: 'gate-contract-probe', private: true, scripts: { build: 'touch built.marker' } }));
    for (const args of [['add', 'package.json'], ['commit', '-m', 'marker build']]) {
      const g = spawnSync('git', ['-C', probe, ...args], { encoding: 'utf8' });
      assert.equal(g.status, 0, `probe git ${args[0]} failed: ${g.stderr}`);
    }

    // 1. exempt-only: the real gate exits zero-suite (below); the QUERY must answer and name the row.
    const exempt = run(['--build-plan', '--changed', 'exempt.md']);
    assert.equal(exempt.status, 0, `an exempt-only --build-plan must answer, not exit: ${exempt.stdout}${exempt.stderr}`);
    assert.match(exempt.stdout, /^fast-gate: build-plan: (build|keep) \(/m,
      `the query must report the decision: ${exempt.stdout}`);
    assert.match(exempt.stdout, /^fast-gate: build-plan: exempt: exempt\.md /m,
      `the answer must name the exemption, not just go quiet: ${exempt.stdout}`);
    assert.ok(!exempt.stdout.includes('ZERO-SUITE PASS') && !exempt.stdout.includes('fast-gate: zero-suite:'),
      `a QUERY must not print a verdict: ${exempt.stdout}`);

    // 2. unmapped: same, and the answer must name the file and say the real gate fails it.
    const unmapped = run(['--build-plan', '--changed', 'unmapped.txt']);
    assert.equal(unmapped.status, 0, `an unmapped --build-plan must answer, not exit: ${unmapped.stdout}${unmapped.stderr}`);
    assert.match(unmapped.stdout, /^fast-gate: build-plan: (build|keep) \(/m, unmapped.stdout);
    assert.match(unmapped.stdout, /^fast-gate: build-plan: unmapped: unmapped\.txt \(no row and no exemption/m,
      `the answer must name the unmapped file: ${unmapped.stdout}`);
    assert.ok(!unmapped.stderr.includes('FAIL'), `the query must not fail the change it is asked about: ${unmapped.stderr}`);

    // 3. a genuinely empty change set may still say so - as an answer, with rc 0.
    const empty = run(['--build-plan']);
    assert.equal(empty.status, 0, `an empty-change query must answer: ${empty.stdout}${empty.stderr}`);
    assert.match(empty.stdout, /^fast-gate: build-plan: no changed files \(nothing to decide\)$/m, empty.stdout);

    // 4. and the VERDICT paths are untouched: the same two changes still fail as before.
    const exemptVerdict = run(['--changed', 'exempt.md']);
    assert.equal(exemptVerdict.status, 1, `the real gate must still refuse an exempt-only change: ${exemptVerdict.stdout}`);
    const unmappedVerdict = run(['--changed', 'unmapped.txt']);
    assert.equal(unmappedVerdict.status, 1, `the real gate must still refuse an unmapped change: ${unmappedVerdict.stdout}`);

    // 5. nothing built, nothing written.
    assert.ok(!fs.existsSync(path.join(probe, 'built.marker')),
      '--build-plan must never build: the probe build script left its marker');
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
});

test('a build that changes its own inputs leaves NO stamp, so the next run rebuilds (airhorn-bt55 P1)', () => {
  // The stamp used to be written with a digest taken AFTER the build, so a build that edits its own
  // inputs stamped the tree it LEFT BEHIND over a dist/ built from the tree it READ - and the next
  // run reused it. That is a stale-dist green, which tools/fast-gate.sh's own rule forbids.
  const { probe, run } = buildGateProbe();
  try {
    const pkg = (build) => JSON.stringify({ name: 'gate-contract-probe', private: true, scripts: { build } });
    // The probe's own build appends to src/a.js - the exact shape: inputs move while the build runs.
    fs.writeFileSync(path.join(probe, 'package.json'),
      pkg("mkdir -p dist && echo BUILT > dist/index.html && printf '// built\\n' >> src/a.js"));
    const first = run(['--changed', 'tests/pass.test.js']);
    assert.equal(first.status, 0, `the gate must still run its suite: ${first.stdout}${first.stderr}`);
    assert.match(first.stdout, /fast-gate: building dist/, first.stdout);
    assert.match(first.stderr, /not stamping dist\/: the build changed its own inputs/, first.stderr);
    assert.ok(!fs.existsSync(path.join(probe, 'dist', '.fast-gate-stamp')),
      'a build that moved its own inputs must leave NO stamp: any stamp here describes the tree it left behind');
    // The consequence: the NEXT decision must rebuild, not reuse a dist/ no stamp describes.
    const plan = run(['--build-plan', '--changed', 'tests/pass.test.js']);
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /^fast-gate: build-plan: build \(/m,
      `the next run must rebuild, not reuse: ${plan.stdout}`);

    // Control: the same build that does NOT touch its inputs DOES stamp, and the next query reuses.
    // Without this, the assertion above would pass for a gate that never stamps at all.
    fs.writeFileSync(path.join(probe, 'package.json'),
      pkg('mkdir -p dist && echo BUILT > dist/index.html'));
    const second = run(['--changed', 'tests/pass.test.js']);
    assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
    assert.ok(fs.existsSync(path.join(probe, 'dist', '.fast-gate-stamp')),
      'an honest build must stamp dist/, or the no-stamp assertion above proves nothing');
    const keep = run(['--build-plan', '--changed', 'tests/pass.test.js']);
    assert.match(keep.stdout, /^fast-gate: build-plan: keep \(/m, keep.stdout);
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
});

test('a symlinked build input fails the digest loudly instead of blinding the stamp (airhorn-bt55 a)', () => {
  // `find -type f` skips a symlink, so a symlinked input contributes NOTHING to the digest: the
  // stamp stays "current" while the bytes it claims to cover change underneath it - reuse forever.
  // It must fail loudly and the decision must be REBUILD.
  const { probe, run } = buildGateProbe();
  try {
    fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({
      name: 'gate-contract-probe', private: true,
      scripts: { build: 'mkdir -p dist && echo BUILT > dist/index.html' },
    }));
    const built = run(['--changed', 'tests/pass.test.js']);
    assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
    assert.ok(fs.existsSync(path.join(probe, 'dist', '.fast-gate-stamp')), 'the control build must stamp dist/');
    assert.match(run(['--build-plan', '--changed', 'tests/pass.test.js']).stdout, /build-plan: keep \(/,
      'control: a current stamp is reused');

    fs.rmSync(path.join(probe, 'src', 'a.js'));
    fs.symlinkSync(path.join(probe, 'package.json'), path.join(probe, 'src', 'a.js'));
    const plan = run(['--build-plan', '--changed', 'tests/pass.test.js']);
    assert.match(plan.stderr, /fast-gate: digest: cannot read src\/a\.js \(it is a symlink/,
      `an unreadable input must be named loudly, not hashed around: ${plan.stderr}`);
    assert.match(plan.stdout, /^fast-gate: build-plan: build \(/m,
      `and the decision must be REBUILD, never reuse: ${plan.stdout}`);
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
});

test('an unstamped dist/ is never reused, whatever its mtime says (airhorn-k8sd)', () => {
  // The reviewer's design: reuse requires a stamp that binds the working-tree build
  // inputs AND the dist/ bytes. A dist/ with no stamp is unverified, even if it looks
  // fresh - "newer than every input" is not evidence of anything.
  const probe = buildGateProbe();
  try {
    const distFile = path.join(probe.probe, 'dist', 'index.html');
    fs.mkdirSync(path.dirname(distFile), { recursive: true });
    fs.writeFileSync(distFile, 'DIST-WITH-NO-PROVENANCE');
    const future = new Date(Date.now() + 5_000);
    fs.utimesSync(distFile, future, future);

    const res = probe.run(['--build-plan', '--changed', 'tests/pass.test.js']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /build-plan: build \(dist\/ carries no stamp/,
      `an unstamped dist/ must not be reused: ${res.stdout}`);
  } finally {
    fs.rmSync(probe.probe, { recursive: true, force: true });
  }
});

test('a stamped dist/ that matches its inputs and its own bytes is reused (airhorn-5pqg)', () => {
  const probe = buildGateProbe();
  try {
    const distFile = path.join(probe.probe, 'dist', 'index.html');
    fs.mkdirSync(path.dirname(distFile), { recursive: true });
    fs.writeFileSync(distFile, 'BUILT-NOW');
    stampProbeDist(probe);

    const kept = probe.run(['--build-plan', '--changed', 'tests/pass.test.js']);
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /build-plan: keep \(dist\/ is stamped for these inputs/,
      `a matching stamp must be reused: ${kept.stdout}`);

    // ... and the override still wins over a valid stamp.
    const forced = probe.run(['--build-plan', '--changed', 'tests/pass.test.js'], { FAST_GATE_FORCE_BUILD: '1' });
    assert.match(forced.stdout, /build-plan: build \(FAST_GATE_FORCE_BUILD=1\)/, forced.stdout);
  } finally {
    fs.rmSync(probe.probe, { recursive: true, force: true });
  }
});

test('the build decision rebuilds when a build input\'s BYTES change, not just its status text (airhorn-k8sd P1a)', () => {
  // The reviewer's P1a: a file that is already 'M' and edited again keeps the same
  // git status text, so a status-based stamp says "unchanged" while the bytes differ.
  const probe = buildGateProbe();
  try {
    const distFile = path.join(probe.probe, 'dist', 'index.html');
    fs.mkdirSync(path.dirname(distFile), { recursive: true });
    fs.writeFileSync(distFile, 'BUILT-NOW');
    const srcFile = path.join(probe.probe, 'src', 'a.js');
    fs.writeFileSync(srcFile, '// dirty edit one\n');   // already 'M'
    stampProbeDist(probe);

    const unchanged = probe.run(['--build-plan', '--changed', 'tests/pass.test.js']);
    assert.match(unchanged.stdout, /build-plan: keep \(/, `baseline must keep: ${unchanged.stdout}`);

    fs.writeFileSync(srcFile, '// dirty edit two, same git status\n');  // status text unchanged
    const after = probe.run(['--build-plan', '--changed', 'tests/pass.test.js']);
    assert.match(after.stdout, /build-plan: build .*working-tree build inputs changed/,
      `changed bytes must rebuild even when git status text is identical: ${after.stdout}`);
  } finally {
    fs.rmSync(probe.probe, { recursive: true, force: true });
  }
});

test('the build decision rebuilds when dist/ bytes change under a current stamp (airhorn-k8sd P1b)', () => {
  // The reviewer's P1b: a stamp that is not bound to the OUTPUT bytes lets an older
  // dist/ be copied in underneath it, and a tests-only selection then keeps it.
  const probe = buildGateProbe();
  try {
    const distFile = path.join(probe.probe, 'dist', 'index.html');
    fs.mkdirSync(path.dirname(distFile), { recursive: true });
    fs.writeFileSync(distFile, 'BUILT-FROM-SRC-V2');
    stampProbeDist(probe);

    const kept = probe.run(['--build-plan', '--changed', 'tests/pass.test.js']);
    assert.match(kept.stdout, /build-plan: keep \(/, `baseline must keep: ${kept.stdout}`);

    // An older build copied in, stamp file untouched and still current for the inputs.
    fs.writeFileSync(distFile, 'BUILT-FROM-SRC-V1-OLDER');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(distFile, old, old);

    const after = probe.run(['--build-plan', '--changed', 'tests/pass.test.js']);
    assert.match(after.stdout, /build-plan: build .*bytes in dist\/ changed/,
      `swapped dist bytes must rebuild even with a current stamp: ${after.stdout}`);
  } finally {
    fs.rmSync(probe.probe, { recursive: true, force: true });
  }
});

test('a dist-needing suite rebuilds an unfingerprinted dist/; a non-dist suite does not build at all (airhorn-k8sd)', () => {
  // The reviewer's P1: the skip has to know (a) whether a SELECTED suite reads dist/
  // and (b) whether that dist/ came from THIS tree. Here dist/ exists but carries no
  // fingerprint, exactly like a dist/ left behind by an earlier checkout.
  const probe = buildGateProbe();
  try {
    const distFile = path.join(probe.probe, 'dist', 'index.html');
    fs.mkdirSync(path.dirname(distFile), { recursive: true });
    fs.writeFileSync(distFile, 'DIST-FROM-AN-EARLIER-CHECKOUT');

    // A suite that serves dist/ files, mapped from a path that is NOT a build input.
    fs.writeFileSync(path.join(probe.probe, 'tests', 'dist-suite.test.js'),
      "// serves files out of dist/\nimport { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('x', () => { assert.ok(true); });\n");
    fs.writeFileSync(path.join(probe.probe, 'dist-src.txt'), 'not a build input');
    fs.appendFileSync(path.join(probe.probe, 'tools', 'suite-map.tsv'),
      'dist-src.txt\ttests/dist-suite.test.js\ntests/dist-suite.test.js\ttests/dist-suite.test.js\n');

    const needs = probe.run(['--build-plan', '--changed', 'dist-src.txt']);
    assert.equal(needs.status, 0, needs.stderr);
    assert.match(needs.stdout, /build-plan: build \(dist\/ carries no stamp/,
      `a dist-needing suite must not reuse an unfingerprinted dist/: ${needs.stdout}`);

    // A suite that never mentions dist/ must not pay for a build, and must not fail
    // for want of one - that is the whole point of the skip.
    fs.rmSync(distFile);
    fs.writeFileSync(path.join(probe.probe, 'tests', 'plain-suite.test.js'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('y', () => { assert.ok(true); });\n");
    fs.writeFileSync(path.join(probe.probe, 'plain-src.txt'), 'plain');
    fs.appendFileSync(path.join(probe.probe, 'tools', 'suite-map.tsv'),
      'plain-src.txt\ttests/plain-suite.test.js\ntests/plain-suite.test.js\ttests/plain-suite.test.js\n');
    const noDistNeeded = probe.run(['--build-plan', '--changed', 'plain-src.txt']);
    assert.match(noDistNeeded.stdout, /build-plan: keep \(no selected suite reads dist\//,
      `a non-dist suite must keep: ${noDistNeeded.stdout}`);
  } finally {
    fs.rmSync(probe.probe, { recursive: true, force: true });
  }
});

test('a suite that builds ../dist with path.join counts as dist-dependent (airhorn-nh8y)', () => {
  // Grepping for the literal "dist/" was too literal: tests/horn.test.js and
  // tests/visual-overrides.test.mjs construct path.join(__dirname, '../dist'), so the
  // gate said "no selected suite reads dist/" and would keep - or refuse to make - a
  // dist/ those suites read. Fail-first: pre-fix this probe answers keep.
  const probe = buildGateProbe();
  try {
    fs.writeFileSync(path.join(probe.probe, 'tests', 'joined-suite.test.js'),
      "import path from 'node:path';\n// reads the bundle via path.join(__dirname, '../dist')\n" +
      "export const distDir = path.join(import.meta.dirname, '../dist');\n");
    fs.writeFileSync(path.join(probe.probe, 'joined-src.txt'), 'plain');
    fs.appendFileSync(path.join(probe.probe, 'tools', 'suite-map.tsv'),
      'joined-src.txt\ttests/joined-suite.test.js\ntests/joined-suite.test.js\ttests/joined-suite.test.js\n');

    const res = probe.run(['--build-plan', '--changed', 'joined-src.txt']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /build-plan: build \(/,
      `a suite that joins ../dist must count as dist-dependent: ${res.stdout}`);
  } finally {
    fs.rmSync(probe.probe, { recursive: true, force: true });
  }
});
