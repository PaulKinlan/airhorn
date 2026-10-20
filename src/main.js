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

// One sentence, in one place: the announcement and the check that it is still
// the current message have to agree (airhorn-xsu).
const TAP_HINT = 'The horn needs a tap to make a sound.';

// The app badge is OS-wide - every tab of the origin shares one badge - so the
// count it displays must be shared too. It lives in localStorage and is
// DERIVED by every tab that needs it: a fresh tab reads and re-displays the
// count instead of clearing what another tab just set (airhorn-70k), and a
// blast anywhere increments the shared count so 4 blasts in two tabs read 4,
// not 1 (airhorn-xkq).
const BADGE_COUNT_KEY = 'airhorn:blast-count';
const BADGE_EPOCH_KEY = 'airhorn:badge-epoch';

class AirHorn {
  #horn;
  #image;
  #counter = 0;
  #announcedTapHint = false;
  #loop = false;

  constructor(root) {
    this.#image = root.querySelector('.horn');
    this.#horn = new Horn();

    // The badge belongs to every tab of the origin, not to this instance
    // (airhorn-70k): derive it from the shared count instead of clearing
    // whatever another tab may have just set.
    if ('setAppBadge' in navigator || 'clearAppBadge' in navigator) {
      const shared = this.#readSharedBadgeCount();
      // Storage unavailable: the shared count is unknowable, so do nothing
      // to the badge here - clearing it would wipe a badge another tab just
      // set (airhorn-danq). Blasts still badge via the per-tab fallback in
      // #bumpSharedBadgeCount.
      if (shared !== null) {
        if (shared > 0) navigator.setAppBadge?.(shared);
        else navigator.clearAppBadge?.();
      }
      // A badge means "activity since you last looked" (airhorn-7x7m): when
      // this tab becomes visible again the user has looked, so the shared
      // count is acknowledged - cleared from storage and from the OS badge.
      // The boot-time derive above stays untouched: a boot is not a
      // visibilitychange, so a fresh tab still displays the total another tab
      // earned (airhorn-70k) without immediately wiping it. A focus listener
      // would NOT be safe here: a fresh page fires focus at boot with a
      // derived non-zero count, which would re-create the airhorn-70k wipe.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.#acknowledgeSharedBadgeCount();
      });
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

    // A keyboard hold is sounding the horn (airhorn-ay73 state machine below).
    let pressing = false;
    let heldKeyCode = null;        // the key we believe is physically held
    let cancelledKey = null;       // a hold cancelled mid-hold: its repeat tail must not restart the horn

    // Retire the hold. suppress=true marks the key so its repeat tail (the
    // user may still physically hold it through a blur/tab-hide/Escape)
    // cannot restart the horn; a normal keyup release does NOT suppress -
    // the key is provably up, so the next keydown is a fresh press
    // (airhorn-ay73).
    const endHold = (suppress = false) => {
      if (suppress && heldKeyCode !== null) {
        cancelledKey = heldKeyCode;
      }
      pressing = false;
      heldKeyCode = null;
      this.stop();
      setTimeout(() => { handledByPointerOrKey = false; }, 100);
    };

    this.#image.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        // Escape retires a held blast: the horn must stop and stay stopped
        // through the key's repeat tail, not machine-gun back (airhorn-ay73).
        if (pressing) endHold(true);
        return;
      }
      if (!['Space', 'Enter'].includes(e.code)) return;
      e.preventDefault();
      if (cancelledKey === e.code) {
        // The hold on this key was cancelled (blur, tab-hide, Escape). Auto-
        // repeat keydowns carry repeat=true for exactly as long as the key is
        // physically held, so they are the tail: ignored until the key is
        // provably released (the keyup clears the cancellation). A first
        // keydown (repeat=false) is a genuine new press and always starts a
        // hold - however soon after the cancellation (airhorn-5a5x; the
        // previous 1s-stamp window swallowed it).
        if (e.repeat) return;
        cancelledKey = null;
      }
      if (!pressing) {
        handledByPointerOrKey = true;
        this.start({ loop: true });
        pressing = true;
        heldKeyCode = e.code;
      }
    });

    document.documentElement.addEventListener('keyup', (e) => {
      if (cancelledKey === e.code) cancelledKey = null;
      if (pressing && heldKeyCode === e.code) endHold(false);
    });
    // Losing the control (focus moved) or the window (alt-tab) mid-hold means
    // the keyup may never arrive here: retire the hold instead of sounding
    // forever (airhorn-ay73).
    const holdLost = () => { if (pressing) endHold(true); };
    this.#image.addEventListener('blur', holdLost);
    window.addEventListener('blur', holdLost);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stop();
        // The hold is retired too: repeats and the keyup can be lost while
        // hidden, and neither may leave the hold armed (airhorn-ay73).
        holdLost();
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

    // The pressed state above is optimistic so a press feels instant. If the
    // start did not happen - a browser that has not had a gesture yet keeps the
    // audio graph suspended - take it back rather than claim a horn nobody can
    // hear (airhorn-x4l).
    started.then((ok) => {
      if (ok === true || this.#horn.isPlaying()) {
        if (this.#announcedTapHint) {
          this.#announcedTapHint = false;
          // Only take back the hint if the region still holds it: a later message
          // (connection lost, an update notice) outranks a stale hint
          // (airhorn-xsu).
          const region = document.getElementById('app-status');
          if (!region || region.textContent === TAP_HINT) {
            window.__airhornAnnounce?.('');
          }
        }
        return;
      }
      this.#loop = false;
      this.#image.classList.remove('horning');
      this.#image.setAttribute('aria-pressed', 'false');
      // Silence must not read as broken (airhorn-hlg). Either the graph is
      // suspended until a gesture, or there is no Web Audio at all - say which,
      // through the page's one polite live region, and put the user on the
      // control that fixes it.
      if (this.#horn.hasAudioContext()) {
        window.__airhornAnnounce?.(TAP_HINT);
        this.#announcedTapHint = true;
        this.#image.focus?.({ preventScroll: false });
      } else {
        window.__airhornAnnounce?.('This browser cannot play the air horn.');
      }
    });

    this.#horn.onstopped = () => {
      this.#loop = false;
      this.#image.classList.remove('horning');
      this.#image.setAttribute('aria-pressed', 'false');
    };

    if ('setAppBadge' in navigator) {
      // The count is shared across tabs (airhorn-xkq): the badge is app-wide,
      // so 4 blasts in two tabs must read 4, not whichever tab wrote last.
      // The bump is serialized behind an origin lock (airhorn-rqz1), so the
      // value arrives asynchronously.
      this.#bumpSharedBadgeCount().then((n) => {
        if (n !== null) navigator.setAppBadge(n);
      });
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

  #readSharedBadgeCount() {
    try {
      const raw = window.localStorage.getItem(BADGE_COUNT_KEY);
      const n = raw === null ? 0 : parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch (err) {
      // Storage unavailable (private mode, disabled): report that, and the
      // badge falls back to per-tab behaviour below rather than breaking the
      // horn over a cosmetic counter.
      try { window.__badgeStorageError = String(err && err.message || err); } catch {}
      return null;
    }
  }

  // The "you looked at it again" acknowledgement (airhorn-7x7m): clear the
  // shared count and the OS badge so the badge never shows a total from a
  // session nobody is looking at. The clear runs UNDER the blast-count lock
  // and bumps a storage epoch, so a blast bump that queued before the look
  // cannot publish its stale total afterwards (airhorn-3v90): bumps compare
  // the epoch they captured at entry against the stored one inside the lock
  // and drop themselves when an acknowledge happened in between. Without a
  // lock manager this is the old best-effort synchronous clear.
  async #acknowledgeSharedBadgeCount() {
    if (!navigator.locks?.request) {
      const current = this.#readSharedBadgeCount();
      if (current === null) {
        // Storage unavailable: the shared count is unknowable, but the badge is
        // still one per origin and this tab may have set it through the per-tab
        // fallback. A look-transition is the same acknowledge any tab performs,
        // so clear - a tab that cannot read storage must still be able to
        // retire the badge it set itself, or no event in the app ever could
        // (airhorn-0w1q).
        this.#counter = 0;
        navigator.clearAppBadge?.();
        return;
      }
      if (current === 0) return;
      try { window.localStorage.removeItem(BADGE_COUNT_KEY); } catch {}
      navigator.clearAppBadge?.();
      return;
    }
    const acknowledge = () => {
      const current = this.#readSharedBadgeCount();
      // The epoch is bumped even when nothing is owed: a bump queued behind
      // this acknowledge still represents a blast that happened BEFORE the
      // look, and must not publish after it (airhorn-3v90).
      let epoch = 0;
      try { epoch = Number(window.localStorage.getItem(BADGE_EPOCH_KEY)) || 0; } catch {}
      try { window.localStorage.setItem(BADGE_EPOCH_KEY, String(epoch + 1)); } catch {}
      if (current === null) {
        // Storage unavailable: the shared count is unknowable, but the badge is
        // still one per origin and this tab may have set it through the per-tab
        // fallback. A look-transition is the same acknowledge any tab performs,
        // so clear - a tab that cannot read storage must still be able to
        // retire the badge it set itself, or no event in the app ever could
        // (airhorn-0w1q).
        this.#counter = 0;
        navigator.clearAppBadge?.();
        return;
      }
      if (current === 0) return;
      try { window.localStorage.removeItem(BADGE_COUNT_KEY); } catch {}
      navigator.clearAppBadge?.();
    };
    try {
      await navigator.locks.request(BADGE_COUNT_KEY, acknowledge);
    } catch {
      acknowledge();
    }
  }

  // Called from the launch consumer (module scope): a launch of the installed
  // app is the user coming to look, so the badge is acknowledged there
  // (airhorn-2eh8). A plain tab open never fires a launch, so the boot-time
  // derive a second tab performs (airhorn-70k) is untouched.
  acknowledgeSharedBadge() {
    this.#acknowledgeSharedBadgeCount();
  }

  async #bumpSharedBadgeCount() {
    const current = this.#readSharedBadgeCount();
    if (current === null) {
      // No shared storage: keep the old per-tab counter so the badge still
      // means something in this tab.
      this.#counter = (this.#counter % 99) + 1;
      return this.#counter;
    }
    // The blast's intent is stamped with the badge epoch BEFORE queuing on
    // the lock: an acknowledge that arrives while this bump waits bumps the
    // stored epoch, and this bump then drops itself inside the lock instead
    // of publishing a total the user's look already cleared (airhorn-3v90).
    let myEpoch = 0;
    try { myEpoch = Number(window.localStorage.getItem(BADGE_EPOCH_KEY)) || 0; } catch {}
    const bump = () => {
      let stored = myEpoch;
      try { stored = Number(window.localStorage.getItem(BADGE_EPOCH_KEY)) || 0; } catch {}
      if (stored !== myEpoch) return null;
      // The re-read happens INSIDE the origin lock: interleaved tabs
      // serialize here instead of each writing pre-blast count + 1, which
      // clobbered the first writer's blast (airhorn-rqz1).
      const now = this.#readSharedBadgeCount();
      const next = ((now === null ? 0 : now) % 99) + 1;
      try {
        window.localStorage.setItem(BADGE_COUNT_KEY, String(next));
      } catch {
        // Best effort: the blast still happens, the badge just may not move.
      }
      return next;
    };
    // Web Locks serialize the read-modify-write across every tab of the
    // origin, so two tabs blasting "at the same time" cannot lose an
    // increment. Without a lock manager the unlocked bump is the old
    // best-effort behaviour for a cosmetic badge.
    if (navigator.locks?.request) {
      try {
        return await navigator.locks.request(BADGE_COUNT_KEY, bump);
      } catch {
        return bump();
      }
    }
    return bump();
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

  const fireInstant = () => airhorn.start({ loop: false });
  let urlLaunchAt = null;
  let coldLaunchSettled = false;

  if (location.hash === '#instant') {
    fireInstant();
    urlLaunchAt = performance.now();
  }

  window.addEventListener('hashchange', () => {
    if (location.hash === '#instant') {
      fireInstant();
    }
  });

  // Launching the installed app reuses this window when the manifest asks for
  // focus-existing, and the URL does not change - so neither load nor hashchange
  // fires and a second press of the shortcut used to do nothing at all
  // (airhorn-hlg). The platform reports every launch through window.launchQueue,
  // so consume it: a deliberate second press re-fires the deep link's action
  // instead of being swallowed as a duplicate. In a browser without a launch
  // queue a repeat launch emits no event in the page at all, so there is nothing
  // honest to react to; the deep link still fires on load and on hashchange.
  if (typeof window.launchQueue?.setConsumer === 'function') {
    window.launchQueue.setConsumer((params = {}) => {
      // The launch is the user coming to look, whatever the launch URL says,
      // so acknowledge the badge before anything can early-return
      // (airhorn-2eh8).
      airhorn.acknowledgeSharedBadge();
      let hash = location.hash;
      if (params.targetURL) {
        try {
          hash = new URL(params.targetURL, location.href).hash;
        } catch {
          return;
        }
      }
      if (hash !== '#instant') return;
      // A cold launch is reported through the queue as well, and the load handler
      // has already served it: firing again starts a second, overlapping source,
      // bumps the badge twice and tracks the event twice (airhorn-lw9). The
      // platform delivers a cold launch's params immediately after setConsumer,
      // so the first delivery within a moment of the load-time fire IS that
      // launch; anything later is a genuine repeat press and does re-fire.
      // (isPlaying() cannot be the test: the URL fire is still fetching and
      // decoding the sample when the params arrive.)
      const firstDelivery = !coldLaunchSettled;
      coldLaunchSettled = true;
      if (firstDelivery && urlLaunchAt !== null && performance.now() - urlLaunchAt < 500) {
        return;
      }
      fireInstant();
    });
  }

  // Tab-hide (visibilitychange -> hidden) stopping the horn - and retiring a
  // keyboard hold whose keyup may never arrive - is wired in the AirHorn
  // constructor, which owns the hold state.
});
