// Pins for batch B (airhorn-nxuv.26, .12, .13, .14): verdicts that must distinguish
// "measured and bad" from "never measured". Each drives the tool's OWN exported decision
// function, browser-free. The imports being pure at all is pinned by the invokedAsScript
// guards (the fc98 lesson: these tools launch Chrome in main()).

import test from 'node:test';
import assert from 'node:assert/strict';
import { hornResponded } from '../tools/resilience-audit.mjs';
import { assertPreviewEvidence } from '../tools/preview-evidence.mjs';
import { repeatLoadLabel, measurePerfProblems } from '../tools/measure-perf.mjs';

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
    offlinePlay: { pressedWhileHeld: 'true' },
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
