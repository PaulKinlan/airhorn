// Pin for airhorn-gk2p: the lock spy must hold a lock until an ASYNC body SETTLES, not at
// callback return - Web Locks semantics. The old inline wrapper released in a try/finally,
// which for an async body fires at RETURN, so a write after the body's first await was
// recorded as unlocked: a genuine in-lock write accused falsely, and conversely a violation
// hidden. The spy under test is the SAME function the page gets (tests/support/lock-spy.mjs,
// interpolated into multitab's tabInstrumentation), driven here against a fake window.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installLockSpy } from './support/lock-spy.mjs';

const fakeWindow = () => {
  const calls = [];
  const window = {
    __heldLocks: [],
    navigator: {
      locks: {
        // A mock of Web Locks semantics: the lock is held until the body's promise settles.
        request(name, cb) {
          calls.push(name);
          return Promise.resolve(cb({ name }));
        },
      },
    },
    __calls: calls,
  };
  installLockSpy(window);
  return window;
};

const tick = () => new Promise((r) => setTimeout(r, 5));

test('a write after an await inside the lock body is recorded as INSIDE the lock (the gk2p world)', async () => {
  const window = fakeWindow();
  const writes = [];
  await window.navigator.locks.request('airhorn:blast-count', async () => {
    await tick();           // the body is still running - the lock is still held
    writes.push({ inLock: window.__heldLocks.includes('airhorn:blast-count') });
  });
  assert.deepEqual(writes, [{ inLock: true }],
    'a post-await write inside the body happens while the lock is held - releasing at return records it as unlocked (the defect)');
  assert.deepEqual(window.__heldLocks, [], 'the lock is released once the body settles');
});

test('a synchronous body still releases at return (no regression on the old shape)', async () => {
  const window = fakeWindow();
  const during = [];
  await window.navigator.locks.request('l', () => {
    during.push(window.__heldLocks.includes('l'));
  });
  assert.deepEqual(during, [true]);
  assert.deepEqual(window.__heldLocks, []);
});

test('a write OUTSIDE any lock is still recorded as unlocked (the accusation direction survives)', () => {
  const window = fakeWindow();
  assert.equal(window.__heldLocks.includes('airhorn:blast-count'), false);
});

test('a rejected async body still releases the lock', async () => {
  const window = fakeWindow();
  await assert.rejects(window.navigator.locks.request('l', async () => { await tick(); throw new Error('body failed'); }));
  assert.deepEqual(window.__heldLocks, [], 'release happens at settle, rejection included');
});
