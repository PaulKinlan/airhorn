/*
 * tests/cdp-command-bound.mjs — a CDP command is WAITED FOR WITH A BOUND (airhorn-uhdv).
 *
 * It lives HERE, not in tests/support/, on purpose: the map sends every
 * tests/support/** change to all fifteen browser suites at once (a shared support
 * module really can affect them all), and this helper has exactly one consumer -
 * measured: with the module under tests/support/ the fast gate selected 19 suites
 * and was killed at its 900 s bound having run a fraction of them
 * (airhorn-uhdv). A suite-local helper is mapped to its own consumers instead.
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

/**
 * The composition every consumer uses: start the command against its own pending
 * table, race it against the bound, and clear the timer once it settles.
 *
 * It lives here, rather than inlined in the suite, so that "a command that is
 * bounded out leaves NOTHING behind" is a property the unit test can hold: if the
 * cleanup wiring is dropped, the dead entry stays in the suite's pending table
 * forever and the test fails. A test that only counts an isolated onTimeout
 * callback would keep passing (airhorn-uhdv review).
 *
 * @param {object} options
 * @param {string} options.method           the CDP method, named in the failure
 * @param {Map} options.pending             the suite's id -> { resolve, reject } table
 * @param {number|string} options.id        this command's id in that table
 * @param {() => void} options.fire         sends the command; the reply settles the entry
 * @param {number} [options.timeoutMs]      how long to wait (default CDP_COMMAND_TIMEOUT_MS)
 * @returns {Promise<any>} the reply's value, or a rejection naming the method
 */
export function boundCommand({ method, pending, id, fire, timeoutMs }) {
  const answered = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    fire();
  });
  const bound = commandBound({ method, timeoutMs, onTimeout: () => pending.delete(id) });
  return Promise.race([answered, bound.promise]).finally(bound.clear);
}

/**
 * Opening the page's CDP socket is WAITED FOR WITH A BOUND too (airhorn-2q3m).
 *
 * `const ws = new WebSocket(url); await new Promise(r => ws.onopen = r)` is the
 * same defect one step earlier than the command bound: nothing inside the suite
 * exists yet, so no deadline of the suite's can fire, and a socket that neither
 * opens nor errors parks the suite for the rest of the gate. The unbounded await
 * is also blind to the two ways the open can FAIL - `error` and `close` - so the
 * reason (a launch that never produced a page target, a socket the browser
 * refused) is lost.
 *
 * This settles once, whatever happens first: open resolves, error/close reject
 * with the reason, and the bound rejects naming the socket if neither arrives.
 *
 * @param {WebSocket} ws                    the socket, already constructed
 * @param {object} [options]
 * @param {string} [options.url]            the socket's URL, named in the failure
 * @param {number} [options.timeoutMs]      how long to wait (default CDP_COMMAND_TIMEOUT_MS)
 * @returns {Promise<void>} resolves when the socket is open
 */
export function awaitSocketOpen(ws, { url = ws?.url || 'page target', timeoutMs = CDP_COMMAND_TIMEOUT_MS } = {}) {
  if (ws?.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.onopen = null;
      ws.onerror = null;
      ws.onclose = null;
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(
      `CDP socket ${url} did not open within ${timeoutMs} ms (airhorn-2q3m)`
    )), timeoutMs);
    ws.onopen = () => finish(null);
    ws.onerror = (event) => finish(new Error(
      `CDP socket ${url} failed to open: ${event?.message || event?.error?.message || 'error'} (airhorn-2q3m)`
    ));
    ws.onclose = (event) => finish(new Error(
      `CDP socket ${url} closed before it opened (code ${event?.code ?? 'unknown'}) (airhorn-2q3m)`
    ));
  });
}
