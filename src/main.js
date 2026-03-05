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

class Horn {
  #audioCtx = null;
  #buffer = null;
  #sources = new Set();
  #audioSrc = '/sounds/airhorn.mp3';

  constructor() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      this.#audioCtx = new AudioContext();
      this.#loadBuffer();
    }
  }

  async #loadBuffer() {
    if (this.#buffer || !this.#audioCtx) return;
    const response = await fetch(this.#audioSrc);
    const arrayBuffer = await response.arrayBuffer();
    this.#buffer = await this.#audioCtx.decodeAudioData(arrayBuffer);
  }

  async start({ loop = false } = {}) {
    if (!this.#audioCtx) return;

    await this.#audioCtx.resume();
    await this.#loadBuffer();

    const source = this.#audioCtx.createBufferSource();
    source.buffer = this.#buffer;
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
  }

  stop() {
    for (const source of this.#sources) {
      try {
        source.stop();
      } catch {
        // Already stopped
      }
      source.disconnect();
    }
    this.#sources.clear();
    this.onstopped();
  }

  onstopped() {}
}

class Installer {
  #promptEvent = null;
  #root;

  constructor(root) {
    this.#root = root;

    window.addEventListener('beforeinstallprompt', (e) => {
      this.#promptEvent = e;
      e.preventDefault();
      root.classList.add('available');
      gtag('event', 'install_available');
    });

    window.addEventListener('appinstalled', () => {
      this.#promptEvent = null;
      root.classList.remove('available');
      gtag('event', 'app_installed');
    });

    root.addEventListener('click', () => this.#install());
  }

  async #install() {
    if (!this.#promptEvent) return;
    this.#promptEvent.prompt();
    const result = await this.#promptEvent.userChoice;
    gtag('event', 'install_prompt_result', { outcome: result.outcome });
    this.#promptEvent = null;
    this.#root.classList.remove('available');
  }
}

class AirHorn {
  #horn;
  #image;
  #counter = 0;

  constructor(root) {
    this.#image = root.querySelector('.horn');
    this.#horn = new Horn();

    if ('clearAppBadge' in navigator) {
      navigator.clearAppBadge();
    }

    this.#image.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.start({ loop: true });
    });

    document.documentElement.addEventListener('pointerup', () => this.stop());
    document.documentElement.addEventListener('pointercancel', () => this.stop());

    let pressing = false;

    this.#image.addEventListener('keydown', (e) => {
      if (!pressing && ['Space', 'Enter'].includes(e.code)) {
        e.preventDefault();
        this.start({ loop: true });
        pressing = true;
      }
    });

    document.documentElement.addEventListener('keyup', () => {
      if (pressing) {
        this.stop();
        pressing = false;
      }
    });
  }

  start({ loop = false } = {}) {
    this.#image.classList.add('horning');
    this.#image.setAttribute('aria-pressed', 'true');
    this.#horn.start({ loop });

    this.#horn.onstopped = () => {
      this.#image.classList.remove('horning');
      this.#image.setAttribute('aria-pressed', 'false');
    };

    if ('setAppBadge' in navigator) {
      this.#counter = (this.#counter % 99) + 1;
      navigator.setAppBadge(this.#counter);
    }

    gtag('event', 'horn_play');
  }

  stop() {
    this.#image.classList.remove('horning');
    this.#image.setAttribute('aria-pressed', 'false');
    this.#horn.stop();
  }
}

window.addEventListener('load', () => {
  const airhorn = new AirHorn(document.getElementById('airhorn'));
  new Installer(document.getElementById('installer'));

  if (location.hash === '#instant') {
    airhorn.start({ loop: false });
  }

  window.addEventListener('hashchange', () => {
    if (location.hash === '#instant') {
      airhorn.start({ loop: false });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      airhorn.stop();
    }
  });
});
