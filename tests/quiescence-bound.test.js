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
  const slow = await waitForQuiescence(sender(100, () => quiet));
  assert.equal(slow.samples, 4, 'a slower sampler does not change the criterion');
  // 4 x 90ms nominal difference, asserted at 4 x 60: the 120ms slack absorbs timer jitter on a starved
  // host (the old 10ms-vs-40ms pair asserted 80 of a nominal 120 and flaked when both samplers
  // overslept by load-dependent amounts - the SHAPE is relative, so widening the gap keeps it
  // machine-independent). Oversleeping only ADDS to each sampler, so the slack is one-sided.
  assert.ok(slow.waitedMs - fast.waitedMs >= 4 * 60,
    `the 90ms-per-sample difference must show up in the wait (fast ${fast.waitedMs}ms, slow ${slow.waitedMs}ms): the wait is the sampling it did, not a fixed margin around it`);
});

test('a STARVED host still reaches quiescence when the ceiling allows it - the same sampler, two ceilings', async () => {
  // 300 ms per round-trip: four samples need ~1.2 s. The ONLY difference is the ceiling.
  const starved = () => sender(300, () => quiet);
  const settled = await waitForQuiescence(starved(), { timeoutMs: 5000 });
  assert.equal(settled.samples, 4, 'a slow host must not turn a quiet page into a failure');
  assert.ok(settled.waitedMs >= 1000, `the wait really did spend the starved time (${settled.waitedMs}ms)`);

  // ...and a ceiling FAR below the sampling cost fails nothing either (airhorn-ypfn): the page is
  // quiet, so every completed quiet sample is observed progress and the criterion - not a clock -
  // decides. Four 300ms samples need ~1.2s against a 400ms caller ceiling; under the old DOUBLED
  // backstop (800ms) this exact call THREW "the page WAS quiet...a starved host". It passes now, and
  // the pass carries NAME-ABLE evidence: the sample count is the criterion, the waited time is the
  // sampling it really did.
  const belowCost = await waitForQuiescence(starved(), { timeoutMs: 400 });
  assert.equal(belowCost.samples, 4, 'a quiet page outlives any caller ceiling: the criterion decides');
  assert.ok(belowCost.waitedMs >= 1100, `the starved sampling was really paid (${belowCost.waitedMs}ms)`);
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
  // The attribution must not depend on how many samples fit inside the ceiling (airhorn-a1c8). A page
  // that reports the SAME signature on every sample has shown no change at all, and that is absolute
  // evidence however few round-trips the host completed - the arm used to require `stableSamples`
  // consecutive no-change samples, so on a starved host (two 150ms round-trips in a 400ms ceiling)
  // the identical page was named "kept changing ... still doing work, not merely starved", the exact
  // mis-attribution this suite exists to prevent, contradicting its own probe payload.
  const stuck = (ms) => () => sender(ms, () => ({ ...quiet, pendingTimers: 1, quietCondition: false }));
  const notProgressing = /not progressing rather than a host that is merely slow/;
  await assert.rejects(
    () => waitForQuiescence(stuck(150)(), { timeoutMs: 400 }),
    (error) => {
      assert.match(error.message, notProgressing, `a slow host cannot invent page progress: ${error.message}`);
      assert.match(error.message, /0 changed/, 'and the count of changes the page really showed is zero');
      assert.doesNotMatch(error.message, /kept changing|still doing work/, 'a page that never changed was not "still doing work"');
      return true;
    },
  );
  // ...and the SAME verdict with room for many samples: the sample count is not the evidence, the
  // absence of any change is, so a fast host and a starved host must agree here.
  await assert.rejects(() => waitForQuiescence(stuck(5)(), { timeoutMs: 400 }), notProgressing);
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
  // airhorn-jmpm: a caller-supplied ceiling SMALLER than the sampling cost no longer fails a page that is
  // already quiet - the criterion decides once the page has been observed quiet, so the same shape with a
  // flat 400ms pin now reaches quiescence too (it used to be the failure the bead removed).
  const flatPin = await waitForQuiescence(sender(200, () => quiet), a11yShape(400));
  assert.equal(flatPin.samples, 4, 'a flat small ceiling must not fail a quiet page on a slow host (airhorn-jmpm)');
  // ...but the ceiling still bounds a wait whose page never goes quiet.
  await assert.rejects(
    () => waitForQuiescence(sender(60, (n) => ({ ...quiet, quietCondition: false, pendingTimers: (n % 5) + 1 })), a11yShape(400)),
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
  // The page here NEVER goes quiet (airhorn-ypfn): a quiet page's slow sample completing is observed
  // progress, and progress reschedules the ceiling instead of firing it - the between-samples ceiling
  // is pinned on a page it legitimately bounds.
  const busy = (n) => ({ ...quiet, pendingTimers: (n % 5) + 1, quietCondition: false });
  const started = Date.now();
  await assert.rejects(
    () => waitForQuiescence(sender(2000, busy), { timeoutMs: 400, stateTimeoutMs: 0 }),
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
      // airhorn-xi86: the ratio must be the samples that WERE quiet, not samples-minus-no-progress (which is
      // always samples in this arm and produced the contradictory "held on 39 of 39 ... never on 4 in a row").
      const ratio = error.message.match(/held on (\d+) of (\d+) sample\(s\)/);
      assert.ok(ratio, `the flapping message must report a quiet-sample ratio: ${error.message}`);
      const [, held, total] = ratio.map(Number);
      assert.ok(held > 0 && held < total,
        `an alternating condition holds on SOME but not all samples, so the ratio must not be ${held} of ${total}`);
      assert.doesNotMatch(error.message, /starved host, not a busy page/,
        'and must not claim a starved host on the strength of one historical quiet sample');
      assert.doesNotMatch(error.message, /never held, and the state grace period did not fire/,
        'nor claim the condition never held - it held on every other sample');
      return true;
    },
  );
  // The discrimination control, redone for observed progress (airhorn-ypfn): an UNCHANGING quiet page
  // can no longer fail at all - its streak grows every sample - so the case that must not be called
  // flapping is now a condition stuck FALSE with the grace disabled: it fails as app state that never
  // held, and an unchanging page is never called flapping.
  await assert.rejects(
    () => waitForQuiescence(sender(20, () => ({ ...quiet, quietCondition: false })), { timeoutMs: 200, pollMs: 10, stateTimeoutMs: 0 }),
    (error) => {
      assert.match(error.message, /never held, and the state grace period did not fire/, 'a stuck-false condition is app state, not flapping');
      assert.doesNotMatch(error.message, /QUIET CONDITION is flapping/, 'and an unchanging page is never called flapping');
      return true;
    },
  );
});

test('a caller-supplied ceiling does not fail a QUIET page on a slow host (airhorn-jmpm)', async () => {
  // airhorn-ypfn's promise - "a quiet page on a loaded host reaches quiescence and passes" - only held for
  // callers that took the 120s default. a11y passes timeoutMs:15000 and soak/cache-growth 10000, so on a host
  // whose Runtime.evaluate round-trip costs 5s a page with ZERO pending work and quietCondition:true still
  // threw "never reached quiescence within the 15000ms ceiling". The ceiling is now the caller's bound only
  // while the page has not been seen quiet; after that the criterion decides, bounded by observed
  // progress: every new-longest quiet streak buys a fresh window (airhorn-ypfn).
  const slowButQuiet = await waitForQuiescence(sender(200, () => quiet), { timeoutMs: 400, pollMs: 10 });
  assert.equal(slowButQuiet.samples, 4, 'four quiet samples need ~800ms of sampling against a 400ms caller ceiling, and that is allowed');
  assert.ok(slowButQuiet.waitedMs >= 700, `the wait really did spend the sampling (${slowButQuiet.waitedMs}ms)`);

  // The backstop is OBSERVED PROGRESS, not a doubled clock (airhorn-ypfn): quiet samples whose
  // round-trips each outlive even 2 x timeoutMs keep buying fresh windows until the criterion is
  // met, so this passes too where the doubled backstop used to throw.
  const slower = await waitForQuiescence(sender(250, () => quiet), { timeoutMs: 100, pollMs: 10 });
  assert.equal(slower.samples, 4, 'four quiet samples against a 100ms ceiling: observed progress outlives any clock');
  assert.ok(slower.waitedMs >= 950, `the wait really did spend the starved sampling (${slower.waitedMs}ms)`);

  // A page that never goes quiet is still bounded by the caller's ceiling, not the doubled one.
  const started = Date.now();
  await assert.rejects(
    () => waitForQuiescence(sender(20, (n) => ({ ...quiet, quietCondition: false, pendingTimers: (n % 3) + 1 })), { timeoutMs: 300, pollMs: 10 }),
    /300ms ceiling \(checked between samples/,
  );
  assert.ok(Date.now() - started < 2000, 'the not-quiet bound fires at the caller ceiling');
});

test('the ceiling failure names the condition waited for, the samples that changed, and the elapsed time (airhorn-ypfn)', async () => {
  // "starved host" and "page never went quiet" were the recurring mis-attribution in this suite.
  // The failure must carry the facts that distinguish them BY NAME: which quiet condition the wait
  // was sampling, how many samples changed, and how long it actually waited.
  await assert.rejects(
    () => waitForQuiescence(
      sender(10, (n) => ({ ...quiet, pendingTimers: (n % 3) + 1, quietCondition: false })),
      { timeoutMs: 300, pollMs: 10, quietExpression: '!window.__hornSounding' },
    ),
    (error) => {
      assert.match(error.message, /condition `!window\.__hornSounding`/, 'names WHICH condition it was waiting for');
      assert.match(error.message, /after \d+ms and \d+ sample\(s\) \(\d+ changed/, 'names the elapsed time and the samples that changed');
      assert.match(error.message, /never observed quiet/, '"never went quiet" is said, distinguishable from a starved host');
      return true;
    },
  );
});

test('a quiet streak that plateaus below the criterion fails bounded, naming the plateau (airhorn-ypfn)', async () => {
  // quiet, quiet, busy, repeat: streaks of two never reach four. Under observed progress only the
  // FIRST new-longest streak buys a window, so the wait ends timeoutMs after that progress - not at
  // 2 x timeoutMs from the start, and never unbounded - and names the plateau it stalled at.
  const started = Date.now();
  const plateau = () => sender(5, (n) => ({ ...quiet, quietCondition: n % 3 !== 0 }));
  await assert.rejects(
    () => waitForQuiescence(plateau(), { timeoutMs: 200, pollMs: 5 }),
    (error) => {
      assert.match(error.message, /best quiet streak 2 of the 4 required/, `names the plateau it stalled at: ${error.message}`);
      // The deadline lands mid-pattern, so the honest attribution is one of two: the condition is
      // flapping (trailing samples all changed) or the streak stopped improving (trailing samples
      // repeated). What must never happen is the old lie - blaming the host.
      assert.match(error.message, /(streak stopped improving|QUIET CONDITION is flapping)/, `an honest attribution is named: ${error.message}`);
      assert.doesNotMatch(error.message, /a starved host/, 'and never blames the host for a page whose criterion is unreachable');
      return true;
    },
  );
  assert.ok(Date.now() - started < 3000, `the plateau wait is bounded by last progress + timeoutMs (${Date.now() - started}ms)`);
});
