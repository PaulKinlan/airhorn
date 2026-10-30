/**
 * What the repeat load actually measured.
 *
 * The report used to label the second navigation `Repeat (SW-cached) Load`
 * unconditionally, while the only evidence it printed was
 * `SW Controller Present: false` two lines above. So a worker that NEVER
 * activated - the exact failure the SW is supposed to prevent - produced a row
 * whose headline says the repeat load was served from the worker's cache, and the
 * transferred-bytes drop next to it reads as a caching win (airhorn-nxuv.13).
 *
 * A missing measurement is not a win. This module is the rule, kept pure so it can
 * be proven RED/GREEN without a browser: the caller passes what it actually
 * observed (`navigator.serviceWorker.controller`) on each load, and gets back the
 * label it may print and whether the row is a caching measurement at all.
 */

export const CACHED_LABEL = 'Repeat (SW-cached) Load';

/**
 * @param {{ coldControlled: boolean, repeatControlled: boolean }} observed
 *   What `navigator.serviceWorker.controller` returned after the cold load and
 *   after the repeat load. `undefined`/`null` mean "not observed", which is NOT
 *   the same as false and is never treated as a win.
 * @returns {{ cached: boolean, label: string, reason: string }}
 */
export function repeatLoadVerdict({ coldControlled, repeatControlled } = {}) {
  const observed = (value) => value === true || value === false;

  if (!observed(coldControlled)) {
    return {
      cached: false,
      label: 'Repeat Load (SW state UNMEASURED - NOT a caching measurement)',
      reason: 'the cold load never reported whether a worker was controlling it',
    };
  }
  if (coldControlled !== true) {
    return {
      cached: false,
      label: 'Repeat Load (SW NEVER ACTIVATED - NOT a caching measurement)',
      reason: 'no worker was controlling the cold load, so the repeat load cannot be worker-cached',
    };
  }
  if (!observed(repeatControlled)) {
    return {
      cached: false,
      label: 'Repeat Load (SW state UNMEASURED on the repeat - NOT a caching measurement)',
      reason: 'the repeat load never reported whether a worker was still controlling it',
    };
  }
  if (repeatControlled !== true) {
    return {
      cached: false,
      label: 'Repeat Load (SW LOST CONTROL - NOT a caching measurement)',
      reason: 'a worker controlled the cold load but not the repeat load, so the repeat was not served by it',
    };
  }
  return {
    cached: true,
    label: CACHED_LABEL,
    reason: 'a worker was controlling both loads',
  };
}

/**
 * The line(s) the report owes a reader when the repeat load was not a caching
 * measurement: an explicit refusal to read the bytes as a caching win.
 */
export function repeatLoadCaveat(verdict) {
  if (!verdict || verdict.cached) return [];
  return [
    `NOT A CACHING MEASUREMENT: ${verdict.reason}.`,
    'Do not read the repeat-transfer delta below as a service-worker caching win.',
  ];
}
