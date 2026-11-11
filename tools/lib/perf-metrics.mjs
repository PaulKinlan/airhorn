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
 *
 * A field whose observer this browser cannot register at all is NOT reported here (airhorn-nxuv.30):
 * `observerOutcomes()` names it as a SKIP. Saying "the observer registered but nothing was painted"
 * about an observer that was never constructed is the conflation this bead removed. What IS reported
 * here cites the measured observation window and the entry counts, so "nothing arrived in 1.6 s" can
 * be told apart from a claim about the page.
 */
export function unmeasured(loads) {
  const findings = [];
  for (const { label, metrics } of loads || []) {
    if (!metrics) {
      findings.push(`${label}: no metrics object was collected at all`);
      continue;
    }
    const missing = skippedTypes(metrics);
    const window = windowPhrase(metrics);
    const counts = entryCounts(metrics);
    if (!missing.has(FIELD_OBSERVER.fp) && !isMeasured(metrics.fp)) {
      findings.push(
        `${label}: First Paint was not measured (${metrics.paintEntries ?? 0} paint entries recorded${window})${counts} - the paint observer was live and nothing was painted before the sample ended`,
      );
    }
    if (!missing.has(FIELD_OBSERVER.lcp) && !isMeasured(metrics.lcp)) {
      findings.push(
        `${label}: LCP was not measured (${metrics.lcpEntriesCount ?? 0} entries recorded${window})${counts} - the observer registered but nothing was painted before the sample ended`,
      );
    }
    if (!missing.has(FIELD_OBSERVER.cls) && (typeof metrics.cls !== 'number' || !Number.isFinite(metrics.cls))) {
      findings.push(`${label}: CLS was not measured (${JSON.stringify(metrics.cls)}${window})${counts}`);
    }
    if (!missing.has(FIELD_OBSERVER.inp) && !Array.isArray(metrics.rawEvents)) {
      findings.push(`${label}: the interaction events for INP were not collected${window}${counts}`);
    }
  }
  return findings;
}

/** Which column each PerformanceObserver feeds, so a failure names what is missing. */
const OBSERVER_FIELDS = {
  paint: 'First Paint / First Contentful Paint',
  'largest-contentful-paint': 'LCP',
  'layout-shift': 'CLS',
  event: 'INP',
};

/** The entry type each field's finding names as the reason a field is empty. */
const FIELD_OBSERVER = {
  fp: 'paint',
  lcp: 'largest-contentful-paint',
  cls: 'layout-shift',
  inp: 'event',
};

/** "in a 1650 ms observation window", or nothing when the tool did not record one. */
function windowPhrase(metrics) {
  const ms = metrics && metrics.observationWindowMs;
  return Number.isFinite(ms) ? ` in a ${Math.round(ms)} ms observation window` : '';
}

/** Counts that make "the observer ran and produced nothing" checkable at a glance. */
function entryCounts(metrics) {
  if (!metrics) return '';
  const counts = [];
  if (Number.isFinite(metrics.paintEntries)) counts.push(`${metrics.paintEntries} paint entries`);
  if (Number.isFinite(metrics.lcpEntriesCount)) counts.push(`${metrics.lcpEntriesCount} LCP entries`);
  if (Number.isFinite(metrics.clsEntries)) counts.push(`${metrics.clsEntries} layout-shift entries`);
  if (Array.isArray(metrics.rawEvents)) counts.push(`${metrics.rawEvents.length} event-timing entries`);
  return counts.length > 0 ? ` [${counts.join(', ')}]` : '';
}

/** The observer types this load reported as unobservable in this browser. */
function skippedTypes(metrics) {
  const skips = metrics && metrics.observerSkips;
  if (!Array.isArray(skips)) return new Set();
  return new Set(skips.map((skip) => (skip && skip.type) || 'unknown'));
}

/**
 * Was this field's observer skipped because THIS browser cannot observe it? The printed table asks
 * before it renders a cell (airhorn-nxuv.30): a skipped CLS shows `0.0000` otherwise, which is a
 * measured-looking zero for a field that was never observed.
 */
export function wasSkipped(metrics, type) {
  return skippedTypes(metrics).has(type);
}

/**
 * PerformanceObserver outcomes per load (airhorn-nxuv.30), split into the two meanings an
 * empty `catch {}` used to collapse:
 *
 *   skipped - this browser cannot observe the type at all (no API, no such entry type). A fact
 *             about the ENVIRONMENT: named loudly, and deliberately NOT a failure, because a
 *             missing capability must not make the tool catastrophic.
 *   failed  - the registration (construction or observe()) THREW, or the observer's CALLBACK
 *             threw (which the old catch never saw, since callbacks run in a later page task).
 *             The field was never measured, so the run must fail by name.
 *
 * `loads` is [{ label, metrics }] - the same shape `unmeasured()` takes. Neither array being
 * recorded at all is itself a failure: the tool then cannot show that its numbers came from live
 * observers, which is exactly the fail-open shape being removed.
 */
export function observerOutcomes(loads) {
  const failed = [];
  const skipped = [];
  // A callback that throws on every entry list is ONE defect, not one per invocation: the drill
  // produced the same line twice for a single two-entry paint callback. Identity is (load, type,
  // phase), so a second identical record adds nothing a reader can act on.
  const seen = new Set();
  for (const { label, metrics } of loads || []) {
    // A missing metrics object is already named by unmeasured(); do not report it twice.
    if (!metrics) continue;
    if (!Array.isArray(metrics.observerErrors) || !Array.isArray(metrics.observerSkips)) {
      failed.push(
        `${label}: whether its PerformanceObservers registered was not recorded - the observer outcomes must be captured, so this report cannot show its metrics came from live observers`,
      );
      continue;
    }
    for (const skip of metrics.observerSkips) {
      const type = (skip && skip.type) || 'unknown';
      if (seen.has(`${label}|skip|${type}`)) continue;
      seen.add(`${label}|skip|${type}`);
      const capability = (skip && skip.capability) || 'this browser cannot observe it';
      skipped.push(
        `${label}: ${OBSERVER_FIELDS[type] || type} was not observed because ${capability} - SKIPPED, so this row is not a measurement of it and the tool is not failing for it`,
      );
    }
    for (const error of metrics.observerErrors) {
      const type = (error && error.type) || 'unknown';
      const phase = error && error.phase === 'callback' ? 'callback' : 'registration';
      if (seen.has(`${label}|${phase}|${type}`)) continue;
      seen.add(`${label}|${phase}|${type}`);
      const message = (error && error.message) || 'no message';
      const feeds = OBSERVER_FIELDS[type] || 'a metric';
      failed.push(
        error && error.phase === 'callback'
          ? `${label}: the ${type} PerformanceObserver CALLBACK threw (${message}) - ${feeds} stopped being measured at that point, so the value is not a measurement`
          : `${label}: the ${type} PerformanceObserver was REFUSED (${message}) - ${feeds} was never measured, so this is not a measured value`,
      );
    }
  }
  return { failed, skipped };
}

/**
 * The tool's exit code: 0 only when every field it reports was measured. A run that
 * measured nothing is a failed measurement, not a clean report, so it exits 2 - 1 stays
 * the "the harness itself crashed" code that main().catch uses.
 */
export function measurementExitCode(findings) {
  return (findings || []).length > 0 ? 2 : 0;
}
