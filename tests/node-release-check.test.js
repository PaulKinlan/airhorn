/*
 * tests/node-release-check.test.js — the soak's audio-node release check can
 * FAIL, browser-free (airhorn-nxuv.4).
 *
 * The soak claimed "audio nodes are released after every cycle" and could not
 * fail the way it said: `heapBufferSources ?? 0` coerced an UNMEASURED heap
 * sample into 0, so `heapSourcesMax <= 2` passed when nothing had been measured,
 * and the oscillator counters were computed and printed but never in the
 * assertion. Both are properties of the check, not of a browser session, so they
 * are proven here against fixtures: ~ms instead of a gate slot, and no dependency
 * on a host that can start Chrome (the fleet box measured 60-96% steal while this
 * was written, and the tool's own preflight refuses to launch under that).
 *
 * The two regression cases pin the OLD arithmetic next to the new verdict, so the
 * hole cannot come back quietly: the same fixture that the old line called green
 * has to come back red now.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNodeRelease } from '../tools/lib/node-release-check.mjs';

/** A soak measurement point. Every heap count starts at 0 (taken and clean). */
const point = (label, overrides = {}) => ({
  label,
  liveSources: 0,
  heapBufferSources: 0,
  sourcesCreated: 3,
  sourcesEnded: 3,
  liveOscillators: 0,
  heapOscillators: 0,
  oscillatorsCreated: 0,
  oscillatorsEnded: 0,
  ...overrides,
});

/** Totals for one document, as the soak reads them at the end of its cycle phase. */
const totals = (overrides = {}) => ({
  liveSources: 0,
  sourcesCreated: 30,
  sourcesEnded: 30,
  liveOscillators: 0,
  oscillatorsCreated: 0,
  oscillatorsEnded: 0,
  ...overrides,
});

test('an honest session passes, and says what it counted', () => {
  const samples = [
    point('baseline', { sourcesCreated: 1, sourcesEnded: 1 }),
    point('cycle-10', { sourcesCreated: 11, sourcesEnded: 11 }),
    point('after-cycles', { sourcesCreated: 31, sourcesEnded: 31,
      oscillatorsCreated: 36, oscillatorsEnded: 36 }),
  ];
  const result = checkNodeRelease({
    samples,
    totals: totals({ sourcesCreated: 31, sourcesEnded: 31, oscillatorsCreated: 36, oscillatorsEnded: 36 }),
    synthVoices: 3,
  });
  assert.equal(result.pass, true, result.detail);
  assert.deepEqual(result.holes, []);
  assert.match(result.detail, /buffer sources live max 0 \(heap 0\), 31 created \/ 31 ended, 0 live at the end/);
  assert.match(result.detail, /oscillators live max 0 \(heap 0\), 36 created \/ 36 ended, 0 live at the end/);
});

test('REGRESSION (a): a heap cross-check that never measured is a failure, not 0 live nodes', () => {
  // Every sample was taken, but the prototype the cross-check queries was never
  // readable - exactly what a broken `soak.protos.source` capture produces.
  const samples = [
    point('baseline', { sourcesCreated: 1, sourcesEnded: 1, heapBufferSources: null }),
    point('cycle-10', { sourcesCreated: 11, sourcesEnded: 11, heapBufferSources: null }),
    point('after-cycles', { sourcesCreated: 31, sourcesEnded: 31, heapBufferSources: null }),
  ];
  // The old line: `Math.max(...samples.map((p) => p.heapBufferSources ?? 0))` <= 2.
  const oldHeapSourcesMax = Math.max(...samples.map((entry) => entry.heapBufferSources ?? 0));
  assert.equal(oldHeapSourcesMax <= 2, true, 'the old check read three unmeasured samples as a clean max of 0');

  const result = checkNodeRelease({ samples, totals: totals({ sourcesCreated: 31, sourcesEnded: 31 }) });
  assert.equal(result.pass, false, 'an unmeasured cross-check must fail the check');
  assert.match(result.detail, /the heap cross-check was never measurable across 3 sample\(s\) though 31 were created/);
  assert.match(result.detail, /a missing measurement is not zero live nodes/);
});

test('a cross-check that dies mid-session fails and names the samples it lost', () => {
  const samples = [
    point('baseline', { sourcesCreated: 1, sourcesEnded: 1 }),
    point('cycle-10', { sourcesCreated: 11, sourcesEnded: 11, heapBufferSources: null }),
    point('cycle-20', { sourcesCreated: 21, sourcesEnded: 21, heapBufferSources: null }),
    point('after-cycles', { sourcesCreated: 31, sourcesEnded: 31 }),
  ];
  const result = checkNodeRelease({ samples, totals: totals({ sourcesCreated: 31, sourcesEnded: 31 }) });
  assert.equal(result.pass, false);
  assert.match(result.detail, /heap cross-check missing in 2\/4 sample\(s\) after 31 created \(cycle-10, cycle-20\)/);
});

test('REGRESSION (b): oscillators retained in the heap fail, though the ended counters are clean', () => {
  // The shape of the `oscillator-leak` mutant (a push into a global inside Horn's
  // fallback synth): the app still stops and disconnects every node, so created ===
  // ended and every live counter reads 0. Only the heap count can see it, which is
  // why it - and not the live counter - has to be asserted.
  const samples = [point('synth-fallback', { oscillatorsCreated: 36, oscillatorsEnded: 36, heapOscillators: 36 })];
  const sessionTotals = totals({ oscillatorsCreated: 36, oscillatorsEnded: 36 });
  assert.equal(sessionTotals.oscillatorsCreated - sessionTotals.oscillatorsEnded, 0,
    'the ended counter cannot distinguish a released node from a retained one');

  const result = checkNodeRelease({ samples, totals: sessionTotals, synthVoices: 3 });
  assert.equal(result.pass, false);
  assert.match(result.detail, /oscillators: 36 still reachable in the heap \(max 3\)/);
});

test('an oscillator still live at the end of the session fails', () => {
  const result = checkNodeRelease({
    samples: [point('after-cycles', { oscillatorsCreated: 36, oscillatorsEnded: 35, liveOscillators: 1 })],
    totals: totals({ oscillatorsCreated: 36, oscillatorsEnded: 35, liveOscillators: 1 }),
    synthVoices: 3,
  });
  assert.equal(result.pass, false);
  assert.match(result.detail, /oscillators: 1 still live at the end of the session/);
});

test('live-at-once above the one-blast tolerance fails, at the boundary and above it', () => {
  const atTolerance = checkNodeRelease({
    samples: [point('synth-fallback', { oscillatorsCreated: 36, oscillatorsEnded: 33, liveOscillators: 3 })],
    totals: totals({ oscillatorsCreated: 36, oscillatorsEnded: 33, liveOscillators: 0 }),
    synthVoices: 3,
  });
  assert.equal(atTolerance.pass, true, atTolerance.detail);

  const overTolerance = checkNodeRelease({
    samples: [point('synth-fallback', { oscillatorsCreated: 36, oscillatorsEnded: 32, liveOscillators: 4 })],
    totals: totals({ oscillatorsCreated: 36, oscillatorsEnded: 32, liveOscillators: 0 }),
    synthVoices: 3,
  });
  assert.equal(overTolerance.pass, false);
  assert.match(overTolerance.detail, /oscillators: 4 live at once \(max 3\)/);
});

test('a kind the session never created is not scored, and not claimed as measured', () => {
  // The synthesiser disabled (`--synth 0`) or a session that never fell back: the
  // oscillator prototype was never captured, so its heap count is null for every
  // sample. That is not a leak and not a measurement - it must not be reported as
  // either, and it must not fail the run.
  const samples = [point('baseline'), point('after-cycles', { sourcesCreated: 31, sourcesEnded: 31 })];
  const result = checkNodeRelease({
    samples,
    totals: totals({ sourcesCreated: 31, sourcesEnded: 31 }),
    synthVoices: 3,
  });
  assert.equal(result.pass, true, result.detail);
  assert.match(result.detail, /oscillators: none created, 0 live at the end/);
  assert.doesNotMatch(result.detail, /not measurable/, 'a kind with no nodes must not read as a lost measurement');
});

test('a kind reported live without ever being created fails', () => {
  const result = checkNodeRelease({
    samples: [point('after-cycles', { liveOscillators: 2 })],
    totals: totals({ liveOscillators: 2 }),
    synthVoices: 3,
  });
  assert.equal(result.pass, false);
  assert.match(result.detail, /oscillators: 2 live at the end though none was created/);
});
