/*
 * tools/lib/perf-metrics.mjs — what a performance measurement actually measured.
 *
 * tools/measure-perf.mjs used to print "LCP: None (0 entries recorded)" and exit 0
 * (airhorn-lmlu). The row was honest about the entry count, but the EXIT CODE was not:
 * a report that measured no LCP is quotable as evidence of something it never measured,
 * which is the class of bug the airhorn-nxuv sweep exists to remove ("unmeasured is not
 * green"). The judgement lives here so it can be tested without a browser.
 */

/**
 * A metric is measured only when the observer produced a usable number. Zero and null
 * are both "no measurement": an LCP of 0 ms is not a fast page, it is an absent entry.
 */
export function isMeasured(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Which Core Web Vitals a run failed to measure, with the reason, for both loads.
 * `loads` is [{ label, metrics }] — one entry per load (cold, repeat).
 */
export function unmeasured(loads) {
  const findings = [];
  for (const { label, metrics } of loads || []) {
    if (!metrics) {
      findings.push(`${label}: no metrics object was collected at all`);
      continue;
    }
    if (!isMeasured(metrics.lcp)) {
      findings.push(
        `${label}: LCP was not measured (${metrics.lcpEntriesCount ?? 0} entries recorded) - the observer registered but nothing was painted before the sample ended`,
      );
    }
    if (typeof metrics.cls !== 'number' || !Number.isFinite(metrics.cls)) {
      findings.push(`${label}: CLS was not measured (${JSON.stringify(metrics.cls)})`);
    }
    if (!Array.isArray(metrics.rawEvents)) {
      findings.push(`${label}: the interaction events for INP were not collected`);
    }
  }
  return findings;
}

/**
 * The tool's exit code: 0 only when every field it reports was measured. A run that
 * measured nothing is a failed measurement, not a clean report, so it exits 2 - 1 stays
 * the "the harness itself crashed" code that main().catch uses.
 */
export function measurementExitCode(findings) {
  return (findings || []).length > 0 ? 2 : 0;
}
