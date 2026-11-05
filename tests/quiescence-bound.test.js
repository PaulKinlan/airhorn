/*
 * tests/quiescence-bound.test.js — the bound on waitForQuiescence must not be wall clock (airhorn-ypfn)
 *
 * A fixed elapsed-time bound cannot distinguish "the page is still working" from "this host is
 * starved". Measured on origin/master 7fc8e19 with a stub CDP round-trip and a page that reported
 * ZERO pending work and a true quiet condition: with an 8 s round-trip the wait threw
 *   "Page never went quiet within 20000ms ({"pendingTimers":0,...,"quietCondition":true}):
 *    work is still pending"
 * i.e. it failed a page that was already quiet, and contradicted its own probe payload. With a
 * 6 s round-trip it passed at 24.2 s, so the bound was not even enforced as a ceiling on the
 * returned wait.
 *
 * These cases pin the criterion instead: `stableSamples` consecutive QUIET samples, with the
 * elapsed time kept only as a generous backstop that fails by NAME and never claims a cause the
 * probe contradicts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForQuiescence } from './support/quiescence.mjs';

const quiet = { probe: 'present', pendingTimers: 0, pendingIntervals: 0, pendingFetches: 0, scheduled: 5, completed: 5, quietCondition: true };

/** A CDP send() whose round-trip costs `ms`; the page state is whatever `page()` returns. */
const sender = (ms, page) => {
  let n = 0;
  return async () => {
    const value = page(n += 1);
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    return { result: { value } };
  };
};

test('a QUIET page passes on the sample count, not on a clock', async () => {
  const started = Date.now();
  const settled = await waitForQuiescence(sender(10, () => quiet));
  assert.equal(settled.samples, 4, 'four consecutive quiet samples is the criterion');
  assert.ok(Date.now() - started < 1000, 'and it does not wait for anything else');
});

test('a STARVED host still reaches quiescence when the ceiling allows it - the same sampler, two ceilings', async () => {
  // 300 ms per round-trip: four samples need ~1.2 s. The ONLY difference is the ceiling.
  const starved = () => sender(300, () => quiet);
  const settled = await waitForQuiescence(starved(), { timeoutMs: 5000 });
  assert.equal(settled.samples, 4, 'a slow host must not turn a quiet page into a failure');
  assert.ok(settled.waitedMs >= 1000, `the wait really did spend the starved time (${settled.waitedMs}ms)`);

  // ...and with a ceiling below the sampling cost it fails, NAMING the ceiling and the fact that
  // the page was quiet - never "work is still pending", which its own probe contradicts.
  await assert.rejects(
    () => waitForQuiescence(starved(), { timeoutMs: 400 }),
    (error) => {
      assert.match(error.message, /absolute ceiling/, 'the failure names the ceiling');
      assert.match(error.message, /WAS quiet/, 'and says the page was quiet, so the host was starved');
      assert.doesNotMatch(error.message, /work is still pending/, 'the old message is gone');
      return true;
    },
  );
});

test('a page that keeps changing never passes, and the ceiling says it was still working', async () => {
  // Pending work that changes every sample: this page is busy, not starved.
  const busy = () => sender(60, (n) => ({ ...quiet, pendingTimers: (n % 7) + 1, quietCondition: false }));
  await assert.rejects(
    () => waitForQuiescence(busy(), { timeoutMs: 400 }),
    (error) => {
      assert.match(error.message, /absolute ceiling/, 'names the ceiling');
      assert.match(error.message, /still doing work, not merely starved/, 'and distinguishes busy from starved');
      assert.doesNotMatch(error.message, /work is still pending/, 'the old message is gone');
      return true;
    },
  );
});

test('a page with NO observable progress is named as not progressing, not as slow', async () => {
  const stuck = () => sender(40, () => ({ ...quiet, pendingTimers: 1, quietCondition: false }));
  await assert.rejects(
    () => waitForQuiescence(stuck(), { timeoutMs: 400 }),
    (error) => {
      assert.match(error.message, /not progressing rather than a host that is merely slow/);
      return true;
    },
  );
});

test('the a11y call site shape has no flat wall-clock pin (airhorn-ixk1)', async () => {
  // a11y passes a quiet expression and the short STATE bound, and deliberately no `timeoutMs`
  // (airhorn-ixk1): with a 15 s pin, a quiet page costing 5 s per CDP round-trip failed while its
  // own probe showed zero pending work. Here the sampler is slow enough that a flat small pin
  // would fail it, and the wait must still reach quiescence on the sample criterion alone.
  const a11yShape = (ceiling) => ({
    quietExpression: `!document.querySelector('.horn.horning')`,
    stateTimeoutMs: 4000,
    ...(ceiling ? { timeoutMs: ceiling } : {}),
  });
  const settled = await waitForQuiescence(sender(200, () => quiet), a11yShape(null));
  assert.equal(settled.samples, 4, 'four quiet samples decide it');
  assert.ok(settled.waitedMs >= 700, `the sampler really was slow (${settled.waitedMs}ms)`);
  // the same shape WITH a flat pin smaller than the sampling cost is what the bead removed
  await assert.rejects(
    () => waitForQuiescence(sender(200, () => quiet), a11yShape(400)),
    /absolute ceiling/,
  );
});

test('the drained-but-not-quiet path keeps its short, specific failure', async () => {
  const drainedFalse = () => sender(5, () => ({ ...quiet, quietCondition: false }));
  await assert.rejects(
    () => waitForQuiescence(drainedFalse(), { stateTimeoutMs: 150, timeoutMs: 5000 }),
    (error) => {
      assert.match(error.message, /Page work drained, but the state this wait depends on stayed false/);
      return true;
    },
  );
});

test('a missing probe is still a hard error rather than a silent pass', async () => {
  await assert.rejects(
    () => waitForQuiescence(sender(0, () => ({ probe: 'missing' }))),
    /Quiescence probe is missing/,
  );
});
