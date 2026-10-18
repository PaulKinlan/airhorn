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
  #audioSrc = '/sounds/airhorn.mp3';

  constructor() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      this.#audioCtx = new AudioContext();
      this.#loadBuffer();
    }
  }

  hasAudioContext() {
    return this.#audioCtx !== null;
  }

  isPlaying() {
    return this.#sources.size > 0;
  }

  #loadBuffer() {
    if (!this.#bufferPromise && this.#audioCtx) {
      this.#bufferPromise = fetch(this.#audioSrc)
        .then(response => response.arrayBuffer())
        .then(arrayBuffer => this.#audioCtx.decodeAudioData(arrayBuffer))
        .catch(err => {
          this.#bufferPromise = null;
          throw err;
        });
    }
    return this.#bufferPromise;
  }

  async start({ loop = false } = {}) {
    if (!this.#audioCtx) return false;

    await this.#audioCtx.resume();
    const buffer = await this.#loadBuffer();

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
      if (this.#sources.size === 0) {
        this.onstopped();
      }
    };
    source.start(0);
    this.#sources.add(source);

    return true;
  }

  /**
   * Silence the horn. By default the sample rings out naturally (matching the
   * on-screen button); `immediate` cuts it off, for callers such as the WebMCP
   * `stop_horn` tool that promise to stop the sound now.
   * Resolves once every source has ended.
   */
  stop({ immediate = false } = {}) {
    const ended = [];
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
          // Fallback so a source that already ended can never hang the caller.
          timer = setTimeout(done, 500);
          source.addEventListener('ended', done, { once: true });
          try {
            source.stop(0);
          } catch {
            // Already stopped or ended: the source is on its way out anyway.
            done();
          }
        }));
      }
    }
    return Promise.all(ended);
  }

  onstopped() {}
}
