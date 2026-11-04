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
