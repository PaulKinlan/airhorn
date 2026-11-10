// Pin for the fallback badge-count merge (airhorn-f5ut, airhorn-17qn): the
// no-Web-Locks path in src/badge.js had NO test - the freshest-read merge could
// be reverted with every suite green. This suite drives the REAL BlastBadge
// class browser-free with a scripted mock Storage (commits from "another tab"
// injected at a chosen read), and pins:
//   (a) a stale writer over a fresher committed value BUILDS ON it (9 -> 10),
//       never reduces (the old code wrote 6);
//   (b) two concurrent bumps are both counted (5 + 2 + 1 -> 8);
//   (c) the WRAP world: the stored count is an unbounded monotonic integer -
//       99 + concurrent bump -> 101 stored, badge display capped at 99; a
//       modulo store read a wrap as a stale LOWER value and lost a blast;
//   (d) acknowledge() still clears the count and the OS badge;
//   (e) the single-tab path is unchanged.
// navigator.locks is deliberately ABSENT in the mock: the locked path is
// covered by tests/multitab.test.mjs; this suite exists for the fallback.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');

const installDom = (storage) => {
  const calls = [];
  Object.defineProperty(globalThis, 'window', { value: { localStorage: storage }, configurable: true });
  Object.defineProperty(globalThis, 'navigator', {
    value: { setAppBadge: (n) => calls.push(['set', n]), clearAppBadge: () => calls.push(['clear']) },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'document', {
    value: { addEventListener() {}, visibilityState: 'hidden' }, configurable: true,
  });
  return calls;
};

// A mock Storage whose Nth getItem first applies a scripted cross-tab commit -
// that is the interleaving localStorage allows between two statements.
const scriptedStorage = ({ initial = null, commitAtRead = null, commitTo = null } = {}) => {
  const map = new Map();
  if (initial !== null) map.set('airhorn:blast-count', String(initial));
  let reads = 0;
  return {
    map,
    getItem(k) {
      reads++;
      if (commitAtRead === reads && commitTo !== null) map.set('airhorn:blast-count', String(commitTo));
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) { map.set(k, v); },
    removeItem(k) { map.delete(k); },
  };
};

const count = (storage) => {
  const raw = storage.map.get('airhorn:blast-count');
  return raw === undefined ? null : Number(raw);
};

const settle = () => new Promise((r) => setTimeout(r, 0));

let BlastBadge;
test.before(async () => {
  ({ BlastBadge } = await import('../src/badge.js'));
});

test('(e) single-tab path: two sequential blasts store 2 and badge 2', async () => {
  const storage = scriptedStorage();
  const calls = installDom(storage);
  const badge = new BlastBadge();
  badge.blast(); await settle();
  badge.blast(); await settle();
  assert.equal(count(storage), 2);
  assert.deepEqual(calls.filter(([op]) => op === 'set').map(([, n]) => n), [1, 2]);
});

test('(a) a stale writer over a fresher committed 9 builds on it: 10, never 6', async () => {
  // Read order in the fixed code: constructor's boot derive (1), then blast's
  // entry count (2), epoch (3), epoch inside bump (4), now (5), FRESH (6), then
  // the write. Inject the other tab's commit (9) at the FRESH read - the read
  // the merge exists for. A revert that drops the fresh read makes only 5
  // reads, so no commit fires and the entry-5 bump writes 6: RED.
  const storage = scriptedStorage({ initial: 5, commitAtRead: 6, commitTo: 9 });
  installDom(storage);
  const badge = new BlastBadge();
  badge.blast(); await settle();
  assert.equal(count(storage), 10,
    'a stale writer reduced or ignored the fresher committed count - the merge is gone or broken');
});

test('(b) concurrent bumps are all counted: 5 + 2 + 1 = 8', async () => {
  const storage = scriptedStorage({ initial: 5 });
  installDom(storage);
  const a = new BlastBadge();
  const b = new BlastBadge();
  b.blast(); b.blast(); await settle();
  a.blast(); await settle();
  assert.equal(count(storage), 8, 'a blast was lost between concurrent tabs');
});

test('(c) the wrap world: 99 + concurrent bump stores 101, badge shows 99', async () => {
  const storage = scriptedStorage({ initial: 99 });
  const calls = installDom(storage);
  const badge = new BlastBadge();
  badge.blast(); await settle();
  assert.equal(count(storage), 100, 'the stored count must not wrap - a wrap reads a later value as stale-lower');
  badge.blast(); await settle();
  assert.equal(count(storage), 101);
  const sets = calls.filter(([op]) => op === 'set').map(([, n]) => n);
  // Boot derives and displays the stored 99 too, so the first set is the boot's.
  assert.deepEqual(sets, [99, 99, 99], 'the badge display is capped at 99 while the count stays exact');
});

test('(d) acknowledge() clears the count and the OS badge', async () => {
  const storage = scriptedStorage({ initial: 7 });
  const calls = installDom(storage);
  const badge = new BlastBadge();
  badge.acknowledge(); await settle(); await settle();
  assert.equal(count(storage), null, 'acknowledge left a count behind');
  assert.ok(calls.some(([op]) => op === 'clear'), 'acknowledge never cleared the OS badge');
});


/* airhorn-qfxp: scenario F's acknowledge must WAIT for the other tab to observe the clear -
 * a single synchronous cross-tab storage read right after B's clear races asynchronous
 * propagation and flakes the full gate (32wa, 2026-11-09: B=null A2="1" with B's clearAppBadge
 * already in the spy log). The fix is the same lesson as airhorn-wzcw's blast-count write:
 * waitUntil, not a one-shot read. This pin fails if the acknowledge block ever goes back to
 * reading A2's storage once. */
test('multitab scenario F waits for the cross-tab clear to propagate (airhorn-qfxp)', () => {
  const src = fs.readFileSync(path.join(root, 'tests', 'multitab.test.mjs'), 'utf8');
  const fStart = src.indexOf('--- F. returning to a tab acknowledges the shared badge');
  const gStart = src.indexOf('--- G. a tab that cannot read storage');
  assert.ok(fStart > 0 && gStart > fStart, 'scenario F block must be locatable');
  const block = src.slice(fStart, gStart);
  const readIdx = block.indexOf("const aStorage =");
  assert.ok(readIdx > 0, 'the acknowledge block still reads A2 storage');
  const before = block.slice(0, readIdx);
  assert.ok(/waitUntil\(async \(\) =>[\s\S]{0,400}localStorage\.getItem\('airhorn:blast-count'\)[\s\S]{0,200}=== null/.test(before),
    'the A2 read must be preceded by a waitUntil that observes the cleared (null) value - ' +
    'a one-shot read races cross-tab localStorage propagation (airhorn-qfxp, same lesson as airhorn-wzcw)');
});


/* airhorn-u9cd: the two sibling one-shot reads in multitab get the same treatment - the raw
 * write must be OBSERVED through a wait, and the two-blast settle must allow for propagation
 * lag. Both success conditions are monotone (a lost blast or an ineffective raw write never
 * appears), so the waits cannot mask a real failure. */
test('multitab observes cross-tab writes through bounded waits, not one-shot reads (airhorn-u9cd)', () => {
  const src = fs.readFileSync(path.join(root, 'tests', 'multitab.test.mjs'), 'utf8');
  const rawIdx = src.indexOf("localStorage.setItem('airhorn:blast-count', '1')");
  assert.ok(rawIdx > 0, 'the raw-write step must be locatable');
  const around = src.slice(rawIdx, rawIdx + 1200);
  assert.ok(/waitUntil\(async \(\) =>[\s\S]{0,400}getItem\('airhorn:blast-count'\)[\s\S]{0,120}=== 1/.test(around),
    'the raw write must be observed through a waitUntil before the assert (one-shot reads race propagation, airhorn-u9cd)');
  assert.ok(/two blasts[\s\S]{0,0}/.test(src) && /return n === before \+ 2 \? n : null;\n      \}, 20000\)/.test(src),
    'the two-blast settle window must be 20s - 5s expired under gate load on a value that arrived late (airhorn-u9cd)');
});


/* airhorn-sdzb: the third member of the family - webmcp-browser must wait for the badge
 * write (async behind the origin lock) before slicing the spy. */
test('webmcp-browser waits for the lock-serialized badge write before slicing the spy (airhorn-sdzb)', () => {
  const src = fs.readFileSync(path.join(root, 'tests', 'webmcp-browser.test.mjs'), 'utf8');
  const sliceIdx = src.indexOf('badge: window.__badge.calls.slice()');
  assert.ok(sliceIdx > 0, 'the badge slice must be locatable');
  const before = src.slice(Math.max(0, sliceIdx - 1200), sliceIdx);
  assert.ok(/__waitFor\(\(\) => window\.__badge\.calls\.length > 0/.test(before),
    'the badge slice must be preceded by a waitFor on calls.length - the write is async behind the origin lock ' +
    '(airhorn-sdzb, same lesson as airhorn-qfxp / airhorn-u9cd)');
});
