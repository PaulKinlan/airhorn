/**
 * What `reg.update()` actually did (airhorn-nxuv.6).
 *
 * The update-during-press scenario called the update and discarded the answer:
 * `.then(() => true).catch(() => false)`, with the `false` thrown away. A worker whose
 * update REJECTED therefore reported `pressInterrupted: false` with status OK - a
 * failed update read as "the update never happened", which is the same thing a pass
 * looks like. Absence must be its own outcome, never a value that fits the happy path.
 *
 * The classification and the failure live here, pure, so both can be proven without a
 * browser: the page reports only raw facts, and Node decides what they mean.
 */

export const UPDATED = 'updated';
export const REJECTED = 'rejected';
export const UNMEASURABLE = 'unmeasurable';

/**
 * @param {{ registrationPresent?: boolean, settled?: boolean, errorMessage?: string|null }} facts
 *   `registrationPresent` - was there a registration to update at all?
 *   `settled` - did the update promise fulfil (true) or reject (false)?
 *   `errorMessage` - the rejection's message, when there was one.
 * @returns {{ outcome: string, detail: string }}
 */
export function classifyUpdateOutcome({ registrationPresent, settled, errorMessage } = {}) {
  if (registrationPresent !== true) {
    return {
      outcome: UNMEASURABLE,
      detail: 'no service worker registration to update',
    };
  }
  if (settled === true) {
    return { outcome: UPDATED, detail: 'reg.update() settled' };
  }
  if (settled === false) {
    const message = typeof errorMessage === 'string' && errorMessage ? errorMessage : '(no message)';
    return { outcome: REJECTED, detail: message };
  }
  // Not settled at all: the call was never observed finishing. That is unmeasurable,
  // NOT a pass - the old code's discarded `false` lived here.
  return {
    outcome: UNMEASURABLE,
    detail: 'reg.update() was never observed to settle (no fulfil, no rejection)',
  };
}

/**
 * The scenario's verdict on that outcome: anything but a settled update fails it,
 * named. Returns the record to keep; throws when the update did not happen.
 *
 * @param {{ outcome: string, detail?: string }} update
 * @param {string} [scenario]
 */
export function assertUpdateMeasured(update, scenario = 'update-during-press') {
  const outcome = update && update.outcome;
  if (outcome === UPDATED) return update;
  const detail = (update && update.detail) || '(no detail)';
  if (outcome === REJECTED) {
    throw new Error(`${scenario}: the service worker update REJECTED - ${detail}`);
  }
  if (outcome === UNMEASURABLE) {
    throw new Error(`${scenario}: the service worker update could not be measured - ${detail}`);
  }
  throw new Error(`${scenario}: the service worker update outcome is unknown (${JSON.stringify(outcome)}) - ${detail}`);
}
