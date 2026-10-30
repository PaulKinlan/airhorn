/*
 * tools/lib/node-release-check.mjs — "are the audio nodes released?" as a pure
 * function of what a session measured (airhorn-nxuv.4).
 *
 * The soak's live-node check had two ways to be green without meaning it:
 * `heapBufferSources ?? 0` turned a heap sample that was never TAKEN into "0 live
 * nodes", and the oscillator counters were computed and printed but never in the
 * assertion. Both are properties of the CHECK, not of a browser session, so they
 * live here as pure logic and are proven without one
 * (tests/node-release-check.test.js): a box under 60-90% steal cannot launch
 * Chrome, and an assertion about assertions must not depend on that.
 *
 * The rule, per node kind and per document:
 *   - a document that CREATED nodes of a kind must be able to count them in the
 *     heap afterwards. If it cannot, the measurement is MISSING and the check
 *     fails: absent data is not zero live nodes. No default stands in for it;
 *   - live-at-once and still-reachable maxima are asserted against a tolerance
 *     that says how many nodes may still be lingering (one blast's worth). The
 *     tolerance is a limit on lingering nodes, never a way to make a missing
 *     measurement fit;
 *   - a kind the session never created has nothing to answer for, and says so
 *     instead of scoring a vacuous pass.
 */

const finite = (value) => Number.isFinite(value);

/**
 * The kinds of audio node the app can create, and what each one's numbers are
 * called in a soak sample. `tolerance(synthVoices)` is how many nodes of the kind
 * may still be reachable at a sample point: samples are taken with the horn
 * silent and after a forced GC, so one blast's nodes catching up is all this
 * admits.
 */
const KIND_SPECS = [
  {
    name: 'buffer sources',
    liveKey: 'liveSources',
    heapKey: 'heapBufferSources',
    createdKey: 'sourcesCreated',
    endedKey: 'sourcesEnded',
    tolerance: () => 2,
  },
  {
    name: 'oscillators',
    liveKey: 'liveOscillators',
    heapKey: 'heapOscillators',
    createdKey: 'oscillatorsCreated',
    endedKey: 'oscillatorsEnded',
    // The fallback synth starts one oscillator per voice (src/horn.js
    // SYNTH_FREQUENCIES), so one blast is the lingering allowance.
    tolerance: (synthVoices) => Math.max(1, synthVoices),
  },
];

const blank = (value) => (value === null || value === undefined ? 0 : value);

function summarise(spec, samples, totals) {
  const live = samples.map((point) => point[spec.liveKey]).filter(finite);
  const heap = samples.map((point) => point[spec.heapKey]).filter(finite);
  return {
    name: spec.name,
    tolerance: spec.tolerance,
    created: blank(totals[spec.createdKey]),
    ended: blank(totals[spec.endedKey]),
    liveAtEnd: blank(totals[spec.liveKey]),
    liveMax: live.length ? Math.max(...live) : null,
    heapMax: heap.length ? Math.max(...heap) : null,
    // The samples where the page says it created nodes of this kind and the heap
    // cross-check could not count them: those measurements are missing, whatever
    // the live counters say.
    blind: samples
      .filter((point) => blank(point[spec.createdKey]) > 0 && !finite(point[spec.heapKey]))
      .map((point) => point.label ?? 'unlabelled'),
  };
}

function holesFor(kind, sampleCount) {
  const holes = [];

  if (kind.created === 0) {
    // Nothing of this kind was ever created: no leak to see and no prototype to
    // count against. Saying so is honest; scoring it would not be.
    if (kind.liveAtEnd !== 0 || (kind.liveMax !== null && kind.liveMax > 0)) {
      holes.push(`${kind.name}: ${kind.liveAtEnd} live at the end though none was created`);
    }
    return holes;
  }

  if (kind.heapMax === null) {
    holes.push(`${kind.name}: the heap cross-check was never measurable across ${sampleCount} sample(s) ` +
      `though ${kind.created} were created — a missing measurement is not zero live nodes`);
  } else if (kind.blind.length) {
    holes.push(`${kind.name}: heap cross-check missing in ${kind.blind.length}/${sampleCount} sample(s) after ` +
      `${kind.created} created (${kind.blind.slice(0, 3).join(', ')})`);
  }

  // Explicit null comparisons: `null <= 2` is true in JS, which is precisely how
  // an unmeasured count used to read as healthy.
  if (kind.liveMax !== null && kind.liveMax > kind.tolerance) {
    holes.push(`${kind.name}: ${kind.liveMax} live at once (max ${kind.tolerance})`);
  }
  if (kind.heapMax !== null && kind.heapMax > kind.tolerance) {
    holes.push(`${kind.name}: ${kind.heapMax} still reachable in the heap (max ${kind.tolerance})`);
  }
  if (kind.liveAtEnd !== 0) {
    holes.push(`${kind.name}: ${kind.liveAtEnd} still live at the end of the session`);
  }

  return holes;
}

function describe(kind) {
  if (kind.created === 0) return `${kind.name}: none created, ${kind.liveAtEnd} live at the end`;
  const count = (value) => (value === null ? 'not measurable' : value);
  return `${kind.name} live max ${count(kind.liveMax)} (heap ${count(kind.heapMax)}), ` +
    `${kind.created} created / ${kind.ended} ended, ${kind.liveAtEnd} live at the end`;
}

/**
 * Judge a session's audio-node release from its samples and totals.
 *
 * @param {object} input
 * @param {Array<object>} input.samples  measurement points, each carrying the
 *   per-document counters and heap counts named by KIND_SPECS. A `null` heap
 *   count means the cross-check could not be taken for that sample.
 * @param {object} input.totals  the counters for the phase being judged (one
 *   document's: created/ended/live per kind).
 * @param {number} [input.synthVoices]  oscillators per synthesised blast.
 * @returns {{pass: boolean, holes: string[], kinds: object[], detail: string}}
 */
export function checkNodeRelease({ samples = [], totals = {}, synthVoices = 3 } = {}) {
  const kinds = KIND_SPECS.map((spec) => summarise({ ...spec, tolerance: spec.tolerance(synthVoices) },
    samples, totals));
  const holes = kinds.flatMap((kind) => holesFor(kind, samples.length));
  return {
    pass: holes.length === 0,
    holes,
    kinds,
    detail: holes.length ? holes.join('; ') : kinds.map(describe).join('; '),
  };
}

export { describe as describeKind };
