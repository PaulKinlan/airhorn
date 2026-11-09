// Pins for the gate.conf tier-block mode of tools/merge-suite-map.mjs (airhorn-09dr). The
// requirements are the parser evidence encoded: distinct keys are order-insensitive
// (fast-gate.sh declared_tier is an exact-match first-hit-wins line scan), so union-by-key is
// safe for appends; a duplicate path with a DIFFERING tier must fail loudly because the
// parser would silently take the first; normalise is idempotent and reproduces today's
// gate.conf byte-for-byte; comments and blank lines survive. The REAL olju collision
// (fleet/olju-xassert @1989000 vs the staged tree feb9417) was resolved with this mode and
// the output pasted on the bead - that proof is ad-hoc because it depends on git history;
// the fixtures here carry the same shapes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(root, 'tools', 'merge-suite-map.mjs');
const run = (args) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', timeout: 30000 });
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

const conf = (rows, { comment = '# the pinned runner design lives here\n' } = {}) =>
  `# header\nFAST_GATE_RUNNER="node --test --test-reporter=tap"\n${comment}SUITE_TIERS="\n${rows.join('\n')}\n"\n`;

test('normalise reproduces the real gate.conf byte-for-byte, and twice is a no-op', () => {
  const file = path.join(root, 'tools', 'gate.conf');
  const before = fs.readFileSync(file, 'utf8');
  const check = run(['--tiers-check', file]);
  assert.equal(check.status, 0, `today's gate.conf must be canonical: ${check.stderr}`);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-')), 'gate.conf');
  fs.writeFileSync(tmp, before);
  run(['--tiers-normalise', tmp]);
  const once = fs.readFileSync(tmp, 'utf8');
  assert.equal(sha(once), sha(before), 'normalise must reproduce the real file byte-for-byte (comments and blanks included)');
  run(['--tiers-normalise', tmp]);
  assert.equal(sha(fs.readFileSync(tmp, 'utf8')), sha(once), 'normalise must be idempotent');
});

test('union is order-independent: two orderings of the same rows produce one result', () => {
  const a = conf(['tests/a.test.js=node-test', 'tests/b.test.js=script', 'tests/c.test.js=node-test']);
  const b = conf(['tests/c.test.js=node-test', 'tests/b.test.js=script', 'tests/a.test.js=node-test']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-u-'));
  const fa = path.join(dir, 'a.conf');
  const fb = path.join(dir, 'b.conf');
  fs.writeFileSync(fa, a);
  fs.writeFileSync(fb, b);
  const ab = run(['--tiers-union', fa, fb]);
  const ba = run(['--tiers-union', fb, fa]);
  assert.equal(ab.status, 0, ab.stderr);
  assert.equal(ba.status, 0, ba.stderr);
  assert.equal(ab.stdout, ba.stdout, 'the union must not depend on which side a row came from');
  for (const row of ['tests/a.test.js=node-test', 'tests/b.test.js=script', 'tests/c.test.js=node-test']) {
    assert.ok(ab.stdout.includes(row), `union lost ${row}`);
  }
});

test('a duplicate path with a DIFFERING tier refuses, naming both rows - across sides and within one file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-x-'));
  const ours = path.join(dir, 'ours.conf');
  const theirs = path.join(dir, 'theirs.conf');
  fs.writeFileSync(ours, conf(['tests/a.test.js=script']));
  fs.writeFileSync(theirs, conf(['tests/a.test.js=node-test']));
  const across = run(['--tiers-union', ours, theirs]);
  assert.equal(across.status, 1, 'a cross-side tier disagreement must fail, not pick one');
  assert.match(across.stderr, /tests\/a\.test\.js: tier 'node-test' in .* but 'script' in .* - a suite cannot be two tiers/);

  const dup = path.join(dir, 'dup.conf');
  fs.writeFileSync(dup, conf(['tests/a.test.js=node-test', 'tests/a.test.js=script']));
  const within = run(['--tiers-check', dup]);
  assert.equal(within.status, 1, 'an in-file tier disagreement must fail loudly');
  assert.match(within.stderr, /declared with tier 'script' here but 'node-test'/);
});

test('a duplicate path with the SAME tier is a merge artifact: normalise drops the second copy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-d-'));
  const dup = path.join(dir, 'dup.conf');
  fs.writeFileSync(dup, conf(['tests/a.test.js=node-test', 'tests/b.test.js=script', 'tests/a.test.js=node-test']));
  const res = run(['--tiers-normalise', dup]);
  assert.equal(res.status, 0, res.stderr);
  const out = fs.readFileSync(dup, 'utf8');
  assert.equal(out.split('\n').filter((l) => l.startsWith('tests/a.test.js=')).length, 1, 'the identical duplicate is dropped');
  assert.ok(out.includes('tests/b.test.js=script'));
});

test('everything outside the block survives a union verbatim (comments, the runner pin)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-c-'));
  const ours = path.join(dir, 'ours.conf');
  const theirs = path.join(dir, 'theirs.conf');
  fs.writeFileSync(ours, conf(['tests/a.test.js=node-test'], { comment: '# the z4cn rationale comment\n' }));
  fs.writeFileSync(theirs, conf(['tests/b.test.js=script']));
  const res = run(['--tiers-union', ours, theirs]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('# the z4cn rationale comment'), 'a comment outside the block must survive');
  assert.ok(res.stdout.includes('FAST_GATE_RUNNER="node --test --test-reporter=tap"'), 'the runner pin must survive');
});

/*
 * Import purity (the airhorn-fc98 class, seen FOUR times: soak, the nnbu probe,
 * preview-evidence, measure-perf - each found by a human, each cost a round):
 * a tool that tests import must be IMPORT-PURE, so its entry point - main() or
 * any top-level browser/server/child work - must sit behind an invoked-as-script
 * guard. This scans the tools the suites actually import (the scope coord set:
 * policing the whole repo would cry wolf) and fails when an imported tool calls
 * main() with no recognized guard.
 *
 * Recognized guard idioms (the codebase already uses four, all equivalent):
 *   if (invokedAsScript) ... / if (isMain) ... /
 *   process.argv[1] compared with fileURLToPath(import.meta.url) (either order).
 * A genuinely run-only script is out of scope BY CONSTRUCTION (no test imports
 * it); the failure message names the two honest resolutions.
 */
test('tools that tests import never run main() unguarded (the fc98 class)', () => {
  const testsDir = path.join(root, 'tests');
  const importedTools = new Set();
  // Static AND dynamic imports, from EVERY .js/.mjs under tests/ - helpers
  // included, since tests/support/browser.mjs imports tools/lib/chrome.mjs via
  // '../../tools/...' (airhorn-5su1: the from-only, *.test.js-only scan let the
  // dynamically-imported tools perf-metrics/request-path/install-https-proof and
  // any helper-only tool escape the scan entirely). The specifier is resolved
  // against the importing file, so any relative prefix that lands in tools/ counts.
  const specRe = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  const testFiles = [];
  const collect = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) collect(full);
      else if (/\.(js|mjs)$/.test(ent.name)) testFiles.push(full);
    }
  };
  collect(testsDir);
  for (const file of testFiles) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(specRe)) {
      const resolved = path.resolve(path.dirname(file), m[1]);
      const rel = path.relative(root, resolved).split(path.sep).join('/');
      if (rel.startsWith('tools/') && rel.endsWith('.mjs')) importedTools.add(rel);
    }
  }
  assert.ok(importedTools.size > 5, 'the scan must find the real import set, not an empty one');
  // airhorn-5su1 pin: the tools that today are reachable ONLY via dynamic import()
  // must be in the scanned set - with a static-from-only regex all three escape.
  for (const dynamicOnly of ['tools/lib/perf-metrics.mjs', 'tools/lib/request-path.mjs', 'tools/install-https-proof.mjs']) {
    assert.ok(importedTools.has(dynamicOnly),
      `the scan must cover dynamically-imported tools too (airhorn-5su1): ${dynamicOnly} is imported by tests only via import() and escaped a static-only scan`);
  }

  // A top-level main() invocation: `main()` / `main().catch(...)` / `await main()`,
  // at line start - the entry point shape every incident had.
  // Call shapes seen in the tree: `main()`, `await main()`, `const code = main()`,
  // `process.exitCode = await main()` - all at line start (comments and prose
  // mentions start with '*' or '//' and never match).
  const mainCallRe = /(^|\n)\s*(?:(?:const|let|var)\s+\w+|[\w.]+)?\s*=?\s*(?:await\s+)?main\s*\(\s*\)/g;
  // The guard must WRAP the call, not merely exist in the file: a probe that
  // neutered 'if (invokedAsScript)' to 'if (false)' left the declaration text
  // behind and a presence-check passed it. Recognized guard tokens (the tree's
  // five idioms): invokedAsScript / isMain / invokedDirectly / an argv[1] or
  // import.meta.url comparison inline.
  const guardToken = /invokedAsScript|\bisMain\b|invokedDirectly|argv\[1\]|import\.meta\.url/;
  // A call is guarded when it sits INSIDE the block of an if whose condition carries
  // a guard token. Indentation is unreliable (cache-growth's guarded call is at column
  // 0) and a windowed nearest-if is unreliable (mutation-check's guard block is ~1000
  // chars of signal handlers, so the nearest if to its call is an unrelated inner one),
  // so: take the LAST guard-token if before the call and require its block to be still
  // open at the call - no net brace close between them. Heuristic, documented: braces
  // inside strings/comments in that window could skew the balance; the tree's five
  // idioms all balance.
  const isGuardedCall = (src, callIndex) => {
    const before = src.slice(0, callIndex);
    // Conditions allow ONE level of nested parens: invokedDirectly(), fileURLToPath(...).
    const guardIfs = [...before.matchAll(/if\s*\(((?:[^()]|\([^()]*\))*)\)\s*\{/g)].filter((m) => guardToken.test(m[1]));
    const guard = guardIfs[guardIfs.length - 1];
    if (!guard) return false;
    const between = src.slice(guard.index + guard[0].length, callIndex);
    const opens = (between.match(/\{/g) || []).length;
    const closes = (between.match(/\}/g) || []).length;
    return closes <= opens;
  };

  const offenders = [];
  for (const rel of importedTools) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue; // imports of pending tools are the map's problem
    const src = fs.readFileSync(file, 'utf8');
    let unguarded = false;
    for (const m of src.matchAll(mainCallRe)) {
      const idx = m.index + m[0].indexOf('main');
      if (/function\s*$/.test(src.slice(Math.max(0, m.index - 30), m.index))) continue; // the declaration, not a call
      if (!isGuardedCall(src, m.index)) unguarded = true;
    }
    if (unguarded) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    `tools imported by tests must not run main() at import (the fc98 class). ` +
    `Fix by gating the entry: const invokedAsScript = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); if (invokedAsScript) main()... ` +
    `- or, if the tool is genuinely run-only, stop importing it from tests. Offenders: ${offenders.join(', ')}`);
});
