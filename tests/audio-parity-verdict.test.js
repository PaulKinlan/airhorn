import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TOLERANCE, distance, pitchVerdict, verdict } from '../tools/audio-parity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// airhorn-nxuv.3. `fundamentalRatio` used to default to 1 when either side's pitch was
// unmeasurable, and 1 is dead centre of the accepted 0.85-1.18 band - so an unpitched
// render (a noise fallback, a dead oscillator) reported as a PERFECT pitch match. These
// tests are browser-free on purpose: the decision is Node-pure, so it can be proven RED
// and GREEN on a host that cannot launch Chrome at all.

const SAMPLE_BLAST = {
  peakDbfs: -3.0,
  rmsDbfs: -12.0,
  durationS: 2.0,
  centroidHz: 900,
  fundamentalHz: 440,
};

const passingRender = (overrides = {}) => ({
  peakDbfs: -3.2,
  rmsDbfs: -12.4,
  durationS: 2.0,
  centroidHz: 950,
  fundamentalHz: 452, // 1.027x - inside the band
  ...overrides,
});

test('an UNMEASURABLE pitch is its own failing outcome, never a ratio of 1 (airhorn-nxuv.3)', () => {
  // The old read, pinned: the default landed inside the accepted band and passed.
  const OLD_RULE = (sampleHz, synthHz) => (sampleHz && synthHz ? synthHz / sampleHz : 1);
  const [low, high] = TOLERANCE.fundamentalRatio;
  const oldRatio = OLD_RULE(SAMPLE_BLAST.fundamentalHz, 0);
  assert.equal(oldRatio, 1, 'the old default is 1');
  assert.ok(oldRatio >= low && oldRatio <= high,
    'and 1 sits inside the accepted band, which is why the hole was invisible');

  // Both directions of unmeasurable, and the both-sides case.
  for (const { sampleHz, synthHz, name } of [
    { sampleHz: 440, synthHz: 0, name: 'synth unmeasurable (noise fallback)' },
    { sampleHz: 0, synthHz: 440, name: 'sample unmeasurable' },
    { sampleHz: 0, synthHz: 0, name: 'neither measurable' },
  ]) {
    const pitch = pitchVerdict({ sampleHz, synthHz });
    assert.equal(pitch.measured, false, `${name}: measured must be false`);
    assert.equal(pitch.ratio, null, `${name}: ratio must be null, never 1`);
    assert.equal(pitch.gap, 'unmeasurable', `${name}: the gap must be NAMED`);
    assert.equal(pitch.pass, false, `${name}: the row must fail`);
    assert.match(pitch.reason, /unmeasurable/);
  }
});

test('a measurable pitch inside the band still passes, and the band is untouched (airhorn-nxuv.3)', () => {
  const [low, high] = TOLERANCE.fundamentalRatio;
  assert.deepEqual(TOLERANCE.fundamentalRatio, [0.85, 1.18],
    'the acceptance band is a measurement contract: it must not be narrowed or widened to make this fix work');

  const inside = pitchVerdict({ sampleHz: 440, synthHz: 452 });
  assert.equal(inside.measured, true);
  assert.ok(inside.pass, `1.027x must be inside ${low}-${high}`);
  assert.equal(inside.gap, '3%');

  // The edges of the contract still behave exactly as they did.
  assert.equal(pitchVerdict({ sampleHz: 100, synthHz: 85 }).pass, true);
  assert.equal(pitchVerdict({ sampleHz: 100, synthHz: 118 }).pass, true);
  assert.equal(pitchVerdict({ sampleHz: 100, synthHz: 84 }).pass, false);
  assert.equal(pitchVerdict({ sampleHz: 100, synthHz: 119 }).pass, false);
});

test('the whole row set goes RED when the render is unpitched, GREEN when it is not (airhorn-nxuv.3)', () => {
  // The end-to-end shape the tool prints and returns, still browser-free: verdict()
  // takes the measurements and returns whether every row passed.
  const realLog = console.log;
  console.log = () => {};
  try {
    const unpitched = verdict({
      paths: { sampleBlast: SAMPLE_BLAST, synthBlast: passingRender({ fundamentalHz: 0 }) },
    });
    assert.equal(unpitched, false, 'a render with no measurable pitch must NOT be IN PARITY');

    const pitched = verdict({
      paths: { sampleBlast: SAMPLE_BLAST, synthBlast: passingRender() },
    });
    assert.equal(pitched, true, 'the same render with a measurable pitch is IN PARITY');
  } finally {
    console.log = realLog;
  }
});

test('candidate ranking treats an unmeasurable render pitch as the worst match, not a perfect one (airhorn-nxuv.3)', () => {
  // distance() is the 0 = identical ranking metric. It had the same default: an
  // unmeasurable render pitch while the sample's was measurable scored as if the
  // pitches were identical.
  const unpitched = distance(SAMPLE_BLAST, passingRender({ fundamentalHz: 0 }));
  const goodPitch = distance(SAMPLE_BLAST, passingRender());
  const badPitch = distance(SAMPLE_BLAST, passingRender({ fundamentalHz: 880 }));
  assert.ok(unpitched > goodPitch, 'an unpitched candidate must rank worse than a 3% pitch error');
  // The fix ranks an unmeasurable pitch as a 2x pitch error on purpose (the worst
  // plausible candidate), so it ties with a deliberate 2x error rather than beating
  // it - and it can never be 0, which is what "identical" means.
  assert.equal(unpitched, badPitch, 'an unmeasured pitch ranks exactly as badly as a 2x error');
  assert.ok(unpitched > 0, 'and never zero-distance, which is what "identical" means');
});

test('the pitch decision lives in one exported rule that verdict() uses (airhorn-nxuv.3)', () => {
  // A rule a report can ignore is how this bug lived: the ratio was computed inline and
  // defaulted. Pin the wiring so the decision cannot drift back into a literal.
  const source = fs.readFileSync(path.join(root, 'tools', 'audio-parity.mjs'), 'utf8');
  assert.ok(source.includes('export function pitchVerdict('), 'the rule must be exported');
  assert.ok(source.includes('const pitch = pitchVerdict({'), 'verdict() must call the rule');
  assert.ok(!/fundamentalHz \? synth\.fundamentalHz/.test(source),
    'the inline ratio-with-default must be gone');
});
