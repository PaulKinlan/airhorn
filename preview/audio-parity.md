# Audio parity: does the synthesised fallback sound like the sample? (airhorn-u7s)

The fallback in `src/horn.js` (`#playSynth`) was proven *audible*; it had never been
proven *similar* to the recording (`#playSample`). This is the measurement, the fix,
and what is left.

Reproduce everything here with:

```bash
node tools/audio-parity.mjs --json preview/audio-parity.json   # table + verdict
node tools/audio-parity.mjs --sweep                            # price alternatives
node tools/audio-parity.mjs --check                            # exit 2 if out of parity
```

## How it is measured

One blast is rendered down **each real path** in headless Chromium through an
`OfflineAudioContext` (deterministic: no audio device, no timer jitter), by
instantiating the actual `Horn` class on an injected offline context. The sample
path uses the shipped `public/sounds/airhorn.mp3`; the fallback path points
`audioSrc` at a 404, which is exactly how `#playSynth` is reached in production
(`usingFallback` is asserted per render, so a broken asset can never silently
compare the fallback with itself).

Metrics: audible duration (−60 dBFS gate), peak and RMS (dBFS), attack (first
20 ms frame reaching 90% of the peak frame), fundamental by normalised
autocorrelation (shortest strong period — a chord of harmonics correlates just as
well at half the period), spectral centroid, HF energy above 2 kHz, spectral
flatness (dB; higher = noisier), strongest partials, and the **loop seam**: the
largest sample-to-sample step within ±1 ms of each loop boundary compared with the
same statistic in the middle of the loop (a click is a step much larger than the
mid-loop step, so a signal full of steep slopes cannot look clicky by construction).

## Before this change (master)

| metric | sample | fallback | delta | listener hears |
|---|---|---|---|---|
| audible duration (s) | 0.84 | 1.118 | **+33%** | a longer "blaaat" instead of a honk |
| peak (dBFS) | −3.2 | −8.1 | **−4.9 dB** | fallback is quieter |
| RMS (dBFS) | −14.0 | −18.3 | **−4.3 dB** | fallback is quieter |
| attack to 90% (ms) | 180 | 40 | **−140 ms** | 40 ms step vs the recording's swell |
| fundamental (Hz) | 727 | 119 | **−2.6 octaves** | a low foghorn, not an air horn |
| spectral centroid (Hz) | 1218 | 1098 | −10% | (similar brightness, wrong register) |
| HF energy > 2 kHz | 0.249 | 0.105 | **−58%** | darker, less piercing |
| spectral flatness (dB) | −33.5 | −42.1 | −8.6 dB | more tonal, less "air" |
| loop seam (seam ÷ mid-loop step) | 1.04 | 1.01 | — | **no click in either** |

The sample's own partials are 715 / 1441 / 2156 / 2883 Hz — a full harmonic series
at **715 Hz**. The fallback's 233/349/466 Hz chord is 2:3:4 of 116.5 Hz, i.e. a
periodicity two and a half octaves below the recording. That, not the level, is the
difference a listener notices first.

## The change (five values in one function, no new nodes)

`src/horn.js` now defines the voice as named constants:

| constant | was | now | why |
|---|---|---|---|
| `SYNTH_FREQUENCIES` | 233.08 / 349.23 / 466.16 | **715 / 1441 / 2156** | the sample's own measured partials |
| `SYNTH_OSC_TYPE` | sawtooth | **triangle** | a sawtooth at 715 Hz measures a 3.3 kHz centroid (2.7× the sample); triangle lands at 1.5 kHz |
| `SYNTH_LEVEL` | 0.5 | **0.8** | −4.3 dB → matched loudness |
| `SYNTH_BLAST_S` | 1.2 | **0.9** | 0.80 s audible vs the sample's 0.84 |
| `SYNTH_ATTACK_S` | 0.04 | **0.14** | matches the recording's ~180 ms swell |

## After (this branch)

| metric | sample | fallback | delta | verdict (tolerance) |
|---|---|---|---|---|
| audible duration (s) | 0.84 | 0.797 | −5% | PASS (0.85–1.15×) |
| peak (dBFS) | −3.2 | −5.3 | −2.1 dB | PASS (3 dB) |
| RMS (dBFS) | −14.0 | −12.9 | +1.1 dB | PASS (1.5 dB) |
| attack to 90% (ms) | 180 | 140 | −40 ms | — |
| fundamental (Hz) | 727 | 727 | 0% | PASS (0.85–1.18×) |
| spectral centroid (Hz) | 1218 | 1516 | +24% | PASS (0.75–1.3×) |
| HF energy > 2 kHz | 0.249 | 0.342 | +0.09 | — |
| spectral flatness (dB) | −33.5 | −87.6 | −54 dB | **residual** |
| loop seam (seam ÷ mid-loop) | 1.04 | 1.01 | — | no click in either |

Distance from the sample (sum of normalised deltas; 0 = identical): **19.6 → 3.2**.
`node tools/audio-parity.mjs --check` now exits 0 (IN PARITY).

## What a listener still notices (reported, not fixed)

- **The recording has air; the fallback is a pure tone.** Flatness −33.5 dB vs
  −87.6 dB. The sample is a noisy recording, the fallback is three clean
  oscillators. Priced fix: a white-noise bed at gain 0.06 into the same envelope
  lands flatness at −24.7 dB, centroid 1574 Hz, RMS −13.2 dBFS — all inside
  tolerance — at the cost of **one extra buffer source node**. Deliberately not
  implemented: it is the only candidate that adds a node rather than changing a
  value, and it is a character choice someone should hear first.
- **Transient**: peak is 2.1 dB softer and the crest factor is lower (triangle vs a
  recording with sharp attacks). RMS (loudness) is matched, which is the audible
  part; the peak is reported and loosely gated for that reason.
- **Graininess**: zero-crossing rate 9.6 kHz vs 3.0 kHz — the triangle chord's
  transitions are steeper. Centroid and HF ratio are inside tolerance, so this is
  not "brighter", but it is the next thing to measure if the fallback ever sounds
  "too smooth".

## Not a problem

The **loop seam is clean in both paths** (seam step is the same as mid-loop, 1.04
for the shipped 0.24–0.34 s loop and 1.01 for the fallback, which has no buffer
boundary at all). No click, no 10 Hz buzz — nothing to fix there.
