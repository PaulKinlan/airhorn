// Pins for batch B (airhorn-nxuv.26, .12, .13, .14): verdicts that must distinguish
// "measured and bad" from "never measured". Each drives the tool's OWN exported decision
// function, browser-free. The imports being pure at all is pinned by the invokedAsScript
// guards (the fc98 lesson: these tools launch Chrome in main()).

import test from 'node:test';
import assert from 'node:assert/strict';
import { hornResponded } from '../tools/resilience-audit.mjs';
import { assertPreviewEvidence } from '../tools/preview-evidence.mjs';
import { repeatLoadLabel, measurePerfProblems } from '../tools/measure-perf.mjs';
import { observerOutcomes, unmeasured, wasSkipped, measurementExitCode } from '../tools/lib/perf-metrics.mjs';

test('nxuv.26: a press response is a TRANSITION - a stuck-on horn does not respond', () => {
  assert.equal(hornResponded('false', 'true'), true, 'not pressed -> pressed is a response');
  assert.equal(hornResponded('true', 'true'), false, 'pressed before AND during is a stuck control, not a response');
  assert.equal(hornResponded('false', 'false'), false, 'no transition is no response');
});

const goodEvidence = () => ({
  checks: {
    offlineRenders: true,
    offlineBootFailureShown: false,
    darkApplied: true,
    darkDetectorCanFail: true,
    offlinePlay: { pressedBefore: 'false', pressedWhileHeld: 'true', released: 'false' },
  },
});

test('nxuv.12: the boot-failure banner offline is a NAMED failure, not a printed field', () => {
  assert.doesNotThrow(() => assertPreviewEvidence(goodEvidence(), []), 'clean evidence passes');
  const bad = goodEvidence();
  bad.checks.offlineBootFailureShown = true;
  assert.throws(() => assertPreviewEvidence(bad, []),
    /SHOWED the boot-failure banner/, 'a page showing the boot-crash banner offline must fail by name');
});

test('nxuv.13: a repeat load with no SW is LABELLED network/disk, never SW-cached', () => {
  assert.equal(repeatLoadLabel(true), 'Repeat (SW-cached) Load');
  assert.match(repeatLoadLabel(false), /no SW - network\/disk/, 'the label must tell the truth about what was measured');
  const problems = measurePerfProblems({ swActive: false, interactionDispatched: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /never activated.*NOT SW-cached/, 'the exit-code finding names the mismeasurement');
});

test('nxuv.14: no interaction dispatched is UNMEASURED, not INP "None"', () => {
  const problems = measurePerfProblems({ swActive: true, interactionDispatched: false });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /unmeasured, not "None"/);
  assert.deepEqual(measurePerfProblems({ swActive: true, interactionDispatched: true }), [],
    'a fully measured run has no structural problems');
});

test('nxuv.29: a sticky-pressed horn (never released) is a named failure', () => {
  const sticky = goodEvidence();
  sticky.checks.offlinePlay = { pressedBefore: 'false', pressedWhileHeld: 'true', released: 'true' };
  assert.throws(() => assertPreviewEvidence(sticky, []),
    /never RELEASED/, 'held-true but never released must fail by name, not pass the held check');
});

test('uu2m: a horn already pressed BEFORE the press is an invented positive, failed by name', () => {
  const stuck = goodEvidence();
  stuck.checks.offlinePlay = { pressedBefore: 'true', pressedWhileHeld: 'true', released: 'true' };
  assert.throws(() => assertPreviewEvidence(stuck, []),
    /aria-pressed=true BEFORE the press/, 'held state with no baseline cannot prove the press did anything (the nxuv.26 transition semantics)');
  assert.doesNotThrow(() => assertPreviewEvidence(goodEvidence(), []),
    'a real transition (unpressed -> held -> released) still passes');
});

// airhorn-nxuv.30: the four PerformanceObservers used to sit in `catch {}`, so EVERY outcome -
// no API, no such entry type, a refused observe(), a throwing callback, an observer that ran and
// produced nothing - left its column at the default (FP 'None', LCP 'None (0 entries recorded)',
// CLS '0.0000') inside a table that still read as a complete measurement, and the run exited 0.
// Three outcomes, three meanings, and only one of them is a failure.
const load = (label, extra) => ({
  label,
  metrics: {
    fp: 120, paintEntries: 2,
    lcp: 400, lcpEntriesCount: 1,
    cls: 0, clsEntries: 1,
    rawEvents: [],
    observerErrors: [],
    observerSkips: [],
    observationWindowMs: 1650,
    ...extra,
  },
});

test('nxuv.30: a REFUSED observer is a named failure, not a default column', () => {
  const { failed, skipped } = observerOutcomes([
    load('cold load', { observerErrors: [{ type: 'largest-contentful-paint', phase: 'registration', message: "Failed to execute 'observe' on 'PerformanceObserver': An observe() call must include either entryTypes or type arguments." }] }),
  ]);
  assert.equal(skipped.length, 0);
  assert.equal(failed.length, 1);
  assert.match(failed[0], /cold load: the largest-contentful-paint PerformanceObserver was REFUSED/, 'the failure names the observer type');
  assert.match(failed[0], /must include either entryTypes or type arguments/, "and keeps the browser's own reason");
  assert.match(failed[0], /LCP was never measured/, 'and names the column that is missing');
  assert.equal(measurementExitCode(failed), 2, 'a refused observer is a failed measurement (2), never a clean report (0)');
});

test('nxuv.30: a THROWING CALLBACK is a failure too - the old catch never saw it', () => {
  // The callback runs in a later page task, so `try { new PerformanceObserver(...) } catch {}`
  // cannot catch it: the throw went to the page's uncaught-error path and the field stayed default.
  const { failed } = observerOutcomes([
    load('cold load', { observerErrors: [{ type: 'layout-shift', phase: 'callback', message: 'entryList is not defined' }] }),
  ]);
  assert.equal(failed.length, 1);
  assert.match(failed[0], /the layout-shift PerformanceObserver CALLBACK threw/);
  assert.match(failed[0], /CLS stopped being measured/);
  assert.equal(measurementExitCode(failed), 2);
});

test('nxuv.30: a capability this browser LACKS skips loudly by name and does not fail the run', () => {
  const { failed, skipped } = observerOutcomes([
    load('cold load', { observerSkips: [{ type: 'largest-contentful-paint', capability: 'Chromium lists no "largest-contentful-paint" in PerformanceObserver.supportedEntryTypes here' }] }),
  ]);
  assert.equal(failed.length, 0, 'a missing capability is a fact about the environment, not a failed measurement');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /LCP was not observed because Chromium lists no "largest-contentful-paint"/, 'the skip names the capability');
  assert.match(skipped[0], /SKIPPED, so this row is not a measurement of it and the tool is not failing for it/);
  assert.equal(measurementExitCode(failed), 0, 'skips alone exit 0 - a browser without the API is not a catastrophe');
});

test('nxuv.30: a SKIPPED observer is not then reported as "registered but nothing painted"', () => {
  // The conflation: with the API absent, LCP is null, and the pre-fix report claimed the observer
  // HAD registered and the page had painted nothing. Both were false statements.
  const skippedLoad = load('cold load', {
    lcp: null, lcpEntriesCount: 0,
    observerSkips: [{ type: 'largest-contentful-paint', capability: 'this browser has no PerformanceObserver at all' }],
  });
  assert.deepEqual(unmeasured([skippedLoad]), [], 'the skip owns this field; the "not measured" claim would be a lie');
  // The same empty field WITHOUT a skip is still a failure, and now cites the window and counts.
  const emptyLoad = load('cold load', { lcp: null, lcpEntriesCount: 0 });
  const findings = unmeasured([emptyLoad]);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /LCP was not measured \(0 entries recorded in a 1650 ms observation window\)/);
  assert.match(findings[0], /\[2 paint entries, 0 LCP entries, 1 layout-shift entries, 0 event-timing entries\]/);
  assert.equal(measurementExitCode(findings), 2, 'an observer that ran and produced nothing still fails');
});

test('nxuv.30: unrecorded observer state FAILS CLOSED - it is not read as "all registered"', () => {
  const { failed } = observerOutcomes([{ label: 'cold load', metrics: { lcp: 400, cls: 0, rawEvents: [] } }]);
  assert.equal(failed.length, 1, 'a metrics object that did not record its observer outcomes cannot prove its fields were measured');
  assert.match(failed[0], /whether its PerformanceObservers registered was not recorded/);
  assert.equal(measurementExitCode(failed), 2);

  // The metrics-object hole is lmlu's finding, so it is not reported twice here.
  assert.deepEqual(observerOutcomes([{ label: 'cold load', metrics: null }]), { failed: [], skipped: [] });
  assert.deepEqual(observerOutcomes([]), { failed: [], skipped: [] });
  // A fully registered run has nothing to report in either direction.
  assert.deepEqual(observerOutcomes([load('cold load'), load('repeat load')]), { failed: [], skipped: [] });
  assert.deepEqual(unmeasured([load('cold load'), load('repeat load')]), []);
});

test('nxuv.30: the printed CELL cannot show a measured-looking default for a skipped observer', () => {
  // A skipped CLS used to render `0.0000` and a skipped LCP `None (0 entries recorded)` - both read
  // as measurements of the app. The table asks this before it renders a cell.
  const skippedCls = load('cold load', { observerSkips: [{ type: 'layout-shift', capability: 'no layout-shift here' }] });
  assert.equal(wasSkipped(skippedCls.metrics, 'layout-shift'), true);
  assert.equal(wasSkipped(skippedCls.metrics, 'largest-contentful-paint'), false, 'an unrelated field is still reported normally');
  assert.equal(wasSkipped({}, 'layout-shift'), false, 'an unrecorded metrics object claims no skip');

  // One callback that throws on every entry list is ONE defect, not one line per invocation.
  const repeated = observerOutcomes([
    load('cold load', { observerErrors: [
      { type: 'paint', phase: 'callback', message: 'drill: paint callback blew up' },
      { type: 'paint', phase: 'callback', message: 'drill: paint callback blew up' },
    ] }),
  ]);
  assert.equal(repeated.failed.length, 1, 'identical (load, type, phase) records collapse to one line');
  assert.equal(measurementExitCode(repeated.failed), 2, 'and it is still a failure');
});
