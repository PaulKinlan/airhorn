#!/usr/bin/env node
/*
 * tools/audio-parity.mjs - does the synthesised fallback actually sound like the
 * sample? (airhorn-u7s)
 *
 * The fallback in src/horn.js (#playSynth) was proven *audible* (the browser
 * suite measures level), never proven *similar* to the sample. This tool renders
 * one blast down each REAL path in headless Chromium, through an
 * OfflineAudioContext (deterministic: no output device, no timing jitter), and
 * reports measurable characteristics side by side:
 *
 *   - audible duration (first .. last sample above -60 dBFS)
 *   - peak and RMS level (dBFS), attack (first 20 ms frame reaching 90% of peak)
 *   - spectral centroid (brightness), HF energy ratio above 2 kHz, spectral
 *     flatness in dB (high = noise-like, very low = tonal) and the three
 *     strongest partials
 *   - fundamental (autocorrelation, 60-1200 Hz): is it the same pitch?
 *   - the loop seam: the sample-to-sample step at each loop boundary compared
 *     with the step in the middle of the loop, which is what a click sounds like
 *
 * Both paths go through the real module: Horn.start() on an injected
 * OfflineAudioContext presented as running (an offline port is 'suspended' until
 * startRendering(), and Horn refuses a suspended context - airhorn-x4l/not0), so
 * a render that was never started fails the tool instead of comparing silence.
 * The sample path uses the shipped asset; the synth path
 * points audioSrc at a 404, which is exactly how the fallback is reached in
 * production (sample unavailable or undecodable). usingFallback is reported per
 * render, so a broken asset can never silently compare the synth with itself.
 *
 * --sweep additionally renders a faithful replica of the #playSynth graph with
 * candidate parameters (level, blast length, attack, oscillator type/frequency
 * scale, optional noise bed), verifies the replica against the real path at the
 * shipped values, and ranks each candidate by measured distance from the sample.
 *
 * --check turns the measurement into a gate: exit 2 when the fallback is outside
 * the documented tolerance. It is deliberately not part of the fast gate (it
 * launches a browser); run it on demand or nightly.
 *
 * Usage:
 *   node tools/audio-parity.mjs                       # table + verdict
 *   node tools/audio-parity.mjs --json preview/audio-parity.json
 *   node tools/audio-parity.mjs --sweep               # rank candidate parameters
 *   node tools/audio-parity.mjs --check               # exit 2 if out of parity
 */

import http from 'node:http';
import fs from 'node:fs';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installSignalExit } from '../tests/support/signal-exit.mjs';
import { connectPage, launchChrome } from './lib/chrome.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const jsonIndex = args.indexOf('--json');
const jsonOut = jsonIndex >= 0 ? args[jsonIndex + 1] : null;
const sweep = args.includes('--sweep');
const check = args.includes('--check');

// Parity tolerance for --check: "what a listener would notice".
// A level change under ~1.5 dB reads as the same loudness, a length change over
// 15% as a different honk, a centroid change over 25% as a different instrument,
// and a fundamental more than a tone away as a different pitch.
const TOLERANCE = {
  // Peak is the transient; a blast whose crest factor differs slightly can be
  // the same loudness with a different peak, so loudness is gated on RMS and
  // peak is gated loosely (it is still reported, and still compared).
  peakDb: 3,
  rmsDb: 1.5,
  durationRatio: [0.85, 1.15],
  centroidRatio: [0.75, 1.3],
  fundamentalRatio: [0.85, 1.18], // ~a semitone and a half either way
};

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Mutation seam (airhorn-nxuv.3): under test mode, the synth render's
// samples are replaced with white noise, which has no pitch - the
// autocorrelation returns null and the pitch verdict must FAIL as
// 'unmeasurable', never pass on a defaulted ratio. Honoured only with
// PARITY_TEST_MODE=1: this is a production entry point, and a stray
// PARITY_SYNTH_NOISE in the environment must never fabricate a result.
const PARITY_TEST_MODE = process.env.PARITY_TEST_MODE === '1';
const SYNTH_NOISE_SEAM = PARITY_TEST_MODE && process.env.PARITY_SYNTH_NOISE === '1';
if (process.env.PARITY_SYNTH_NOISE && !PARITY_TEST_MODE) {
  console.warn('PARITY_SYNTH_NOISE is honoured only with PARITY_TEST_MODE=1 - ignoring it and running the real measurement.');
}

// The page-side measurement. Everything numeric happens here, next to the
// Float32 sample data, so only numbers cross the CDP boundary.
const page = `<!doctype html>
<meta charset="utf-8">
<title>audio parity</title>
<script type="module">
(() => {
  const SR = 48000;

  // ---- signal analysis -----------------------------------------------------

  const toDbfs = (linear) => (linear > 0 ? 20 * Math.log10(linear) : -Infinity);
  const round = (value, digits = 3) => (Number.isFinite(value) ? +value.toFixed(digits) : null);

  // Iterative radix-2 FFT, in place. size must be a power of two.
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const angle = (-2 * Math.PI) / len;
      const wRe = Math.cos(angle);
      const wIm = Math.sin(angle);
      for (let start = 0; start < n; start += len) {
        let curRe = 1;
        let curIm = 0;
        for (let k = 0; k < len / 2; k += 1) {
          const uRe = re[start + k];
          const uIm = im[start + k];
          const vRe = re[start + k + len / 2] * curRe - im[start + k + len / 2] * curIm;
          const vIm = re[start + k + len / 2] * curIm + im[start + k + len / 2] * curRe;
          re[start + k] = uRe + vRe;
          im[start + k] = uIm + vIm;
          re[start + k + len / 2] = uRe - vRe;
          im[start + k + len / 2] = uIm - vIm;
          const nextRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = nextRe;
        }
      }
    }
  }

  function rmsOf(data, from, to) {
    const start = Math.max(0, from);
    const end = Math.min(to, data.length);
    if (end <= start) return 0;
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += data[i] * data[i];
    return Math.sqrt(sum / (end - start));
  }

  function envelope(data, frameMs = 20) {
    const size = Math.round((frameMs / 1000) * SR);
    const out = [];
    for (let start = 0; start + size <= data.length; start += size) {
      out.push({ t: round(start / SR, 3), rms: round(rmsOf(data, start, start + size), 5) });
    }
    return out;
  }

  // Audible extent: exclude the silent head/tail so "how long is the blast" is
  // comparable rather than "how long did we render".
  function audibleSpan(data, floorDbfs = -60) {
    const floor = Math.pow(10, floorDbfs / 20);
    let first = -1;
    let last = -1;
    for (let i = 0; i < data.length; i += 1) {
      if (Math.abs(data[i]) > floor) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first < 0) return { startS: 0, endS: 0, durationS: 0 };
    return { startS: round(first / SR, 3), endS: round(last / SR, 3), durationS: round((last - first) / SR, 3) };
  }

  function peakOf(data) {
    let peak = 0;
    let at = 0;
    for (let i = 0; i < data.length; i += 1) {
      const abs = Math.abs(data[i]);
      if (abs > peak) {
        peak = abs;
        at = i;
      }
    }
    return { peak: round(peak, 4), atS: round(at / SR, 3) };
  }

  /**
   * Fundamental by normalised autocorrelation on a 3x-decimated sustained
   * window (16 kHz is still 13x the 1.2 kHz search ceiling). Cheaper and less
   * fooled by harmonics than taking the strongest FFT bin.
   */
  function fundamentalHz(data, from, to, { minHz = 60, maxHz = 1200 } = {}) {
    const decimation = 3;
    const rate = SR / decimation;
    const samples = [];
    for (let i = from; i < Math.min(to, data.length); i += decimation) samples.push(data[i]);
    const minLag = Math.max(2, Math.floor(rate / maxHz));
    const maxLag = Math.min(Math.ceil(rate / minHz), Math.floor(samples.length / 2));
    if (samples.length < maxLag * 2) return null;

    const correlation = new Float64Array(maxLag + 2);
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let num = 0;
      let energyA = 0;
      let energyB = 0;
      const limit = samples.length - lag;
      for (let i = 0; i < limit; i += 1) {
        const a = samples[i];
        const b = samples[i + lag];
        num += a * b;
        energyA += a * a;
        energyB += b * b;
      }
      correlation[lag] = num / (Math.sqrt(energyA * energyB) || 1);
    }

    let peak = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1) peak = Math.max(peak, correlation[lag]);
    if (peak <= 0) return null;

    // Take the FIRST strong local maximum, not the global one: when a low
    // harmonic is quiet and the 4th is loud (the sampled horn is like this),
    // the correlation peak at twice the period is almost as tall, but the
    // pitch a listener hears is the shortest period that explains the signal.
    for (let lag = minLag + 1; lag < maxLag; lag += 1) {
      if (
        correlation[lag] >= correlation[lag - 1] &&
        correlation[lag] >= correlation[lag + 1] &&
        correlation[lag] >= peak * 0.9
      ) {
        return { hz: Math.round(rate / lag), confidence: round(correlation[lag], 3) };
      }
    }
    let bestLag = minLag;
    for (let lag = minLag; lag <= maxLag; lag += 1) if (correlation[lag] > correlation[bestLag]) bestLag = lag;
    return { hz: Math.round(rate / bestLag), confidence: round(correlation[bestLag], 3) };
  }

  /**
   * One spectrum over the sustained part of the render: centroid (brightness),
   * HF ratio above 2 kHz, flatness in dB (tonal vs noise-like) and the three
   * strongest partials.
   */
  function spectrumStats(data, fromSample, toSample) {
    const size = 4096;
    const hop = 2048;
    const floor = Math.pow(10, -40 / 20);
    const window = new Float32Array(size);
    for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    const binHz = SR / size;

    let weighted = 0;
    let energyTotal = 0;
    let hfEnergy = 0;
    let flatnessDbSum = 0;
    let frames = 0;
    const averagePower = new Float64Array(size / 2);

    for (let start = Math.max(0, fromSample); start + size <= Math.min(toSample, data.length); start += hop) {
      if (rmsOf(data, start, start + size) < floor) continue;
      const re = new Float64Array(size);
      const im = new Float64Array(size);
      for (let i = 0; i < size; i += 1) re[i] = data[start + i] * window[i];
      fft(re, im);

      let num = 0;
      let den = 0;
      let logSum = 0;
      let linSum = 0;
      let counted = 0;
      for (let k = 1; k < size / 2; k += 1) {
        const power = re[k] * re[k] + im[k] * im[k];
        averagePower[k] += power;
        num += k * binHz * power;
        den += power;
        if (k * binHz >= 2000) hfEnergy += power;
        // Flatness over 100 Hz - 10 kHz: below is rumble, above is codec noise.
        if (k * binHz >= 100 && k * binHz <= 10000 && power > 0) {
          logSum += Math.log(power);
          linSum += power;
          counted += 1;
        }
      }
      if (den <= 0 || counted === 0) continue;
      weighted += num;
      energyTotal += den;
      flatnessDbSum += 10 * Math.log10(Math.exp(logSum / counted) / (linSum / counted));
      frames += 1;
    }

    const partials = [];
    for (let k = 2; k < size / 2 - 1; k += 1) {
      const power = averagePower[k];
      if (power > averagePower[k - 1] && power >= averagePower[k + 1]) {
        partials.push({ hz: Math.round(k * binHz), power });
      }
    }
    partials.sort((a, b) => b.power - a.power);

    return {
      centroidHz: energyTotal > 0 ? Math.round(weighted / energyTotal) : null,
      hfRatio: energyTotal > 0 ? round(hfEnergy / energyTotal, 3) : null,
      flatnessDb: frames > 0 ? round(flatnessDbSum / frames, 1) : null,
      partialsHz: partials.slice(0, 8).map((partial) => partial.hz),
      frames,
    };
  }

  function zeroCrossRate(data, from, to) {
    let crossings = 0;
    let samples = 0;
    const start = Math.max(1, from);
    const end = Math.min(to, data.length);
    for (let i = start; i < end; i += 1) {
      if ((data[i - 1] <= 0 && data[i] > 0) || (data[i - 1] >= 0 && data[i] < 0)) crossings += 1;
      samples += 1;
    }
    return samples > 0 ? Math.round(crossings * (SR / samples)) : 0;
  }

  /**
   * The loop seam, as a listener hears it: a click is a sample-to-sample jump at
   * the loop boundary that is much bigger than the waveform's normal step.
   *
   * The sample path plays to loopEnd, jumps back to loopStart, and repeats every
   * (loopEnd - loopStart). The seam step is the largest |x[n] - x[n-1]| within
   * +/-1 ms of each boundary; the control is the same statistic in the middle of
   * the loop, so a signal that is simply full of steep slopes cannot look
   * "clicky" by construction. A continuous oscillator (the synth) has no buffer
   * boundary at all, so its numbers are a control, not a seam.
   */
  function seamProfile(data) {
    const loopStart = 0.24;
    const loopEnd = 0.34;
    const loopLength = loopEnd - loopStart;
    const tolerance = Math.round(0.001 * SR);
    const step = (from, to) => {
      let max = 0;
      for (let i = Math.max(1, from); i < Math.min(to, data.length); i += 1) {
        max = Math.max(max, Math.abs(data[i] - data[i - 1]));
      }
      return max;
    };
    const seams = [];
    const controls = [];
    for (let t = loopEnd; t + loopLength < data.length / SR; t += loopLength) {
      const centre = Math.round(t * SR);
      const controlCentre = Math.round((t + loopLength / 2) * SR);
      seams.push(step(centre - tolerance, centre + tolerance));
      controls.push(step(controlCentre - tolerance, controlCentre + tolerance));
    }
    const median = (values) => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    };
    const seamMedian = median(seams);
    const controlMedian = median(controls);
    const seamMax = seams.length ? Math.max(...seams) : 0;
    const signalRms = rmsOf(data, 0, data.length);
    return {
      boundaries: seams.length,
      seamMedianStep: round(seamMedian, 4),
      controlMedianStep: round(controlMedian, 4),
      // ~1 means the boundary is indistinguishable from the middle of the loop.
      seamRatio: controlMedian > 0 ? round(seamMedian / controlMedian, 2) : null,
      seamPeakOverRmsDb: signalRms > 0 ? round(toDbfs(seamMax / signalRms), 1) : null,
      seamPeakStep: round(seamMax, 4),
    };
  }

  function summarise(data, { loop }) {
    const span = audibleSpan(data);
    const { peak, atS } = peakOf(data);

    // Attack: the first 20 ms frame reaching 90% of the loudest frame.
    const env = envelope(data);
    const peakFrame = env.reduce((max, frame) => Math.max(max, frame.rms), 0);
    const attackFrame = env.find((frame) => frame.rms >= peakFrame * 0.9);

    const from = Math.round((span.startS + 0.1) * SR);
    const to = Math.round((span.endS - 0.1) * SR);
    const spectrum = spectrumStats(data, from, Math.max(from + 4096, to));
    const fundamental = fundamentalHz(data, from, Math.max(from + 4096, to));

    return {
      durationS: span.durationS,
      startS: span.startS,
      endS: span.endS,
      peakDbfs: round(toDbfs(peak), 1),
      peak,
      peakAtS: atS,
      rmsDbfs: round(toDbfs(rmsOf(data, Math.round(span.startS * SR), Math.round(span.endS * SR))), 1),
      attackMs: attackFrame ? Math.round(attackFrame.t * 1000) : null,
      centroidHz: spectrum.centroidHz,
      hfRatio: spectrum.hfRatio,
      flatnessDb: spectrum.flatnessDb,
      partialsHz: spectrum.partialsHz,
      fundamentalHz: fundamental ? fundamental.hz : null,
      fundamentalConfidence: fundamental ? fundamental.confidence : null,
      zeroCrossRateHz: zeroCrossRate(data, from, Math.max(from + 1, to)),
      envelope: env,
      loop: loop ? seamProfile(data) : null,
    };
  }

  // ---- rendering -----------------------------------------------------------
  // Both paths instantiate the REAL Horn class on an injected
  // OfflineAudioContext. The sample path uses the real asset; the synth path
  // points audioSrc at a 404, which is how the fallback is reached in production.

  // An OfflineAudioContext is 'suspended' until startRendering(), but Horn.start()
  // refuses to schedule into a suspended context - a real production guard
  // (airhorn-x4l): a tab whose audio the browser is still holding back must not
  // report a horn nobody can hear, nor fire a delayed blast on a later click. In
  // a tab the press itself resumes the context, so the graph Horn plays into is a
  // RUNNING one; this port emulates exactly that. Only 'state' is overridden - it
  // is the one property the guard reads - and every method is bound to the real
  // port, because Web Audio refuses to run one off another receiver.
  function runningPort(ctx) {
    const reported = ctx.state === 'suspended' ? 'running' : ctx.state;
    return new Proxy(ctx, {
      get(target, key) {
        if (key === 'state') return reported;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  async function renderHorn({ audioSrc, loop, seconds, forceNoise = false }) {
    const { Horn } = await import('/src/horn.js');
    const ctx = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
    const horn = new Horn({ audioContext: runningPort(ctx), ...(audioSrc ? { audioSrc } : {}) });
    const started = await horn.start({ loop });
    const rendered = await ctx.startRendering();
    const data = rendered.getChannelData(0);
    if (forceNoise) {
      // Mutation seam (airhorn-nxuv.3): white noise is unpitched, so the
      // autocorrelation returns null and the pitch verdict must fail as
      // 'unmeasurable' - the proof the check can fail that way.
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    let checksum = 0;
    for (let i = 0; i < data.length; i += 97) checksum = (checksum * 31 + Math.round(data[i] * 1e6)) % 1e12;
    return { started, data, usingFallback: horn.usingFallback === true, checksum };
  }

  // A render that never started is silence, and silence compares as silence: the
  // real drift (a context the module refuses) then surfaces as whichever check
  // runs first - airhorn-not0 arrived as "the synth render did not use the
  // fallback", which named the wrong symptom. Assert the precondition per path.
  function mustStart(name, render) {
    if (render.started !== true) {
      throw new Error(
        'the ' + name + ' render did not start: Horn.start() resolved ' + JSON.stringify(render.started) +
        ' - the injected context was refused, so this path cannot be measured at all',
      );
    }
    return render;
  }

  // Mirrors the constants in src/horn.js. The replica's fidelity check below
  // fails loudly (a non-zero delta) if this drifts from the real module.
  const SHIPPED_SYNTH = {
    frequencies: [715, 1441, 2156],
    oscType: 'triangle',
    masterGain: 0.8,
    blastSeconds: 0.9,
    attackS: 0.14,
    noiseGain: 0,
  };

  /**
   * A faithful replica of src/horn.js #playSynth with its parameters lifted out,
   * used only to price candidate values. Validated against the real path at the
   * shipped values (the report prints that fidelity check).
   */
  async function renderSynthReplica({ seconds, frequencies, oscType, masterGain, blastSeconds, attackS, noiseGain }) {
    const ctx = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
    const now = 0;

    const master = ctx.createGain();
    master.connect(ctx.destination);
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(masterGain, now + attackS);

    const oscillators = [];
    for (const freq of frequencies) {
      const osc = ctx.createOscillator();
      osc.type = oscType;
      osc.frequency.setValueAtTime(freq, now);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.02, now + 0.08);
      const oscGain = ctx.createGain();
      oscGain.gain.value = 1 / frequencies.length;
      osc.connect(oscGain);
      oscGain.connect(master);
      osc.start(now);
      oscillators.push(osc);
    }

    if (noiseGain > 0) {
      const length = Math.round(SR * seconds);
      const buffer = ctx.createBuffer(1, length, SR);
      const channel = buffer.getChannelData(0);
      // Deterministic PRNG so repeated runs price the same noise bed.
      let seed = 12345;
      for (let i = 0; i < length; i += 1) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        channel[i] = (seed / 2147483648) * 2 - 1;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const mix = ctx.createGain();
      mix.gain.value = noiseGain;
      source.connect(mix);
      mix.connect(master);
      source.start(now);
      source.stop(now + blastSeconds);
    }

    master.gain.setValueAtTime(masterGain, now + blastSeconds - 0.2);
    master.gain.exponentialRampToValueAtTime(0.0001, now + blastSeconds);
    for (const osc of oscillators) osc.stop(now + blastSeconds);

    const rendered = await ctx.startRendering();
    return rendered.getChannelData(0);
  }

  window.__parity = async (options = {}) => {
    const seconds = options.seconds ?? 2.6;
    const missingSrc = '/sounds/__no-such-sample__.mp3';
    const out = { sampleRate: SR, seconds, paths: {}, replica: null, sweep: null };

    const sampleBlast = mustStart('sample blast', await renderHorn({ loop: false, seconds }));
    if (sampleBlast.usingFallback) {
      throw new Error('the sample render fell back to the synth: the shipped mp3 did not load');
    }
    out.paths.sampleBlast = {
      started: sampleBlast.started,
      usingFallback: sampleBlast.usingFallback,
      checksum: sampleBlast.checksum,
      ...summarise(sampleBlast.data, { loop: false }),
    };

    const synthBlast = mustStart('synth blast', await renderHorn({ audioSrc: missingSrc, loop: false, seconds, forceNoise: ${SYNTH_NOISE_SEAM} }));
    if (synthBlast.usingFallback !== true) {
      throw new Error('the synth render did not use the fallback: the 404 sentinel was served');
    }
    out.paths.synthBlast = {
      started: synthBlast.started,
      usingFallback: synthBlast.usingFallback,
      checksum: synthBlast.checksum,
      ...summarise(synthBlast.data, { loop: false }),
    };

    const sampleLoop = mustStart('sample loop', await renderHorn({ loop: true, seconds }));
    out.paths.sampleLoop = {
      started: sampleLoop.started,
      usingFallback: sampleLoop.usingFallback,
      checksum: sampleLoop.checksum,
      ...summarise(sampleLoop.data, { loop: true }),
    };

    const synthLoop = mustStart('synth loop', await renderHorn({ audioSrc: missingSrc, loop: true, seconds }));
    out.paths.synthLoop = {
      started: synthLoop.started,
      usingFallback: synthLoop.usingFallback,
      checksum: synthLoop.checksum,
      ...summarise(synthLoop.data, { loop: true }),
    };

    // The replica must reproduce the real fallback before its numbers price
    // anything at all.
    const replicaData = await renderSynthReplica({ seconds, ...SHIPPED_SYNTH });
    const replica = summarise(replicaData, { loop: false });
    out.replica = {
      shipped: {
        durationS: replica.durationS,
        peakDbfs: replica.peakDbfs,
        rmsDbfs: replica.rmsDbfs,
        centroidHz: replica.centroidHz,
        fundamentalHz: replica.fundamentalHz,
      },
      real: {
        durationS: out.paths.synthBlast.durationS,
        peakDbfs: out.paths.synthBlast.peakDbfs,
        rmsDbfs: out.paths.synthBlast.rmsDbfs,
        centroidHz: out.paths.synthBlast.centroidHz,
        fundamentalHz: out.paths.synthBlast.fundamentalHz,
      },
    };
    out.replica.delta = {
      durationS: round(out.replica.shipped.durationS - out.replica.real.durationS, 3),
      peakDb: round(out.replica.shipped.peakDbfs - out.replica.real.peakDbfs, 2),
      rmsDb: round(out.replica.shipped.rmsDbfs - out.replica.real.rmsDbfs, 2),
      centroidHz: out.replica.shipped.centroidHz - out.replica.real.centroidHz,
      fundamentalHz: out.replica.shipped.fundamentalHz - out.replica.real.fundamentalHz,
    };

    if (options.sweep) {
      // Smallest-change-first: level, length, attack and the oscillator voice are
      // one parameter each. Pitch is the question the measurement answers, so the
      // sweep walks the oscillator voice up until the measured fundamental (the
      // shortest strong period) matches the sample's.
      const base = { masterGain: 0.88, blastSeconds: 0.9, attackS: 0.14 };
      const candidates = [
        { label: 'shipped', ...SHIPPED_SYNTH },
        { label: 'level+length', masterGain: 0.88, blastSeconds: 0.9 },
        { label: 'level+length+attack', ...base },
      ];

      for (const oscType of ['sawtooth', 'triangle']) {
        for (const scale of [1.5, 2, 3, 4, 5, 6.14]) {
          candidates.push({ label: oscType + ' x' + scale, ...base, oscType, frequencyScale: scale });
        }
      }
      for (const scale of [3, 4, 6.14]) {
        // Square waves carry more energy per harmonic: price them quieter.
        candidates.push({ label: 'square x' + scale, ...base, masterGain: 0.45, oscType: 'square', frequencyScale: scale });
      }
      for (const noiseGain of [0.05, 0.1, 0.2]) {
        candidates.push({ label: 'sawtooth x6.14 +noise' + noiseGain, ...base, frequencyScale: 6.14, noiseGain });
      }

      // The sample's own measured partials: 715, 1441, 2156 Hz - a complete
      // harmonic series (even and odd) with the fundamental at ~715 Hz. Pricing
      // the three oscillators AS that series tests the smallest change that
      // matches both the pitch and the partial spacing.
      const samplePartials = [715, 1430, 2145];
      for (const masterGain of [0.72, 0.76, 0.8, 0.84, 0.88]) {
        candidates.push({
          label: 'triangle 715/1430/2145 @' + masterGain,
          ...base,
          oscType: 'triangle',
          masterGain,
          frequenciesHz: samplePartials,
        });
      }
      for (const noiseGain of [0.06, 0.1, 0.15]) {
        candidates.push({
          label: 'triangle 715/1430/2145 @0.8 +noise' + noiseGain,
          ...base,
          oscType: 'triangle',
          masterGain: 0.8,
          frequenciesHz: samplePartials,
          noiseGain,
        });
      }
      for (const oscType of ['sawtooth']) {
        for (const masterGain of [0.88, 0.7]) {
          candidates.push({
            label: oscType + ' 715/1430/2145 @' + masterGain,
            ...base,
            oscType,
            masterGain,
            frequenciesHz: samplePartials,
          });
        }
      }
      for (const noiseGain of [0.05, 0.1]) {
        candidates.push({
          label: 'saw 715/1430/2145 @0.88 +noise' + noiseGain,
          ...base,
          masterGain: 0.88,
          frequenciesHz: samplePartials,
          noiseGain,
        });
      }

      const priced = [];
      for (const candidate of candidates) {
        const { label, frequencyScale = 1, frequenciesHz, ...params } = candidate;
        const merged = { ...SHIPPED_SYNTH, ...params };
        const frequencies = frequenciesHz
          ? frequenciesHz.slice()
          : SHIPPED_SYNTH.frequencies.map((freq) => +(freq * frequencyScale).toFixed(2));
        const data = await renderSynthReplica({ seconds, ...merged, frequencies });
        const summary = summarise(data, { loop: false });
        priced.push({
          label,
          frequencyScale,
          ...merged,
          frequencies,
          durationS: summary.durationS,
          peakDbfs: summary.peakDbfs,
          rmsDbfs: summary.rmsDbfs,
          attackMs: summary.attackMs,
          centroidHz: summary.centroidHz,
          hfRatio: summary.hfRatio,
          flatnessDb: summary.flatnessDb,
          fundamentalHz: summary.fundamentalHz,
          partialsHz: summary.partialsHz,
        });
      }
      out.sweep = { candidates: priced };
    }

    return out;
  };

  window.__ready = true;
})();
</script>
`;

// --- static server over the repo root ---------------------------------------
// The built site serves public/ at the root, so /sounds/airhorn.mp3 (the URL
// Horn requests) must resolve to public/sounds/airhorn.mp3, while /src/horn.js
// resolves from the repo root.

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/audio-parity.html' || url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }
  const relative = path.normalize(url).replace(/^([/\\])+/, '');
  const candidates = [path.join(root, relative), path.join(root, 'public', relative)];
  const filePath = candidates.find(
    (candidate) => fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory(),
  );
  if (!filePath || !filePath.startsWith(root)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

// --- reporting --------------------------------------------------------------

const show = (value, digits = 1) =>
  value === null || value === undefined ? 'n/a' : Number(value).toFixed(digits);

/** Distance of a render from the sample, in tolerance units (0 = identical). */
function distance(sample, render) {
  const safeLog2 = (value) => (value > 0 ? Math.log2(value) : null);
  const durationRatio = sample.durationS > 0 ? render.durationS / sample.durationS : 1;
  const centroidRatio = sample.centroidHz > 0 && render.centroidHz > 0 ? render.centroidHz / sample.centroidHz : 1;
  const fundamentalRatio =
    sample.fundamentalHz && render.fundamentalHz ? render.fundamentalHz / sample.fundamentalHz : 1;
  const terms = [
    Math.abs(render.peakDbfs - sample.peakDbfs) / TOLERANCE.peakDb,
    Math.abs(render.rmsDbfs - sample.rmsDbfs) / TOLERANCE.rmsDb,
    Math.abs(safeLog2(durationRatio) ?? 0) / 0.25,
    Math.abs(safeLog2(centroidRatio) ?? 0) / 0.4,
    Math.abs(safeLog2(fundamentalRatio) ?? 0) / 0.25,
    Math.abs((render.hfRatio ?? 0) - (sample.hfRatio ?? 0)) / 0.15,
  ];
  return +terms.reduce((sum, term) => sum + term, 0).toFixed(2);
}

function printTable(results) {
  const sample = results.paths.sampleBlast;
  const synth = results.paths.synthBlast;
  const rows = [
    ['audible duration (s)', sample.durationS, synth.durationS],
    ['peak (dBFS)', sample.peakDbfs, synth.peakDbfs],
    ['RMS (dBFS)', sample.rmsDbfs, synth.rmsDbfs],
    ['attack to 90% (ms)', sample.attackMs, synth.attackMs],
    ['fundamental (Hz)', sample.fundamentalHz, synth.fundamentalHz],
    ['spectral centroid (Hz)', sample.centroidHz, synth.centroidHz],
    ['HF energy >2kHz (ratio)', sample.hfRatio, synth.hfRatio],
    ['spectral flatness (dB)', sample.flatnessDb, synth.flatnessDb],
    ['zero-cross rate (Hz)', sample.zeroCrossRateHz, synth.zeroCrossRateHz],
    ['strongest partials (Hz)', (sample.partialsHz || []).join('/'), (synth.partialsHz || []).join('/')],
  ];
  const width = Math.max(...rows.map((row) => row[0].length));
  console.log(`${'one blast'.padEnd(width)}  ${'sample'.padStart(12)}  ${'synth'.padStart(12)}  delta`);
  for (const [label, sampleValue, synthValue] of rows) {
    const delta =
      typeof sampleValue === 'number' && typeof synthValue === 'number'
        ? `${synthValue - sampleValue >= 0 ? '+' : ''}${(synthValue - sampleValue).toFixed(2)}`
        : '';
    console.log(
      `${label.padEnd(width)}  ${String(typeof sampleValue === 'number' ? show(sampleValue, 2) : sampleValue).padStart(12)}  ${String(
        typeof synthValue === 'number' ? show(synthValue, 2) : synthValue,
      ).padStart(12)}  ${delta}`,
    );
  }

  console.log('\nRMS envelope (20 ms frames), every 50 ms:');
  for (const [name, render] of [
    ['sample', sample],
    ['synth', synth],
  ]) {
    const frames = render.envelope.filter((frame) => Math.abs((frame.t * 1000) % 50) < 20);
    console.log(`  ${name.padEnd(8)} ${frames.slice(0, 24).map((frame) => frame.rms.toFixed(3)).join(' ')}`);
  }

  console.log('\nloop seam (a click is a step much larger than the mid-loop step):');
  for (const [name, render] of [
    ['sampleLoop', results.paths.sampleLoop],
    ['synthLoop', results.paths.synthLoop],
  ]) {
    const seam = render.loop;
    console.log(
      `  ${name.padEnd(11)} ${seam.boundaries} boundary(s), seam step ${seam.seamMedianStep} vs mid-loop ${seam.controlMedianStep} (ratio ${seam.seamRatio}), peak step ${seam.seamPeakStep} = ${seam.seamPeakOverRmsDb} dB over RMS`,
    );
  }

  console.log('\nreplica fidelity (replica@shipped vs the real fallback):', JSON.stringify(results.replica.delta));
}

function verdict(results) {
  const sample = results.paths.sampleBlast;
  const synth = results.paths.synthBlast;
  const durationRatio = sample.durationS > 0 ? synth.durationS / sample.durationS : 0;
  const centroidRatio = sample.centroidHz > 0 ? synth.centroidHz / sample.centroidHz : 0;
  // Pitch is measured only when BOTH sides have a fundamental. The old
  // default was 1 - dead centre of the tolerance band - so an unpitched or
  // unmeasurable synth passed green (airhorn-nxuv.3). Unmeasurable is its
  // own FAILING outcome, named; it is never a pass.
  const pitchMeasured = Boolean(sample.fundamentalHz && synth.fundamentalHz);
  const fundamentalRatio = pitchMeasured ? synth.fundamentalHz / sample.fundamentalHz : null;
  const rows = [
    {
      metric: 'peak level',
      sample: `${sample.peakDbfs} dBFS`,
      synth: `${synth.peakDbfs} dBFS`,
      gap: `${(synth.peakDbfs - sample.peakDbfs).toFixed(1)} dB`,
      pass: Math.abs(synth.peakDbfs - sample.peakDbfs) <= TOLERANCE.peakDb,
    },
    {
      metric: 'RMS level',
      sample: `${sample.rmsDbfs} dBFS`,
      synth: `${synth.rmsDbfs} dBFS`,
      gap: `${(synth.rmsDbfs - sample.rmsDbfs).toFixed(1)} dB`,
      pass: Math.abs(synth.rmsDbfs - sample.rmsDbfs) <= TOLERANCE.rmsDb,
    },
    {
      metric: 'blast length',
      sample: `${sample.durationS} s`,
      synth: `${synth.durationS} s`,
      gap: `${((durationRatio - 1) * 100).toFixed(0)}%`,
      pass: durationRatio >= TOLERANCE.durationRatio[0] && durationRatio <= TOLERANCE.durationRatio[1],
    },
    {
      metric: 'pitch (fundamental)',
      sample: `${sample.fundamentalHz} Hz`,
      synth: `${synth.fundamentalHz} Hz`,
      gap: pitchMeasured ? `${((fundamentalRatio - 1) * 100).toFixed(0)}%` : 'unmeasurable (no fundamental on one or both sides)',
      pass: pitchMeasured &&
        fundamentalRatio >= TOLERANCE.fundamentalRatio[0] && fundamentalRatio <= TOLERANCE.fundamentalRatio[1],
    },
    {
      metric: 'brightness (centroid)',
      sample: `${sample.centroidHz} Hz`,
      synth: `${synth.centroidHz} Hz`,
      gap: `${((centroidRatio - 1) * 100).toFixed(0)}%`,
      pass: centroidRatio >= TOLERANCE.centroidRatio[0] && centroidRatio <= TOLERANCE.centroidRatio[1],
    },
  ];
  const width = Math.max(...rows.map((row) => row.metric.length));
  console.log(
    `\nverdict (tolerance: peak/RMS ${TOLERANCE.peakDb} dB, length ${TOLERANCE.durationRatio[0]}-${TOLERANCE.durationRatio[1]}x, pitch ${TOLERANCE.fundamentalRatio[0]}-${TOLERANCE.fundamentalRatio[1]}x, centroid ${TOLERANCE.centroidRatio[0]}-${TOLERANCE.centroidRatio[1]}x)`,
  );
  for (const row of rows) {
    console.log(`  ${row.pass ? 'PASS' : 'FAIL'}  ${row.metric.padEnd(width)}  sample ${row.sample}, synth ${row.synth}  (${row.gap})`);
  }
  return rows.every((row) => row.pass);
}

function printSweep(results) {
  if (!results.sweep) return;
  const sample = results.paths.sampleBlast;
  const priced = results.sweep.candidates
    .map((candidate) => ({ ...candidate, distance: distance(sample, candidate) }))
    .sort((a, b) => a.distance - b.distance);
  console.log(`\ncandidate parameters, ranked by distance from the sample (0 = identical):`);
  console.log(
    `  ${'distance'.padStart(8)}  ${'candidate'.padEnd(24)} ${'gain'.padStart(5)} ${'blast'.padStart(6)} ${'attack'.padStart(7)} ${'type'.padStart(9)} ${'scale'.padStart(6)} ${'dur'.padStart(6)} ${'peak'.padStart(6)} ${'RMS'.padStart(6)} ${'f0'.padStart(6)} ${'centroid'.padStart(9)}`,
  );
  for (const candidate of priced) {
    console.log(
      `  ${String(candidate.distance).padStart(8)}  ${candidate.label.padEnd(24)} ${String(candidate.masterGain).padStart(5)} ${String(candidate.blastSeconds).padStart(6)} ${String(candidate.attackS).padStart(7)} ${candidate.oscType.padStart(9)} ${String(candidate.frequencyScale).padStart(6)} ${String(candidate.durationS).padStart(6)} ${String(candidate.peakDbfs).padStart(6)} ${String(candidate.rmsDbfs).padStart(6)} ${String(candidate.fundamentalHz).padStart(6)} ${String(candidate.centroidHz).padStart(9)}`,
    );
  }
}

// A bound-kill (SIGTERM first, then the grace bound) bypasses the try/finally
// in main(), which is the only place the browser group is killed and the
// profile removed: a timed-out run leaked a 12-process chrome tree plus its
// /tmp profile (airhorn-w0ys). Register the live browser and do the same
// group-kill + profile removal on SIGTERM/SIGINT through the shared handler
// (tests/support/signal-exit.mjs, airhorn-4vfn). A process.on('exit') rm is
// NOT enough: no exit event fires on a signal default-death.
let liveBrowser = null;
installSignalExit(() => {
  const browser = liveBrowser;
  liveBrowser = null;
  // Inside the signal-exit grace: killNow() is the launcher's synchronous
  // sweep + tree kill + profile rm, sized to fit the grace (airhorn-gau8) -
  // the same teardown this tool used to spell out here (airhorn-2po9).
  browser?.killNow();
});

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  // One launcher owns chrome, its process tree and its profile (airhorn-2po9).
  let browser = null;
  let ws;
  try {
    browser = await launchChrome({ label: 'audio-parity', autoplay: true, timeoutMs: 15000, discoveryMs: 15000 });
    liveBrowser = browser;
    ws = await connectPage(browser, { label: 'audio-parity', timeoutMs: 15000 });
    let messageId = 1;
    const pending = new Map();
    const pageErrors = [];
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        pageErrors.push(details?.exception?.description || details?.text || 'uncaught exception');
      }
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    };
    const send = (method, params = {}) => {
      const id = messageId++;
      return new Promise((resolve, reject) => {
        // The reply wait is bounded like every wait in this file (airhorn-nbh9,
        // the class below airhorn-doek's ws-open bound): a peer that completes
        // the upgrade and then never replies rejects labelled instead of
        // parking the tool with its launch alive.
              const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP reply timeout: ${method} got no reply within 30000ms`));
      }, 30000);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) {
        throw new Error(
          `page evaluation failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/audio-parity.html` });

    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      ready = await evaluate('!!window.__ready').catch(() => false);
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error('the measurement page never became ready');

    const results = await evaluate(`window.__parity(${JSON.stringify({ sweep })})`);
    results.chrome = (await evaluate('navigator.userAgent')).match(/Chrome\/[\d.]+/)?.[0] ?? 'unknown';
    results.pageErrors = pageErrors;
    results.measuredAt = new Date().toISOString();
    results.distance = distance(results.paths.sampleBlast, results.paths.synthBlast);
    results.inParity = verdict(results);

    printTable(results);
    printSweep(results);

    if (jsonOut) {
      fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
      fs.writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
      console.log(`\nwrote ${jsonOut}`);
    }
    if (pageErrors.length > 0) throw new Error(`in-page errors: ${JSON.stringify(pageErrors)}`);

    console.log(
      `\naudio parity measured (${results.chrome}) - ${results.inParity ? 'IN PARITY' : 'OUT OF PARITY'} (distance ${results.distance})`,
    );
    if (check && !results.inParity) process.exitCode = 2;
  } finally {
    liveBrowser = null;
    // End every member of the launch before removing the profile: a main-only
    // kill leaves renderers/cache children that recreate files after the
    // removal (airhorn-jx9, airhorn-nn26). close() is the launcher's one
    // teardown: marker sweep, tree kill, then the rm with its retries, and it
    // does all of that before its first await.
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('audio-parity failed:', err.message);
  process.exit(1);
});
