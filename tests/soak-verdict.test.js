// Pin for airhorn-01vq: the soak/cache-growth landings (4463fb9, c644591) shipped
// ad-hoc proofs and no committed test. These tests drive the SAME exported functions
// the tools wire (nothing else in either file may compute growth), browser-free.
// Acceptance = the three exact uncaught reverts, each RED:
//   (a) windowed-median structural zero, BOTH variants (soak cycle-heap, soak
//       offline-heap, cache-growth bytes): a 2-sample series with a real +10MB leak
//       must measure +10MB, never 0;
//   (b) PASS-then-exit-1: the post-verdict path (the line that once ReferenceError'd)
//       must not throw, and the exit code must come from the verdict itself;
//   (c) cache-growth usage: a null estimate is NOT MEASURED, never a zero drift.
// RESIDUAL, stated: a revert that unwires main() from these exported functions is
// invisible to a browser-free pin; the suite-map row guarantees this test RUNS on any
// edit to either tool, so such a revert lands in front of a reviewer with the pin green
// but the export unused - that is the named limit of a pin that cannot drive main().

// IMPORT-SAFETY PIN (airhorn-fc98, airhorn-u5qj): this file imports tools/cache-growth.mjs.
// Before the invokedAsScript guard, that import ran the full 10-deploy Chrome measurement
// (~26-28s) and then process.exit()'d, which (a) put a Chrome ridealong in the fast gate's
// unit layer and (b) overrode this file's own exit code under direct invocation - failing
// assertions exited 0. This file existing and passing IS the pin: without the guard it
// cannot run at all without a prior build and a Chrome. Measured after the guard: import
// 84ms; a failing file importing the tool exits 1 under both `node --test` and `node`.
import test from 'node:test';
import assert from 'node:assert/strict';

import { cycleHeapGrowth, offlineHeapGrowth, audioNodesReleased, audioSummaryLine, exitCodeForSummary, heapGrowthDetail, summariseChecks } from '../tools/soak.mjs';
import { storedBytesDrift, usageDrift } from '../tools/cache-growth.mjs';
import { growthFromSeries } from '../tools/lib/endpoint-growth.mjs';

const MB = 1024 * 1024;

test('(a1) soak cycle-heap: a 2-sample overlap with a real leak measures the leak, not zero', () => {
  // The c8vo world: --cycles 19 yields TWO cycle-phase samples; the windows are the
  // same pair. A +10MB leak must read +10MB (the windowed median read 0).
  const series = [100 * MB, 110 * MB];
  assert.equal(cycleHeapGrowth(series, 100 * MB, 110 * MB), 10 * MB,
    'a real leak read as zero growth - the windowed-median structural zero is back');
});

test('(a2) soak offline-heap: the same overlap world measures the endpoints', () => {
  const offlineHeap = [50 * MB, 62 * MB];
  assert.equal(offlineHeapGrowth(offlineHeap), 12 * MB);
  assert.equal(offlineHeapGrowth([]), 0, 'no offline toggles is legitimately zero, and says so by shape not by accident');
});

test('(a3) cache-growth bytes: a 2-version drift is the endpoint delta', () => {
  assert.equal(storedBytesDrift([200 * 1024, 220 * 1024]), 20 * 1024);
});

test('windowed behavior is unchanged when the windows do NOT overlap (4+ samples)', () => {
  // Long series, no growth: still 0 for the RIGHT reason.
  assert.equal(growthFromSeries([10, 10, 10, 10, 10, 10], 10, 10), 0);
  // Long series with growth: the windowed median sees it.
  assert.equal(growthFromSeries([10, 10, 12, 14, 16, 18], 10, 18), 7);
});

test('(b) the post-verdict summary line cannot throw, and the exit code IS the verdict', () => {
  const samples = [{ liveSources: 1 }, { liveSources: 2 }];
  const afterCycles = { sourcesCreated: 4, sourcesEnded: 4 };
  const line = audioSummaryLine(samples, afterCycles, 1, 1);
  assert.match(line, /live sources max 2/, 'the audio summary lost its content');
  assert.equal(exitCodeForSummary({ pass: true }), 0);
  assert.equal(exitCodeForSummary({ pass: false }), 1,
    'a FAIL verdict must exit non-zero - a PASS-print-then-crash is the nxuv.32 shape');
});

test('(c) cache-growth usage: a null estimate is NOT MEASURED, not a zero drift', () => {
  const unmeasured = usageDrift([100, null]);
  assert.equal(unmeasured.measured, false);
  assert.equal(unmeasured.growth, null, 'an absent estimate must not compute a drift');
  const measured = usageDrift([100, 100]);
  assert.equal(measured.measured, true);
  assert.equal(measured.growth, 0);
});

test('karx: the heap detail prints the anchors the growth is measured from (airhorn-karx)', () => {
  // cycleHeapGrowth falls back to the TRUE endpoints (baseline, after-cycles) below four
  // samples - a detail that omits them cannot be recomputed by a reader.
  const MB = 1024 * 1024;
  const detail = heapGrowthDetail([10 * MB, 12 * MB], 2 * MB, 16, false, 10 * MB, 12 * MB);
  assert.match(detail, /endpoints baseline 10\.00 MB -> after-cycles 12\.00 MB/,
    `the endpoint anchors must be printed, or the growth number is unverifiable: ${detail}`);
  assert.match(detail, /growth 2\.00 MB/);
});

test('8ao4: the detail names the basis the growth was ACTUALLY computed from, in both worlds (airhorn-8ao4)', () => {
  const MB = 1024 * 1024;
  const few = heapGrowthDetail([10 * MB, 12 * MB], 2 * MB, 16, false, 10 * MB, 12 * MB);
  assert.match(few, /endpoints baseline 10\.00 MB -> after-cycles 12\.00 MB/,
    'under 4 samples the endpoints ARE the measurement and must be printed as such');
  const many = heapGrowthDetail([10 * MB, 11 * MB, 12 * MB, 13 * MB, 14 * MB], 3 * MB, 16, false, 10 * MB, 14 * MB);
  assert.match(many, /windowed-median basis/, 'with 4+ samples the basis is the windowed median and must say so');
  assert.doesNotMatch(many, /endpoints baseline .* -> after-cycles .* MB \(/,
    'the >=4-sample world must NOT label the growth as the endpoint delta - it is not');
});


test('a soak run with ZERO checks is not a pass (batch D row 5)', () => {
  assert.equal(summariseChecks([]).pass, false, 'zero checks is a measurement of nothing');
  assert.equal(summariseChecks([{ name: 'x', pass: true, detail: 'd' }]).pass, true);
  assert.equal(summariseChecks([{ name: 'x', pass: false, detail: 'd' }]).pass, false);
});

test('the audio-node release check cannot pass on an unmeasured heap or a leaked oscillator (airhorn-nxuv.4)', () => {
  // The P1 this pins: `heapBufferSources ?? 0` coerced an UNMEASURABLE heap sample to 0, so
  // 'heap sources max 0 <= 2' passed when nothing had been measured, and liveOscillators /
  // heapOscillators were computed and printed but were not IN the assertion at all - an
  // OscillatorNode leak passed green. Both holes are closed in audioNodesReleased and neither
  // had a pin, which is how a check that cannot fail survives: a mutation of the coercion or of
  // the oscillator clause changed nothing a test could see.
  const clean = (over = {}) => ({ liveSources: 0, liveOscillators: 0, heapBufferSources: 0, heapOscillators: 0, ...over });
  const after = (over = {}) => ({ sourcesCreated: 4, sourcesEnded: 4, oscillatorsCreated: 4, oscillatorsEnded: 4, liveSources: 0, liveOscillators: 0, ...over });
  const healthy = audioNodesReleased([clean(), clean()], after());
  assert.equal(healthy.pass, true, `a world with nothing retained must pass: ${healthy.detail}`);

  // (a) UNMEASURED is not zero. One null heap sample poisons the maximum; the verdict must fail
  // and the detail must say it is unknown rather than reporting a count of 0.
  const unmeasured = audioNodesReleased([clean(), clean({ heapBufferSources: null })], after());
  assert.equal(unmeasured.pass, false, 'an unmeasurable heap sample must not pass a release check');
  assert.match(unmeasured.detail, /sources heap count UNMEASURED/);
  assert.doesNotMatch(unmeasured.detail, /sources heap max 0/, 'unknown must not be reported as a count');

  // (b) an oscillator LEAK, seen only in the heap count: the live counter is clean in this world
  // (created and ended balance) and the retained node shows up in the prototype count alone.
  const oscHeapLeak = audioNodesReleased([clean(), clean({ heapOscillators: 5 })], after());
  assert.equal(oscHeapLeak.pass, false, 'a leaked oscillator in the heap must fail the release check');
  assert.match(oscHeapLeak.detail, /oscillators heap max 5/);

  // ...and the same for the live counters, so neither half of the check can be dropped unnoticed.
  assert.equal(audioNodesReleased([clean({ liveOscillators: 4 })], after()).pass, false,
    'four live oscillators is over the floor and must fail');
  assert.equal(audioNodesReleased([clean({ liveSources: 3 })], after()).pass, false,
    'three live sources is over the floor and must fail');
  assert.equal(audioNodesReleased([clean()], after({ liveSources: 1 })).pass, false,
    'a source still live after the cycles must fail');
  // The QUESCED half, one clause per node kind. This is the gap airhorn-ki2d found: the cases
  // above poison the PEAK (liveOscillatorsMax) or the sources' quiesced count, so dropping
  // `&& afterCycles.liveOscillators === 0` from the pass expression left the suite green while
  // audioNodesReleased answered pass:true for a world that still holds an oscillator.
  assert.equal(audioNodesReleased([clean()], after({ liveOscillators: 1 })).pass, false,
    'an oscillator still live after the cycles must fail');
  assert.equal(audioNodesReleased([clean()], after({ liveSources: 1, liveOscillators: 1 })).pass, false,
    'both kinds still live after the cycles must fail');
  // (The verdict takes afterCycles.liveOscillators as SAMPLED; it does not derive it from
  // oscillatorsCreated - oscillatorsEnded, so an unbalanced count alone is not a leak signal.)

  // NULL NOT COUNTED AS A LEAK EITHER: a world that never created a node is vacuous, not a
  // failure, and the detail says so - otherwise the strictness above would turn every
  // oscillator-free run red.
  const vacuous = audioNodesReleased([clean({ heapBufferSources: null, heapOscillators: null })],
    after({ sourcesCreated: 0, sourcesEnded: 0, oscillatorsCreated: 0, oscillatorsEnded: 0 }));
  assert.equal(vacuous.pass, true, `no node was ever created, so nothing can be retained: ${vacuous.detail}`);
  assert.match(vacuous.detail, /no sources ever created/);
});
