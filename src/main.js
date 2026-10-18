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

import { registerHornTools } from './webmcp.js';
import { Horn } from './horn.js';

function trackEvent(eventName, params) {
  if (typeof gtag === 'function') {
    gtag('event', eventName, params);
  }
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
      trackEvent('install_available');
    });

    window.addEventListener('appinstalled', () => {
      this.#promptEvent = null;
      root.classList.remove('available');
      trackEvent('app_installed');
    });

    root.addEventListener('click', () => this.#install());
  }

  async #install() {
    if (!this.#promptEvent) return;
    this.#promptEvent.prompt();
    const result = await this.#promptEvent.userChoice;
    trackEvent('install_prompt_result', { outcome: result.outcome });
    this.#promptEvent = null;
    this.#root.classList.remove('available');
  }
}

class AirHorn {
  #horn;
  #image;
  #counter = 0;
  #loop = false;

  constructor(root) {
    this.#image = root.querySelector('.horn');
    this.#horn = new Horn();

    if ('clearAppBadge' in navigator) {
      navigator.clearAppBadge();
    }

    let handledByPointerOrKey = false;

    this.#image.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handledByPointerOrKey = true;
      this.start({ loop: true });
    });

    document.documentElement.addEventListener('pointerup', () => {
      this.stop();
      setTimeout(() => { handledByPointerOrKey = false; }, 100);
    });

    document.documentElement.addEventListener('pointercancel', () => {
      this.stop();
      setTimeout(() => { handledByPointerOrKey = false; }, 100);
    });

    let pressing = false;

    this.#image.addEventListener('keydown', (e) => {
      if (!pressing && ['Space', 'Enter'].includes(e.code)) {
        e.preventDefault();
        handledByPointerOrKey = true;
        this.start({ loop: true });
        pressing = true;
      }
    });

    document.documentElement.addEventListener('keyup', () => {
      if (pressing) {
        this.stop();
        pressing = false;
        setTimeout(() => { handledByPointerOrKey = false; }, 100);
      }
    });

    this.#image.addEventListener('click', () => {
      if (!handledByPointerOrKey) {
        this.start({ loop: false });
      }
    });
  }

  start({ loop = false } = {}) {
    this.#loop = loop;
    this.#image.classList.add('horning');
    this.#image.setAttribute('aria-pressed', 'true');

    // Resolves once the sample is actually playing (or failed to start).
    const started = this.#horn.start({ loop }).catch(() => false);

    this.#horn.onstopped = () => {
      this.#loop = false;
      this.#image.classList.remove('horning');
      this.#image.setAttribute('aria-pressed', 'false');
    };

    if ('setAppBadge' in navigator) {
      this.#counter = (this.#counter % 99) + 1;
      navigator.setAppBadge(this.#counter);
    }

    trackEvent('horn_play');

    return started;
  }

  isPlaying() {
    return this.#horn.isPlaying();
  }

  isLooping() {
    return this.#loop && this.#horn.isPlaying();
  }

  hasAudioContext() {
    return this.#horn.hasAudioContext();
  }

  stop({ immediate = false } = {}) {
    this.#loop = false;
    this.#image.classList.remove('horning');
    this.#image.setAttribute('aria-pressed', 'false');
    return this.#horn.stop({ immediate });
  }
}

window.addEventListener('load', () => {
  const airhorn = new AirHorn(document.getElementById('airhorn'));
  window.__airhorn = airhorn;
  new Installer(document.getElementById('installer'));

  registerHornTools(airhorn).catch(() => {
    // WebMCP is an enhancement: never let a registration failure break the horn.
  });

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
