// Pins for batch B (airhorn-nxuv.26, .12, .13, .14): verdicts that must distinguish
// "measured and bad" from "never measured". Each drives the tool's OWN exported decision
// function, browser-free. The imports being pure at all is pinned by the invokedAsScript
// guards (the fc98 lesson: these tools launch Chrome in main()).

import test from 'node:test';
import assert from 'node:assert/strict';
import { hornResponded } from '../tools/resilience-audit.mjs';
import { assertPreviewEvidence } from '../tools/preview-evidence.mjs';
import { repeatLoadLabel, measurePerfProblems } from '../tools/measure-perf.mjs';
import { observerFailures, measurementExitCode } from '../tools/lib/perf-metrics.mjs';

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

// airhorn-nxuv.30: the four PerformanceObservers used to sit in `catch {}`, so a browser that
// REFUSED a registration left its column at the default (LCP 'None (0 entries recorded)', CLS
// '0.0000') inside a table that still read as a complete measurement, and the run exited 0.
// A refused observer means the field was never wired up: named, and the run fails.
const quietLoad = (label, observerErrors) => ({
  label,
  metrics: { lcp: null, lcpEntriesCount: 0, cls: 0, rawEvents: [], observerErrors },
});

test('nxuv.30: a REFUSED PerformanceObserver is a named failure, not a default column', () => {
  const refused = observerFailures([
    quietLoad('cold load', [{ type: 'largest-contentful-paint', message: 'An observe() call must include either entryTypes or type arguments.' }]),
  ]);
  assert.equal(refused.length, 1);
  assert.match(refused[0], /cold load: the largest-contentful-paint PerformanceObserver was REFUSED/, 'the failure names the observer type');
  assert.match(refused[0], /must include either entryTypes or type arguments/, 'and keeps the browser\'s own reason');
  assert.match(refused[0], /LCP was never measured/, 'and names the column that is missing');
  assert.equal(measurementExitCode(refused), 2, 'a refused observer is a failed measurement (2), never a clean report (0)');

  const clean = observerFailures([quietLoad('cold load', []), quietLoad('repeat load', [])]);
  assert.deepEqual(clean, [], 'all four registered and none fired is the lmlu case, not this one');
  assert.equal(measurementExitCode(clean), 0);
});

test('nxuv.30: unrecorded observer state FAILS CLOSED - it is not read as "all registered"', () => {
  const unknown = observerFailures([quietLoad('cold load', undefined)]);
  assert.equal(unknown.length, 1, 'a metrics object that did not record its observer state cannot prove its fields were measured');
  assert.match(unknown[0], /whether its PerformanceObservers registered was not recorded/);
  assert.equal(measurementExitCode(unknown), 2);

  // The metrics-object hole is lmlu's finding, so it is not reported twice here.
  assert.deepEqual(observerFailures([{ label: 'cold load', metrics: null }]), []);
  assert.deepEqual(observerFailures([]), []);
});
