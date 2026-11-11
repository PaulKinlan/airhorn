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
  const settled = await waitForQuiescence(sender(10, () => quiet));
  assert.equal(settled.samples, 4, 'four consecutive quiet samples is the criterion');
  assert.equal(settled.pending.pendingTimers, 0, 'and it passes on a page whose probe says nothing is pending');
  assert.equal(settled.pending.quietCondition, true, 'with the quiet condition actually true, not merely unexamined');
  // "it does not wait for anything else" is a claim about the WAIT, not about this host's clock
  // (airhorn-uxjo). It used to be `Date.now() - started < 1000`: a ~5x machine-speed margin on a
  // case whose only measured quantity was the sampler's own 4 x 10 ms cost. On the 24x-slow host
  // modelled in the bead the sampling still satisfied the criterion and only the clock failed -
  // i.e. the suite that exists to stop a starved host reddening suites was itself red on a starved
  // host. The shape pinned instead is RELATIVE, so host speed cancels out of both sides: a sampler
  // that costs 4x more per round-trip must make the wait proportionally longer, because the wait IS
  // the sampling and nothing else is added to it.
  const fast = await waitForQuiescence(sender(10, () => quiet));
  const slow = await waitForQuiescence(sender(40, () => quiet));
  assert.equal(slow.samples, 4, 'a slower sampler does not change the criterion');
  assert.ok(slow.waitedMs - fast.waitedMs >= 4 * 20,
    `the 30ms-per-sample difference must show up in the wait (fast ${fast.waitedMs}ms, slow ${slow.waitedMs}ms): the wait is the sampling it did, not a fixed margin around it`);
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
      assert.match(error.message, /ceiling \(checked between samples/, 'the failure names the ceiling');
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
      assert.match(error.message, /ceiling \(checked between samples/, 'names the ceiling');
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
    /ceiling \(checked between samples/,
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

test('the app-state attribution is reachable with a NORMAL stateTimeoutMs, not only when the grace is disabled (airhorn-eznc)', async () => {
  // The docstring used to say this branch was "reachable only with stateTimeoutMs = 0", which made it
  // read as nearly-dead code and hid the fact that it is the honest attribution for the common case.
  // It fires whenever the CEILING lands on a drained-but-not-quiet sample: here the page drains on the
  // first sample and the quiet condition never holds, so the in-loop grace throw (5 s) cannot run before
  // the 300 ms ceiling - exactly the case the review's repro showed, with a normal grace period.
  const drainedFalse = () => sender(5, () => ({ ...quiet, quietCondition: false }));
  await assert.rejects(
    () => waitForQuiescence(drainedFalse(), { timeoutMs: 300, pollMs: 40, stateTimeoutMs: 5000 }),
    (error) => {
      assert.match(error.message, /ceiling \(checked between samples/, 'the CEILING is what fired, not the grace period');
      assert.match(error.message,
        /the page's work had drained but the quiet condition never held, and the state grace period did not fire/,
        'and it attributes the failure to app state that never became true - not to pending work');
      assert.doesNotMatch(error.message, /work is still pending/, 'not the old catch-all');
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

test('ynvv: the ceiling is BETWEEN samples - one slow sample completes, then the ceiling fires, named (airhorn-ynvv)', async () => {
  // The doc used to claim an ABSOLUTE ceiling; the code checks the deadline at the top of
  // the loop, so a single 2s sample with a 400ms ceiling overshoots - and that is the
  // honest semantic: the wait ends within timeoutMs of the last COMPLETED sample.
  const started = Date.now();
  await assert.rejects(
    () => waitForQuiescence(sender(2000, () => quiet), { timeoutMs: 400, stateTimeoutMs: 0 }),
    /ceiling/,
    'after the slow sample completes, the ceiling must fire and be named',
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 1900, `the slow sample ran to completion before the ceiling fired (${elapsed}ms) - the ceiling is not absolute`);
  assert.ok(elapsed < 3000, `but it fired at the next loop check, not never (${elapsed}ms)`);
});

test('a FLAPPING quiet condition on a drained page is named as flapping, never as a starved host (airhorn-3a0k)', async () => {
  // The repro from the review: pending work is zero on every sample and the quiet condition alternates
  // true/false, so nothing changed the page is waiting on - the OBSERVATION keeps changing. The old
  // message said "a starved host, not a busy page" because it fired on ONE historical quiet sample,
  // contradicting its own probe (0 consecutive samples with no change). Never report a cause the probe
  // did not measure: this must say the condition is flapping.
  const flap = () => sender(5, (n) => ({ ...quiet, quietCondition: n % 2 === 0 }));
  await assert.rejects(
    () => waitForQuiescence(flap(), { timeoutMs: 400, pollMs: 10 }),
    (error) => {
      assert.match(error.message, /QUIET CONDITION is flapping, not the host starving/,
        `a condition that changes every sample must be named as flapping: ${error.message}`);
      assert.doesNotMatch(error.message, /starved host, not a busy page/,
        'and must not claim a starved host on the strength of one historical quiet sample');
      assert.doesNotMatch(error.message, /never held, and the state grace period did not fire/,
        'nor claim the condition never held - it held on every other sample');
      return true;
    },
  );
  // The control: an identical signature (the page's own state does not change between samples) is still
  // called a starved host when the ceiling cut the sampling short - so the new label is discriminating,
  // not just "every failing case is now flapping".
  await assert.rejects(
    () => waitForQuiescence(sender(200, () => ({ ...quiet })), { timeoutMs: 400, pollMs: 10 }),
    (error) => {
      assert.match(error.message, /a starved host, not a busy page/, 'an unchanging quiet page keeps its starved-host label');
      assert.doesNotMatch(error.message, /QUIET CONDITION is flapping/, 'and is not called flapping');
      return true;
    },
  );
});
