/*
 * tests/support/bounds.mjs — steal-aware bounds for suites that spawn servers and
 * wait on real children (airhorn-dwbl).
 *
 * The 2026-10-28 full gate ran at 78-97% CPU steal and paid three non-refusal
 * failures that were machine, not product: two suites gave every fetch a fixed
 * AbortSignal.timeout(5000) and got a client-side TimeoutError from a server that
 * was correct but slow, and the cleanup-grace test measured spawn->exit against a
 * flat 3000ms. A genuine /health or README regression fails on a wrong status or
 * payload — never on how long a starved host took to answer. Same doctrine as the
 * launch preflight (airhorn-w1wh): the bound states the host's condition instead
 * of asserting a machine speed.
 *
 * The mechanics here, in the order the suites meet them:
 *
 *   hostStealOnce()  the fraction of ticks the hypervisor took, measured across
 *                    its own short windows — the REAL host, deliberately not
 *                    tools/lib/chrome.mjs's hostSteal(): that one honours
 *                    CHROME_STEAL_OVERRIDE, and suites that pin that seam for
 *                    launch determinism (test-support.test.js pins it to 0
 *                    file-wide) would otherwise have their waits read the pin
 *                    instead of the machine. Cached: the probe's windows cost
 *                    ~1s of synchronous sleep, and steal is a property that
 *                    persists for minutes, not one that turns over per call.
 *   stretchMs(base)  the base bound through stretchedBounds() — exactly the
 *                    1/(1-steal), capped-at-8x formula the launches already use,
 *                    so there is one stretch shape in the repo, not two.
 *   fetchUntil()     retry-with-deadline for a request to a server this suite
 *                    just spawned. Only transport-shaped failures retry (the
 *                    server is listening but the starved host answers slowly or
 *                    refuses mid-accept); ANY response comes back untouched on
 *                    the attempt that produced it, so a wrong payload fails its
 *                    assertion immediately, on attempt 1. Non-transport errors
 *                    (a bad URL, a caller bug) throw at once: they are not
 *                    something a slow host causes, and hiding them behind the
 *                    deadline would turn a suite bug into a mystery timeout.
 *
 * A healthy host (or an unknown reading) takes every base bound unchanged — no
 * behaviour change on a box that is not starved is the point, not a nicety.
 */

import { createStealProbe, stretchedBounds } from '../../tools/lib/chrome.mjs';

let cachedSteal;

export function hostStealOnce() {
  if (cachedSteal === undefined) {
    try {
      cachedSteal = createStealProbe().rate();
    } catch {
      cachedSteal = null; // unreadable host: unknown means "bounds unchanged"
    }
  }
  return cachedSteal;
}

// The base bound, stretched by the given (default: real, cached) steal reading.
export function stretchMs(baseMs, steal = hostStealOnce()) {
  return stretchedBounds({ timeoutMs: baseMs, discoveryMs: baseMs, steal }).timeoutMs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The failure shapes a slow-or-flaky server causes, which a retry can fix.
// AbortSignal.timeout surfaces as TimeoutError or AbortError depending on
// runtime; a server mid-accept shows up as connection refused/reset or an
// undici "terminated"/socket hang-up.
function transportFailure(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const code = err.cause?.code ?? err.code;
  if (['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true;
  return /terminated|socket hang up|other side closed/i.test(err.message ?? '');
}

export async function fetchUntil(url, init, {
  baseMs = 5000,
  steal,          // default: the real host reading, via stretchMs
  fetch: doFetch = fetch, // injectable: the unit tests drive a scripted fetch
  retryGapMs = 100,
} = {}) {
  const boundMs = stretchMs(baseMs, steal);
  const deadline = Date.now() + boundMs;
  let attempts = 0;
  let lastErr = null;
  for (;;) {
    attempts += 1;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        `no response from ${url} within ${boundMs}ms (base ${baseMs}ms, steal ` +
        `${JSON.stringify(steal ?? hostStealOnce())}) after ${attempts} attempt(s); ` +
        `last error: ${lastErr ? lastErr.message : 'none'}`);
    }
    try {
      // A response — good or bad — is an answer: the caller's assertions judge it.
      return await doFetch(url, { ...init, signal: AbortSignal.timeout(Math.min(baseMs, remaining)) });
    } catch (err) {
      if (!transportFailure(err)) throw err;
      lastErr = err;
      if (Date.now() >= deadline) {
        throw new Error(
          `no response from ${url} within ${boundMs}ms (base ${baseMs}ms, steal ` +
          `${JSON.stringify(steal ?? hostStealOnce())}) after ${attempts} attempt(s); ` +
          `last error: ${lastErr.message}`);
      }
      await sleep(retryGapMs);
    }
  }
}
