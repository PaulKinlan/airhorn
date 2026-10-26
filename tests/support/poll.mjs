/*
 * tests/support/poll.mjs — wait for a CONDITION, never for the clock (airhorn-sesh).
 *
 * The browser suites used to give a UI transition a fixed 3 s (or a bare
 * sleep(300) then assert). That is a machine-state assertion: on a loaded box
 * the CDP round trip, the page's timer and the compositor all queue behind other
 * lanes, the transition lands late, and a correct app reads red - so a verdict
 * cannot be pinned on a busy VM even though nothing is wrong with the code.
 * docs/speed.md names this pathology: tests must not depend on machine state.
 *
 * The bound below is how long we are willing to WAIT for the condition, not a
 * claim about how long the app takes. It is deliberately generous, it costs
 * nothing on the happy path (polling stops the moment the condition holds), and
 * it is overridable (AIRHORN_WAIT_MS) so a suite can be exercised under
 * synthetic load without editing it.
 */

// 15 s: ~5x the tightest bound the suites used to assume, i.e. enough headroom
// for a 2-core VM running several lanes' browser suites at once (measured: the
// held-horn observation missed a 3 s window at load 10.3 - airhorn-sesh).
export const WAIT_TIMEOUT_MS = Number(process.env.AIRHORN_WAIT_MS) > 0
  ? Number(process.env.AIRHORN_WAIT_MS)
  : 15000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `check` until it returns something truthy, then return that value.
 *
 * @param {() => any|Promise<any>} check  returns the observed value; truthy = condition met.
 *   Careful: a measured 0 (or '') is FALSY and reads as "not met" - if the
 *   condition is "the level fell to zero", return a wrapper ({ level }) instead.
 * @param {object} [options]
 * @param {number} [options.timeout]      how long to keep waiting (default 15 s)
 * @param {number} [options.interval]     poll interval (default 50 ms)
 * @param {string} [options.label]        what we are waiting for, used in the failure
 * @param {() => any} [options.observe]   optional last-look value for the failure message
 * @throws {Error} when the condition never holds, naming the label and what was observed
 */
export async function waitForCondition(check, {
  timeout = WAIT_TIMEOUT_MS,
  interval = 50,
  label = 'condition',
  observe = check,
} = {}) {
  const started = Date.now();
  let last;
  let lastError = null;
  for (;;) {
    try {
      last = await check();
      lastError = null;
      if (last) return last;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() - started >= timeout) break;
    await sleep(interval);
  }
  const elapsed = Date.now() - started;
  let observed;
  try { observed = JSON.stringify(observe()); } catch { observed = '<unserializable>'; }
  const why = lastError ? `; last error: ${lastError.message}` : '';
  throw new Error(`timed out after ${elapsed} ms waiting for ${label} (bound ${timeout} ms); observed ${observed}${why}`);
}

export { sleep };
