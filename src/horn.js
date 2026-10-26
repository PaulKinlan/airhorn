/*
 *
 *  Air Horner
 *  Copyright 2015 Google Inc. All rights reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the 'License');
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an 'AS IS' BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License
 *
 */

// The fallback voice (airhorn-u7s). These five values are what make the synth
// blast measure like the sample - same pitch, loudness, length, attack and
// brightness - rather than merely audible. `tools/audio-parity.mjs` renders one
// blast down both real paths through an OfflineAudioContext and reports the
// numbers; run it (with --check to gate, --sweep to re-price alternatives)
// before changing any of them:
//
//   fundamental ~715 Hz (the sample's own partials are 715/1441/2156 Hz, a full
//   harmonic series - the old 233/349/466 Hz chord had a 116 Hz periodicity,
//   roughly 2.6 octaves below the sample)
//   RMS -13.2 dBFS vs the sample's -14.0, peak -5.4 vs -3.2 (the old level,
//   0.5, was 4.3 dB quiet; 0.8 keeps both within the parity tolerance)
//   audible blast 0.80 s vs the sample's 0.84 (the old 1.2 s was 33% long)
//   attack 0.14 s, matching the recording's ~180 ms swell
//   triangle, not sawtooth: a sawtooth at 715 Hz puts the centroid at ~3.3 kHz
//   (nearly 3x the sample's 1.2 kHz); a triangle lands at 1.45 kHz
const SYNTH_LEVEL = 0.8;
const SYNTH_ATTACK_S = 0.14;
const SYNTH_BLAST_S = 0.9;
const SYNTH_FREQUENCIES = [715, 1441, 2156];
const SYNTH_OSC_TYPE = 'triangle';

/*
 * How long the context stays running after the last sound ends (airhorn-1umb).
 *
 * A running-but-SILENT AudioContext is not free: measured on this VM it costs
 * ~0.7% of one core in the renderer, and it keeps paying it while the page is
 * hidden (tools/idle-cost.mjs: A 0.05% with no context, B 0.80% running, C 0.10%
 * suspended, D 0.75% running while hidden). Suspending it when the horn is idle
 * takes the whole page back to the counters it has at first load: no timers, no
 * animation frames, no network.
 *
 * It is a short grace rather than immediate so a rapid second honk stays on the
 * already-running graph; resuming costs a few milliseconds and the next press
 * pays it (start() resumes before scheduling anything).
 */
const IDLE_SUSPEND_MS = 300;

/*
 * How long a start() waits for the audio graph to resume before it reports that
 * the press produced no sound (airhorn-dxug).
 *
 * Resuming is not instant on a busy machine: on this 2-core VM under load it
 * routinely takes several hundred milliseconds, and the old fixed 100 ms bound
 * gave up mid-resume, so a perfectly good press was refused and announced as
 * "the horn needs a tap". Widening the bound alone is NOT the fix - a tab that
 * has never been activated keeps its context suspended (that is precisely what
 * tests/shortcuts.test.mjs case 9 pins: do not CLAIM to be playing while the
 * graph is suspended), and waiting longer there only makes the app lie for
 * longer. So the bound follows the one fact that separates the two cases: has
 * this document ever had a user gesture? Without one the context is blocked for
 * policy reasons and the refusal must stay prompt and honest; with one, a late
 * resume is only the machine being slow, and the press that is still physically
 * held deserves its sound.
 */
const RESUME_BOUND_MS = 100;
const ACTIVATED_RESUME_BOUND_MS = 1500;

/*
 * The two states a suspended context can be in look identical from here, and
 * they want opposite treatment (airhorn-dxug):
 *
 *   never played, never activated -> the browser is refusing audio for policy
 *     reasons and waiting cannot help. Refuse promptly, so the app retracts its
 *     optimistic "pressed" state inside the window tests/shortcuts.test.mjs case
 *     9 samples instead of claiming a horn nobody can hear (airhorn-x4l).
 *   played before, or an activation just happened -> the graph is only idling
 *     (airhorn-1umb suspends it 300 ms after the last sound), and resuming is a
 *     question of how busy the machine is. Waiting is what delivers the press.
 */
const hasBeenActivated = () => {
  try {
    return globalThis.navigator?.userActivation?.hasBeenActive === true;
  } catch {
    return false;
  }
};

const resumeMaySucceed = (hasPlayed) => hasPlayed || hasBeenActivated();

export class Horn {
  #audioCtx = null;
  #bufferPromise = null;
  #sources = new Set();
  #synths = new Set();
  #pendingStarts = new Set();
  #suspendTimer = null;
  #suspendGeneration = 0;
  #idleSuspendMs = IDLE_SUSPEND_MS;
  #resumeBoundMs = RESUME_BOUND_MS;
  #activatedResumeBoundMs = ACTIVATED_RESUME_BOUND_MS;
  #hasPlayed = false;
  #audioSrc;
  #usingFallback = false;

  constructor({
    audioSrc = '/sounds/airhorn.mp3',
    audioContext = null,
    idleSuspendMs = IDLE_SUSPEND_MS,
    resumeBoundMs = RESUME_BOUND_MS,
    activatedResumeBoundMs = ACTIVATED_RESUME_BOUND_MS
  } = {}) {
    this.#audioSrc = audioSrc;
    this.#idleSuspendMs = idleSuspendMs;
    this.#resumeBoundMs = resumeBoundMs;
    this.#activatedResumeBoundMs = activatedResumeBoundMs;
    if (audioContext) {
      this.#audioCtx = audioContext;
    } else {
      const AudioCtxClass = typeof window !== 'undefined'
        ? (window.AudioContext || window.webkitAudioContext)
        : null;
      if (AudioCtxClass) {
        this.#audioCtx = new AudioCtxClass();
      }
    }

    if (this.#audioCtx) {
      this.#loadBuffer().catch(() => {});
    }
  }

  hasAudioContext() {
    return this.#audioCtx !== null;
  }

  isPlaying() {
    return this.#sources.size > 0 || this.#synths.size > 0;
  }

  get usingFallback() {
    return this.#usingFallback;
  }

  /*
   * Everything that ends a sound funnels through here: tell the app, then start
   * the idle countdown that releases the audio hardware (airhorn-1umb).
   */
  #notifyStopped() {
    this.onstopped();
    this.#armIdleSuspend();
  }

  // Arms and re-arms share this: bumping the generation makes a timer that has
  // already fired a no-op, so two ends in quick succession cannot double-suspend.
  #releaseIdleSuspend() {
    this.#suspendGeneration += 1;
    if (this.#suspendTimer !== null) {
      clearTimeout(this.#suspendTimer);
      this.#suspendTimer = null;
    }
  }

  #armIdleSuspend() {
    const ctx = this.#audioCtx;
    // No suspend method (or no context at all): nothing to release.
    if (!ctx || typeof ctx.suspend !== 'function') return;
    this.#releaseIdleSuspend();
    const generation = this.#suspendGeneration;
    this.#suspendTimer = setTimeout(() => {
      this.#suspendTimer = null;
      if (generation !== this.#suspendGeneration) return;
      // start() adds its operation to #pendingStarts synchronously, before its
      // first await, so this check cannot be overtaken by a press that has
      // already begun - the context is only released when the horn is genuinely
      // idle. Suspending mid-start would silence a blast the app reports.
      if (this.#pendingStarts.size > 0 || this.isPlaying()) return;
      if (ctx.state !== 'running') return;
      try {
        Promise.resolve(ctx.suspend()).catch(() => {});
      } catch {}
    }, this.#idleSuspendMs);
  }

  async #loadBuffer() {
    if (!this.#audioCtx) return null;
    if (!this.#bufferPromise) {
      this.#bufferPromise = fetch(this.#audioSrc)
        .then(response => {
          if (!response.ok) {
            throw new Error(`Failed to load audio sample: HTTP ${response.status}`);
          }
          return response.arrayBuffer();
        })
        .then(arrayBuffer => {
          return new Promise((resolve, reject) => {
            const res = this.#audioCtx.decodeAudioData(arrayBuffer, resolve, reject);
            if (res && typeof res.then === 'function') {
              res.then(resolve, reject);
            }
          });
        })
        .catch(err => {
          this.#bufferPromise = null;
          throw err;
        });
    }
    return this.#bufferPromise;
  }

  async start({ loop = false } = {}) {
    if (!this.#audioCtx) return false;

    const startOp = {
      loop,
      startTime: Date.now(),
      stopTime: null,
      cancelled: false,
      stopRequested: false,
      immediateStop: false
    };
    this.#pendingStarts.add(startOp);

    try {
      if (typeof this.#audioCtx.resume === 'function') {
        // A press is not the only caller: an autoplay link or a WebMCP tool call
        // can get here in a document that has never been touched, where the
        // context stays suspended and waiting cannot help (airhorn-dxug).
        const bound = resumeMaySucceed(this.#hasPlayed) ? this.#activatedResumeBoundMs : this.#resumeBoundMs;
        try {
          await Promise.race([
            this.#audioCtx.resume(),
            new Promise(r => setTimeout(r, bound))
          ]);
        } catch {}
      }

      // A document that has not had a user gesture yet keeps its context
      // suspended: the browser refuses to start audio, and scheduling a source
      // into it would (a) report a horn nobody can hear and (b) fire a delayed
      // blast whenever the context is later resumed by an unrelated click.
      // Report "did not start" instead - the next real press starts normally.
      if (this.#audioCtx.state === 'suspended') {
        return false;
      }

      if (startOp.cancelled || (startOp.stopRequested && startOp.immediateStop)) {
        return false;
      }

      try {
        const buffer = await this.#loadBuffer();
        if (startOp.cancelled || (startOp.stopRequested && startOp.immediateStop)) {
          return false;
        }
        // If release occurred more than 1000ms ago (stale start on slow network/lie-fi),
        // or one-shot start was initiated more than 1500ms ago, do not play a delayed blast.
        if (startOp.stopRequested && (Date.now() - (startOp.stopTime || startOp.startTime) > 1000)) {
          return false;
        }
        if (!startOp.loop && (Date.now() - startOp.startTime > 1500)) {
          return false;
        }
        if (!buffer) throw new Error('No audio buffer decoded');
        this.#usingFallback = false;
        const playLoop = startOp.stopRequested ? false : startOp.loop;
        return this.#playSample(buffer, { loop: playLoop });
      } catch (err) {
        if (startOp.cancelled || (startOp.stopRequested && startOp.immediateStop)) {
          return false;
        }
        // If release occurred more than 1000ms ago (stale start on slow network/lie-fi),
        // or one-shot start was initiated more than 1500ms ago, do not play a delayed blast.
        if (startOp.stopRequested && (Date.now() - (startOp.stopTime || startOp.startTime) > 1000)) {
          return false;
        }
        if (!startOp.loop && (Date.now() - startOp.startTime > 1500)) {
          return false;
        }
        this.#usingFallback = true;
        const playLoop = startOp.stopRequested ? false : startOp.loop;
        return this.#playSynth({ loop: playLoop });
      }
    } finally {
      this.#pendingStarts.delete(startOp);
    }
  }

  #playSample(buffer, { loop = false } = {}) {
    const source = this.#audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#audioCtx.destination);
    source.loop = loop;
    if (loop) {
      source.loopStart = 0.24;
      source.loopEnd = 0.34;
    }
    source.onended = () => {
      this.#sources.delete(source);
      if (!this.isPlaying()) {
        this.#notifyStopped();
      }
    };
    source.start(0);
    this.#sources.add(source);
    this.#hasPlayed = true;
    return true;
  }

  #playSynth({ loop = false } = {}) {
    const ctx = this.#audioCtx;
    const now = ctx.currentTime || 0;

    // Harmonic air horn tones: Bb3 (~233Hz), F4 (~349Hz), Bb4 (~466Hz)
    const frequencies = SYNTH_FREQUENCIES;
    const oscillators = [];

    const masterGain = ctx.createGain();
    masterGain.connect(ctx.destination);

    try {
      masterGain.gain.setValueAtTime(0.0001, now);
      masterGain.gain.exponentialRampToValueAtTime(SYNTH_LEVEL, now + SYNTH_ATTACK_S);
    } catch {
      masterGain.gain.value = SYNTH_LEVEL;
    }

    for (const freq of frequencies) {
      const osc = ctx.createOscillator();
      osc.type = SYNTH_OSC_TYPE;
      try {
        osc.frequency.setValueAtTime(freq, now);
        osc.frequency.exponentialRampToValueAtTime(freq * 1.02, now + 0.08);
      } catch {
        osc.frequency.value = freq;
      }

      const oscGain = ctx.createGain();
      oscGain.gain.value = 1 / frequencies.length;

      osc.connect(oscGain);
      oscGain.connect(masterGain);
      try { osc.start(now); } catch {}
      oscillators.push(osc);
    }

    const synthHandle = {
      oscillators,
      masterGain,
      loop,
      startTime: now,
      stopped: false,
      stopTimer: null
    };

    const cleanup = () => {
      if (synthHandle.stopped) return;
      synthHandle.stopped = true;
      if (synthHandle.stopTimer) clearTimeout(synthHandle.stopTimer);
      for (const osc of oscillators) {
        try { osc.stop(); } catch {}
        try { osc.disconnect(); } catch {}
      }
      try { masterGain.disconnect(); } catch {}
      this.#synths.delete(synthHandle);
      if (!this.isPlaying()) {
        this.#notifyStopped();
      }
    };

    synthHandle.cleanup = cleanup;

    if (!loop) {
      const blastDuration = SYNTH_BLAST_S;
      const releaseStart = now + blastDuration - 0.2;
      try {
        masterGain.gain.setValueAtTime(SYNTH_LEVEL, releaseStart);
        masterGain.gain.exponentialRampToValueAtTime(0.0001, now + blastDuration);
      } catch {}
      for (const osc of oscillators) {
        try { osc.stop(now + blastDuration); } catch {}
      }
      synthHandle.stopTimer = setTimeout(cleanup, blastDuration * 1000 + 50);
    }

    this.#synths.add(synthHandle);
    this.#hasPlayed = true;
    return true;
  }

  stop({ immediate = false } = {}) {
    const ended = [];

    // Notify any pending start operations waiting on buffer load / resume
    for (const pending of this.#pendingStarts) {
      pending.stopRequested = true;
      if (!pending.stopTime) {
        pending.stopTime = Date.now();
      }
      if (immediate) {
        pending.cancelled = true;
        pending.immediateStop = true;
      } else {
        pending.loop = false;
      }
    }

    for (const source of this.#sources) {
      source.loop = false;
      if (immediate) {
        ended.push(new Promise((resolve) => {
          let settled = false;
          let timer = null;
          const done = () => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            resolve();
          };
          timer = setTimeout(done, 500);
          if (typeof source.addEventListener === 'function') {
            source.addEventListener('ended', done, { once: true });
          } else {
            const prevOnEnded = source.onended;
            source.onended = (e) => {
              if (prevOnEnded) prevOnEnded(e);
              done();
            };
          }
          try {
            source.stop(0);
          } catch {
            done();
          }
        }));
      }
    }

    for (const synth of this.#synths) {
      const wasLooping = synth.loop;
      synth.loop = false;

      const ctx = this.#audioCtx;
      const now = ctx.currentTime || 0;

      if (!immediate) {
        // Natural release: ensure minimum blast duration (~1.2s total from synth.startTime)
        // just like the sample path where disabling loop lets the remaining sample ring out.
        const blastDuration = SYNTH_BLAST_S;
        const elapsed = Math.max(0, now - (synth.startTime || now));
        const remainingBlast = Math.max(0, blastDuration - elapsed);

        if (remainingBlast > 0.25) {
          // Tap or short hold: let the blast ring out to its natural completion
          if (!synth.stopTimer) {
            const releaseStart = (synth.startTime || now) + blastDuration - 0.2;
            try {
              synth.masterGain.gain.setValueAtTime(SYNTH_LEVEL, Math.max(now, releaseStart));
              synth.masterGain.gain.exponentialRampToValueAtTime(0.0001, (synth.startTime || now) + blastDuration);
            } catch {}
            for (const osc of synth.oscillators) {
              try { osc.stop((synth.startTime || now) + blastDuration); } catch {}
            }
            synth.stopTimer = setTimeout(synth.cleanup, remainingBlast * 1000 + 50);
          }
          continue;
        }
      }

      const releaseTime = immediate ? 0.03 : 0.25;

      ended.push(new Promise((resolve) => {
        try {
          synth.masterGain.gain.cancelScheduledValues(now);
          synth.masterGain.gain.setValueAtTime(synth.masterGain.gain.value, now);
          synth.masterGain.gain.exponentialRampToValueAtTime(0.0001, now + releaseTime);
        } catch {}

        for (const osc of synth.oscillators) {
          try {
            osc.stop(now + releaseTime);
          } catch {}
        }

        setTimeout(() => {
          synth.cleanup();
          resolve();
        }, releaseTime * 1000 + 30);
      }));
    }

    return Promise.all(ended);
  }

  onstopped() {}
}
