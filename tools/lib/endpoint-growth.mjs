/*
 * tools/lib/endpoint-growth.mjs — the growth measure that cannot self-cancel.
 *
 * The windowed median (last-two minus first-two) reads 0 BY CONSTRUCTION when the
 * series is shorter than 4: the two windows are the same pair. Three tools hit this
 * (airhorn-nxuv.32, airhorn-c8vo, airhorn-yobt), each reading a structural zero as
 * "no growth" - a measured +10MB leak passed its budget. Under 4 samples the true
 * endpoints are the honest measure: a real delta, never a silent zero.
 */

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const growthFromSeries = (series, first, last) =>
  series.length >= 4
    ? median(series.slice(-2)) - median(series.slice(0, 2))
    : last - first;
