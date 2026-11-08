/*
 * Observed quiescence for the browser tests.
 *
 * The browser suites used to finish with a fixed `setTimeout(..., 800)` and then
 * read `window.__pageErrors` once. That is a magic constant, so an asynchronous
 * throw that lands just after it (900ms, 1.9s, 5s after the last interaction)
 * silently passed — the assertion only ever covered the window, not the page.
 *
 * Instead of guessing how long to wait, the page is instrumented so the work it
 * has deferred is *visible*: outstanding timers, intervals and fetches are
 * counted, and the test waits until that count is zero and stays zero for a few
 * consecutive samples. A page that schedules anything during the wait keeps the
 * test waiting; a page that never drains fails the wait with its pending work.
 * Errors recorded while waiting are then asserted on as before.
 *
 * Scope, deliberately: timers, intervals and fetches are what this app defers
 * work with (the sample fetch, the horn's stop fallback and the pointer/key
 * release reset). Promise/microtask-only work settles between samples, which is
 * why the wait requires several consecutive quiet samples rather than one.
 *
 * Usage:
 *   await send('Page.addScriptToEvaluateOnNewDocument', {
 *     source: `<existing page-error probe>${quiescenceProbe}`,
 *   });
 *   ...
 *   const settled = await waitForQuiescence(send, {
 *     quietExpression: `!document.querySelector('.horn.horning')`,
 *   });
 *   console.log(`page quiescent after ${settled.waitedMs}ms`);
 */

/**
 * Instrumentation to install *before* any page script runs, so the app's own
 * timers and fetches are captured. Append it to the suite's existing
 * `__pageErrors` probe; it exposes `window.__quiescence`.
 */
export const quiescenceProbe = `
  (() => {
    // Capture the native functions first: this probe's own internals (and any
    // other test instrumentation) must not be counted as page work.
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    const nativeFetch = window.fetch ? window.fetch.bind(window) : null;

    const state = {
      pendingTimers: 0,
      pendingIntervals: 0,
      pendingFetches: 0,
      lastActivity: 0,
      scheduled: 0,
      completed: 0,
    };
    window.__quiescence = state;

    const touch = () => {
      state.lastActivity = performance.now();
    };

    const timeouts = new Set();
    const intervals = new Set();

    window.setTimeout = function (handler, delay, ...args) {
      if (typeof handler !== 'function') {
        return nativeSetTimeout(handler, delay, ...args);
      }
      state.scheduled += 1;
      const id = nativeSetTimeout(function () {
        timeouts.delete(id);
        state.pendingTimers -= 1;
        state.completed += 1;
        touch();
        return handler.apply(this, args);
      }, delay);
      timeouts.add(id);
      state.pendingTimers += 1;
      touch();
      return id;
    };

    window.clearTimeout = function (id) {
      if (timeouts.delete(id)) {
        state.pendingTimers -= 1;
        state.completed += 1;
        touch();
      }
      return nativeClearTimeout(id);
    };

    window.setInterval = function (handler, delay, ...args) {
      if (typeof handler !== 'function') {
        return nativeSetInterval(handler, delay, ...args);
      }
      state.scheduled += 1;
      const id = nativeSetInterval(function () {
        touch();
        return handler.apply(this, args);
      }, delay);
      intervals.add(id);
      state.pendingIntervals += 1;
      touch();
      return id;
    };

    window.clearInterval = function (id) {
      if (intervals.delete(id)) {
        state.pendingIntervals -= 1;
        state.completed += 1;
        touch();
      }
      return nativeClearInterval(id);
    };

    if (nativeFetch) {
      window.fetch = function (...args) {
        state.pendingFetches += 1;
        state.scheduled += 1;
        touch();
        return nativeFetch(...args).finally(() => {
          state.pendingFetches -= 1;
          state.completed += 1;
          touch();
        });
      };
    }

    // The native entry points stay reachable for test instrumentation that must
    // not be mistaken for page work (e.g. a sampling interval).
    window.__nativeWork = { setTimeout: nativeSetTimeout, setInterval: nativeSetInterval };
  })();
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the page has no outstanding timers, intervals or fetches, and any
 * caller-supplied quiet condition holds, for `stableSamples` consecutive
 * samples.
 *
 * @param {(method: string, params?: object) => Promise<any>} send CDP send()
 * @param {object} [options]
 * @param {number} [options.timeoutMs] Ceiling on the wait LOOP, checked BETWEEN
 *   samples - not an absolute bound on the whole wait (airhorn-ynvv: the doc used
 *   to claim 'ABSOLUTE CEILING', which is false: one sample is a single
 *   Runtime.evaluate round-trip bounded only by the caller's send, so a hung or
 *   starved sample overshoots the ceiling arbitrarily; the guarantee is that the
 *   wait ends within timeoutMs of the last COMPLETED sample, and a slow-sample
 *   world is pinned in tests/quiescence-bound.test.js). A wall clock cannot tell
 *   "still working" from "starved": on a loaded host a single Runtime.evaluate
 *   round-trip can take seconds, so a fixed 20 s bound failed a page that was
 *   ALREADY quiet and printed "work is still pending" next to a probe showing
 *   zero pending. The criterion is `stableSamples` consecutive quiet samples;
 *   the ceiling only stops an unwinnable wait, and it is generous enough for a
 *   starved host to still reach quiescence.
 * @param {number} [options.stableSamples] consecutive quiet samples required
 * @param {number} [options.pollMs] gap between samples
 * @param {string} [options.quietExpression] extra in-page boolean expression
 *   that must also hold (e.g. the horn is not sounding)
 * @param {number} [options.stateTimeoutMs] how long the quiet condition may stay
 *   false after the page's own work has drained before the wait fails with a
 *   diagnosis. Pending work is observable; app state is not always (an audio
 *   pipeline whose 'ended' event never fires cannot be waited out), so this is
 *   a separate, short bound: it turns an unwinnable wait into a fast, specific
 *   failure instead of a slow generic timeout (airhorn-10q).
 * @returns {Promise<{waitedMs: number, samples: number, pending: object}>}
 */
export async function waitForQuiescence(send, {
  timeoutMs = 120000,
  stableSamples = 4,
  pollMs = 50,
  quietExpression = 'true',
  stateTimeoutMs = 5000,
} = {}) {
  const started = Date.now();
  let stable = 0;
  let samples = 0;
  let last = null;
  let drainedAt = null;
  // Observable progress, so the ceiling can say WHICH situation it hit instead of
  // guessing (airhorn-ypfn). Two samples with an identical signature are two
  // round-trips in which nothing the page reports changed.
  let lastSignature = null;
  let noProgressSamples = 0;
  let sawQuietSample = false;

  while (Date.now() - started < timeoutMs) {
    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const q = window.__quiescence;
        if (!q) return { probe: 'missing' };
        return {
          probe: 'present',
          pendingTimers: q.pendingTimers,
          pendingIntervals: q.pendingIntervals,
          pendingFetches: q.pendingFetches,
          scheduled: q.scheduled,
          completed: q.completed,
          quietCondition: Boolean(${quietExpression}),
        };
      })()`,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error('Quiescence probe failed: ' +
        (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
    }

    last = result.result.value;
    samples += 1;
    const signature = JSON.stringify([
      last.pendingTimers, last.pendingIntervals, last.pendingFetches,
      last.scheduled, last.completed, last.quietCondition,
    ]);
    if (signature === lastSignature) noProgressSamples += 1;
    else { lastSignature = signature; noProgressSamples = 0; }

    if (last.probe !== 'present') {
      throw new Error(
        'Quiescence probe is missing: install `quiescenceProbe` before the page scripts run.',
      );
    }

    const workDrained = last.pendingTimers === 0 &&
      last.pendingIntervals === 0 &&
      last.pendingFetches === 0;
    const quiet = workDrained && last.quietCondition;

    if (workDrained && !last.quietCondition) {
      // Nothing is pending, so waiting longer cannot change the outcome on its
      // own: the state this wait depends on is app state that never reached its
      // end condition. Give it a short grace period (it may be one frame away),
      // then fail with the cause rather than burning the whole timeout.
      if (drainedAt === null) drainedAt = Date.now();
      if (stateTimeoutMs > 0 && Date.now() - drainedAt >= stateTimeoutMs) {
        let appState = null;
        try {
          const probe = await send('Runtime.evaluate', {
            expression: `(() => ({
              isPlaying: typeof window.__airhorn?.isPlaying === 'function' ? window.__airhorn.isPlaying() : null,
              horning: Boolean(document.querySelector('.horn')?.classList.contains('horning')),
            }))()`,
            returnByValue: true,
          });
          appState = probe.result?.value ?? null;
        } catch {}
        throw new Error(
          `Page work drained, but the state this wait depends on stayed false for ` +
          `${stateTimeoutMs}ms (${Date.now() - started}ms waited in total) ` +
          `(condition \`${quietExpression}\`, ${JSON.stringify(last)}, app state ${JSON.stringify(appState)}). ` +
          `Nothing is pending, so this is app state that never reached its end condition - ` +
          `typically an audio pipeline whose 'ended' event does not fire on this machine ` +
          `(headless audio that never progresses), not a page that is still working.`,
        );
      }
    } else {
      drainedAt = null;
    }

    if (quiet) sawQuietSample = true;
    stable = quiet ? stable + 1 : 0;
    if (stable >= stableSamples) {
      return { waitedMs: Date.now() - started, samples, pending: last };
    }

    await sleep(pollMs);
  }

  // The ceiling is a backstop, so the message must not invent a cause. Three
  // distinguishable situations, named rather than merged into "still pending":
  const probe = JSON.stringify(last);
  const pending = last && last.pendingTimers === 0 && last.pendingIntervals === 0 && last.pendingFetches === 0;
  const why = pending
    ? sawQuietSample
      ? `the page WAS quiet but the sampler only completed ${samples} round-trip(s) (${noProgressSamples} with no change) ` +
        `before the ceiling - a starved host, not a busy page; raise timeoutMs or lower stableSamples/pollMs`
      : `the page's work had drained but the quiet condition never held, and the state grace period did not fire`
    : noProgressSamples >= stableSamples
      ? `nothing the page reports changed across ${noProgressSamples + 1} consecutive samples, so this is a page that is not progressing rather than a host that is merely slow`
      : `the page kept changing across ${samples} samples, so it is still doing work, not merely starved`;
  throw new Error(
    `Page never reached quiescence within the ${timeoutMs}ms absolute ceiling ` +
    `(${probe}, ${samples} samples, ${noProgressSamples} consecutive with no change): ${why}. ` +
    `Quiescence needs ${stableSamples} consecutive quiet samples; the ceiling is a backstop, not the criterion (airhorn-ypfn).`,
  );
}

/**
 * Scheduling hook for proving the wait really is a boundary: registers an
 * asynchronous throw `delayMs` after the call, in the page, through the very
 * same timer the app would use. Only used by the suite's demonstrated mutant
 * (see `TEST_LATE_ERROR_MS` in the tests), never in a normal run.
 */
export function lateErrorMutant(delayMs) {
  return `setTimeout(() => { throw new Error('late mutant: deliberate async throw ${delayMs}ms after the last interaction'); }, ${delayMs}); true`;
}
