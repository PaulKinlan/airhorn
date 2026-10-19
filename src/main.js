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

// The boot marker is NOT here: the watchdog's 'booted' means the horn is
// actually usable (airhorn-21k), so src/main.js signals it from the load
// handler once the AirHorn is constructed and bound - a bundle that runs but
// fails during setup stays unbooted and the watchdog speaks.

// Status awareness (airhorn-8nz): say when the connection drops or returns.
// The horn itself keeps working offline (cached shell plus the synth
// fallback), so the copy promises exactly that and nothing more. Announced
// through the one polite live region defined by the inline boot script in
// index.html. Only transitions speak: the normal, connected case stays
// silent, and a page opened offline says so once at boot.
function announceOffline() {
  window.__airhornAnnounce?.('No connection - the Air Horner still works from the copy on your device.');
}

function announceOnline() {
  window.__airhornAnnounce?.('Back online.');
}

if (!navigator.onLine) {
  announceOffline();
}
window.addEventListener('offline', announceOffline);
window.addEventListener('online', announceOnline);

function trackEvent(eventName, params) {
  if (typeof gtag === 'function') {
    gtag('event', eventName, params);
  }
}

class Installer {
  #promptEvent = null;
  #button;
  #root;

  constructor(root) {
    this.#root = root;
    // Structurally inert until an install is actually offered (airhorn-fld):
    // the attribute lives on the button, not in CSS, so even the blocked-CSS
    // fallback shows an honest control - nothing exposed that clicking does
    // nothing. beforeinstallprompt enables it.
    this.#button = root.querySelector('button');
    if (this.#button) this.#button.disabled = true;

    window.addEventListener('beforeinstallprompt', (e) => {
      this.#promptEvent = e;
      e.preventDefault();
      if (this.#button) this.#button.disabled = false;
      root.classList.add('available');
      trackEvent('install_available');
    });

    window.addEventListener('appinstalled', () => {
      this.#promptEvent = null;
      // An installed app is not offered another prompt; stay honest.
      if (this.#button) this.#button.disabled = true;
      this.#restoreFocus();
      root.classList.remove('available');
      trackEvent('app_installed');
    });

    root.addEventListener('click', () => this.#install());
  }

  #restoreFocus() {
    if (this.#root.contains(document.activeElement)) {
      const hornButton = document.querySelector('.horn');
      if (hornButton && typeof hornButton.focus === 'function') {
        hornButton.focus();
      }
    }
  }

  async #install() {
    if (!this.#promptEvent) return;
    this.#promptEvent.prompt();
    const result = await this.#promptEvent.userChoice;
    trackEvent('install_prompt_result', { outcome: result.outcome });
    this.#promptEvent = null;
    if (this.#button) this.#button.disabled = true;
    this.#restoreFocus();
    this.#root.classList.remove('available');

    // The outcome goes through the one polite voice (airhorn-fld). The old
    // code wrote it to #install-status, an element that does not exist, so
    // accepting or dismissing the prompt was silent.
    window.__airhornAnnounce?.(result?.outcome === 'accepted' ? 'App installed' : 'Installation cancelled');
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

  get usingFallback() {
    return this.#horn.usingFallback;
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

  // The app is usable: retire the boot watchdog (airhorn-21k). This runs
  // synchronously inside load, always ahead of the watchdog's load+grace arm.
  window.__airhornBooted?.();

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
