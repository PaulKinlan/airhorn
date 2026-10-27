/*
 * tests/support/cdp.mjs — a CDP command is WAITED FOR WITH A BOUND (airhorn-uhdv).
 *
 * The suites' `send()` returns a promise that settles only when the browser
 * answers. When the browser does not answer, that promise never settles - and
 * because the suites' polls (`waitUntil`/`waitForCondition`) await a command
 * before they can even look at their own deadline, nothing in the suite can
 * decide anything:
 *
 *   On the A+C union ea30ddf, tests/resilience-ui.test.mjs sat in 'Case 7
 *   stylesheet blocked' for 1,092,499 ms, and the eleven suites queued behind it
 *   in the gate were reported cancelled, never having run. One stuck resource
 *   cost the whole run and hid every later result.
 *
 * A waited-for CONDITION already has a bound (support/poll.mjs). This is the
 * other half: the COMMAND made while waiting for it. A command that does not
 * answer must fail, naming the method - which is the diagnostic a hung suite can
 * never produce - well inside the gate bound, so a stuck resource costs one case
 * instead of the run.
 *
 * The bound is a kill window, not a budget: it costs nothing when the browser
 * answers, and it is generous because a 2-core VM running several lanes' browser
 * suites makes ordinary round trips take seconds (measured on this box: 13 s for
 * a single Runtime.evaluate at load 10.5).
 */

// 30 s: roughly 2-3x the slowest ordinary round trip measured on this VM under
// multi-lane load, and 40x under the gate's 1200 s bound, so a wedged command is
// reported by the case that wedged it.
export const CDP_COMMAND_TIMEOUT_MS = Number(process.env.AIRHORN_CDP_MS) > 0
  ? Number(process.env.AIRHORN_CDP_MS)
  : 30000;

/**
 * A timer that rejects if the command it guards is not answered in time.
 *
 * Compose it with the suite's own pending-command table, so the timed-out entry
 * is dropped before the rejection is observed:
 *
 *   const answered = new Promise((resolve, reject) => {
 *     pending.set(id, { resolve, reject });
 *     ws.send(JSON.stringify({ id, method, params }));
 *   });
 *   const bound = commandBound({ method, onTimeout: () => pending.delete(id) });
 *   return Promise.race([answered, bound.promise]).finally(bound.clear);
 *
 * The timer is NOT unref'd on purpose: while a command is in flight the bound has
 * to be able to fire, and `clear()` runs as soon as the command settles (answered
 * or bounded), so it never outlives its command.
 *
 * @param {object} options
 * @param {string} options.method           the CDP method, named in the failure
 * @param {number} [options.timeoutMs]      how long to wait (default CDP_COMMAND_TIMEOUT_MS)
 * @param {() => void} [options.onTimeout]  cleanup to run before rejecting (drop the pending entry)
 * @returns {{ promise: Promise<never>, clear: () => void }}
 */
export function commandBound({ method, timeoutMs = CDP_COMMAND_TIMEOUT_MS, onTimeout } = {}) {
  let timer = null;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timer = null;
      try { onTimeout?.(); } catch {}
      reject(new Error(`CDP ${method} did not answer within ${timeoutMs} ms (airhorn-uhdv)`));
    }, timeoutMs);
  });
  return {
    promise,
    clear() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}
