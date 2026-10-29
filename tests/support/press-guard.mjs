/*
 * tests/support/press-guard.mjs — the trusted-press guard for resilience-ui
 * Case 7 (airhorn-0ghk, airhorn-fl70, airhorn-8wh1, airhorn-l2c3).
 *
 * Case 7 proves "the unstyled horn still responds" by dispatching a TRUSTED
 * press (Input.dispatchMouseEvent) and watching the document-start record of
 * the pressed transition. Three failure shapes must never be confused, because
 * they blame different owners:
 *
 *   - the press point is not over the horn: the TEST's coordinates are wrong
 *     (the unstyled page is tall prose and the control can sit below the fold,
 *     airhorn-uhdv). Validated identically for the first press and every retry
 *     (airhorn-8wh1): a retry that lands off the horn proves nothing, and
 *     reporting host contention for it misnames a coordinate problem as a
 *     machine fault.
 *   - the input log is absent or unreadable: the INSTRUMENT is broken
 *     (airhorn-l2c3). Unknown - not machine, not product - and it must fail
 *     fast, never retry: retrying an unreadable press would let an
 *     app-ignored press become invisible again (airhorn-fl70).
 *   - the log is EMPTY after a timeout: the trusted press was dropped before
 *     it reached the page - host contention, the machine's fault - and a
 *     re-dispatch is honest (airhorn-0ghk).
 *   - the log is NON-empty after a timeout: events reached the page and the
 *     horn stayed unpressed - the app ignored a trusted press, the product
 *     bug the case exists to catch. It fails on that attempt; the pre-retry
 *     code could not pass such an app and neither may this one
 *     (airhorn-fl70).
 *
 * Why this is a module rather than lines in the suite: the guard exists for
 * its failure paths, and a real CDP surface will not refuse a Runtime.evaluate
 * or move a horn on demand. The only way to exercise them is to call these
 * functions with inputs that fail on purpose - which is what
 * tests/press-guard.test.mjs does, including mutated copies of this file that
 * show the pre-airhorn-8wh1 retry (no re-check) and the pre-airhorn-l2c3
 * classification (unreadable folded into "dropped") misreporting. A copy of
 * the logic pasted into a scratch script proves something about the copy, and
 * cannot notice this file rotting.
 */

/**
 * Validate a measured press point. Called for the FIRST measurement and for
 * EVERY re-measurement before a retry, so an off-horn press is never
 * dispatched and never later reported as dropped delivery (airhorn-8wh1).
 *
 * @param {object} box the getHornBox() reading: { found, overHorn, x, y, hit, ... }
 * @param {string} label which press point this is ('the press point',
 *   'the retried press point (attempt 2/3)'), so the failure names itself
 * @throws if the horn is absent or the point is not over it
 */
export const checkPressPoint = (box, label) => {
  if (!box.found || !box.overHorn) {
    throw new Error(`${label} is not over the horn, so the press would prove nothing: ${JSON.stringify(box)}`);
  }
};

/**
 * Read the page's input log. Resolves to the log array, or to the string
 * 'unreadable' when the instrument cannot be judged - a missing
 * window.__inputLog (the document-start hook never ran) or a rejected
 * evaluate (starved CDP, document gone). Never collapses to an empty array:
 * empty means "no pointer event reached the page", and an unread instrument
 * must not read as that (airhorn-l2c3).
 */
export const readInputLog = (evaluate) => evaluate('window.__inputLog').then(
  (v) => (Array.isArray(v) ? v : 'unreadable'),
  () => 'unreadable');

/**
 * Classify a timed-out trusted press from the readInputLog result.
 *   'unreadable'          -> the instrument broke; unknown, fail fast, no retry
 *   'delivered-unpressed' -> events reached the page, horn stayed false:
 *                            the product bug; fail fast, no retry (airhorn-fl70)
 *   'dropped'             -> no event reached the page: host contention;
 *                            the ONLY shape a retry may follow (airhorn-0ghk)
 */
export const classifyPressTimeout = (inputLog) => {
  if (inputLog === 'unreadable') return 'unreadable';
  if (inputLog.length > 0) return 'delivered-unpressed';
  return 'dropped';
};
