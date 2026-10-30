/**
 * Did the measurement actually happen?
 *
 * tools/measure-perf.mjs drives the horn by dispatching trusted CDP mouse events at
 * `.horn`'s centre. When the element was not found it skipped the input silently and
 * the report still rendered an INP row reading `None (0 events >=16ms)` - a page with
 * NO HORN was reported the same way as a page whose interaction was simply too fast to
 * register, and nothing anywhere said the click never happened (airhorn-nxuv.14).
 *
 * A missing measurement must be its own outcome, never a value that reads as healthy.
 * This module is that rule, pure, so both worlds can be proven without a browser.
 */

export const NO_TARGET_INP_LABEL = 'NOT MEASURED (.horn missing - interaction skipped)';
export const NO_EVENTS_INP_LABEL = 'None (0 events >=16ms, interaction dispatched)';

/**
 * @param {{ targetFound: boolean, events?: number, inp?: number|string|null }} observed
 *   `targetFound` is whether `.horn` existed on the page before dispatch;
 *   `events` is how many perf events the observer recorded; `inp` is the computed
 *   value when there was one.
 * @returns {{ measured: boolean, broken: boolean, inpLabel: string, reason: string }}
 */
export function interactionVerdict({ targetFound, events, inp } = {}) {
  if (targetFound !== true) {
    // Not "unknown": the tool looked, and the page did not have the control. That is
    // a broken page, and every INP number in this run is meaningless.
    return {
      measured: false,
      broken: true,
      inpLabel: NO_TARGET_INP_LABEL,
      reason: targetFound === false
        ? 'the page has no .horn element, so no interaction could be dispatched'
        : 'the page was never inspected for .horn, so no interaction was dispatched',
    };
  }
  const eventCount = typeof events === 'number' && Number.isFinite(events) ? events : null;
  if (eventCount === null) {
    return {
      measured: false,
      broken: true,
      inpLabel: NO_TARGET_INP_LABEL,
      reason: 'the interaction was dispatched but no event count was recorded, so INP is unmeasured',
    };
  }
  if (eventCount === 0) {
    // The click happened and produced no >=16ms event: a real, measured "fast", but
    // it must say the dispatch happened, or it is indistinguishable from a skip.
    return {
      measured: true,
      broken: false,
      inpLabel: NO_EVENTS_INP_LABEL,
      reason: 'the interaction was dispatched and produced no events past the 16ms threshold',
    };
  }
  const label = typeof inp === 'string' && inp.length > 0 ? inp : 'measured';
  return {
    measured: true,
    broken: false,
    inpLabel: label,
    reason: `${eventCount} event(s) recorded for the dispatched interaction`,
  };
}

/**
 * Lines the report owes when the interaction did not happen: the failure, named, and
 * the instruction not to read the INP column.
 */
export function interactionProblems(verdict) {
  if (verdict && verdict.measured) return [];
  return [
    `INTERACTION NOT MEASURED: ${verdict.reason}.`,
    'Every INP value in this report is meaningless - fix the page (or the selector) and re-run.',
  ];
}
