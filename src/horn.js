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

export class Horn {
  #audioCtx = null;
  #bufferPromise = null;
  #sources = new Set();
  #synths = new Set();
  #pendingStarts = new Set();
  #audioSrc;
  #usingFallback = false;

  constructor({ audioSrc = '/sounds/airhorn.mp3', audioContext = null } = {}) {
    this.#audioSrc = audioSrc;
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
        try {
          await Promise.race([
            this.#audioCtx.resume(),
            new Promise(r => setTimeout(r, 100))
          ]);
        } catch {}
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
        // do not play a delayed blast long after the user let go.
        if (startOp.stopRequested && startOp.stopTime && (Date.now() - startOp.stopTime > 1000)) {
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
        // do not play a delayed blast long after the user let go.
        if (startOp.stopRequested && startOp.stopTime && (Date.now() - startOp.stopTime > 1000)) {
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
        this.onstopped();
      }
    };
    source.start(0);
    this.#sources.add(source);
    return true;
  }

  #playSynth({ loop = false } = {}) {
    const ctx = this.#audioCtx;
    const now = ctx.currentTime || 0;

    // Harmonic air horn tones: Bb3 (~233Hz), F4 (~349Hz), Bb4 (~466Hz)
    const frequencies = [233.08, 349.23, 466.16];
    const oscillators = [];

    const masterGain = ctx.createGain();
    masterGain.connect(ctx.destination);

    try {
      masterGain.gain.setValueAtTime(0.0001, now);
      masterGain.gain.exponentialRampToValueAtTime(0.5, now + 0.04);
    } catch {
      masterGain.gain.value = 0.5;
    }

    for (const freq of frequencies) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
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
        this.onstopped();
      }
    };

    synthHandle.cleanup = cleanup;

    if (!loop) {
      const blastDuration = 1.2;
      const releaseStart = now + blastDuration - 0.2;
      try {
        masterGain.gain.setValueAtTime(0.5, releaseStart);
        masterGain.gain.exponentialRampToValueAtTime(0.0001, now + blastDuration);
      } catch {}
      for (const osc of oscillators) {
        try { osc.stop(now + blastDuration); } catch {}
      }
      synthHandle.stopTimer = setTimeout(cleanup, blastDuration * 1000 + 50);
    }

    this.#synths.add(synthHandle);
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
        const blastDuration = 1.2;
        const elapsed = Math.max(0, now - (synth.startTime || now));
        const remainingBlast = Math.max(0, blastDuration - elapsed);

        if (remainingBlast > 0.25) {
          // Tap or short hold: let the blast ring out to its natural completion
          if (!synth.stopTimer) {
            const releaseStart = (synth.startTime || now) + blastDuration - 0.2;
            try {
              synth.masterGain.gain.setValueAtTime(0.5, Math.max(now, releaseStart));
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
