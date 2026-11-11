/*
 * The verdict for an offline asset request, pure so BOTH directions can be pinned browser-free
 * (airhorn-g0qr.2, from the assertion sweep's g0qr map row sw-offline:517).
 *
 * The defect this replaces: the offline suite asserted `body !== GARBAGE`, which is satisfied by an
 * EMPTY body and by any bare 503 - i.e. by "nothing at all" - so the one assertion that exists to
 * prove the worker refuses bytes it cannot vouch for passed for a worker that returned nothing.
 *
 * The worker has exactly two legitimate outcomes here, and each must carry evidence that it is that
 * outcome (public/sw.js:459 is where the refusal sentence is authored):
 *
 *   REAL      the verified asset, BYTE-IDENTICAL to what the cache held while online
 *   REFUSAL   status 503 carrying the worker's own refusal sentence
 *
 * Everything else is rejected BY NAME, so a failure reads as the shape it actually is instead of as
 * a string comparison that happened to hold.
 */

export const OFFLINE_REFUSAL_SENTENCE = 'The Air Horner could not load this part of itself.';

/**
 * @param {{ online?: {status?: number, body?: string}, offline?: {status?: number, body?: string}, refusal?: string }} input
 * @returns {{ok: true, how: 'real' | 'refusal'} | {ok: false, why: string}}
 */
export function offlineAssetVerdict({ online, offline, refusal = OFFLINE_REFUSAL_SENTENCE } = {}) {
  const status = offline && typeof offline.status === 'number' ? offline.status : null;
  const body = offline && typeof offline.body === 'string' ? offline.body : null;
  const onlineBody = online && typeof online.body === 'string' ? online.body : null;

  // A fetch that could not complete at all, or an answer with no readable body, is not evidence of
  // a refusal - the shapes below are the only ones that are.
  if (status === null || status === 0) return { ok: false, why: 'no-response' };
  if (body === null) return { ok: false, why: 'no-readable-body' };

  if (status === 200) {
    if (body.length === 0) return { ok: false, why: 'empty-body' };
    if (onlineBody === null) return { ok: false, why: 'no-online-baseline' };
    if (body !== onlineBody) return { ok: false, why: 'not-the-real-bundle' };
    return { ok: true, how: 'real' };
  }

  if (status === 503) {
    // The status alone is not the refusal: an empty 503 is the "returned nothing" shape this pin
    // exists to reject. The worker's own sentence is what makes it a refusal on purpose.
    if (!body.includes(refusal)) return { ok: false, why: 'bare-503-without-the-refusal-sentence' };
    return { ok: true, how: 'refusal' };
  }

  return { ok: false, why: `unexpected-status-${status}` };
}
