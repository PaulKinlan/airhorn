/*
 * src/airhorn.js — the horn's state: start/stop, the pressed state, and the one
 * honest voice for silence (airhorn-x4l, airhorn-hlg, airhorn-21k, airhorn-xsu).
 *
 * This is the app's core, and deliberately the ONLY place that decides what the
 * button claims: the pressed state is optimistic so a press feels instant, and
 * is taken back when the sound did not actually start. It owns the Horn (the
 * audio graph, src/horn.js) and the app badge (src/badge.js); it does not own
 * input (src/input.js binds that around start/stop) or what a launch means
 * (src/launch.js).
 *
 * window.__airhorn - the surface the suites and src/webmcp.js drive - is this
 * object, and its members are unchanged by the split.
 */

import { Horn } from './horn.js';
import { BlastBadge } from './badge.js';
import { trackEvent } from './analytics.js';

// One sentence, in one place: the announcement and the check that it is still
// the current message have to agree (airhorn-xsu).
const TAP_HINT = 'The horn needs a tap to make a sound.';

export class AirHorn {
  #horn;
  #image;
  #badge;
  #announcedTapHint = false;
  #loop = false;

  constructor(root) {
    this.#image = root.querySelector('.horn');
    this.#horn = new Horn();

    // The badge belongs to every tab of the origin, not to this instance
    // (airhorn-70k): derive it from the shared count instead of clearing
    // whatever another tab may have just set. Constructed here, before input is
    // bound, so the badge's visibility listener keeps its original order.
    this.#badge = new BlastBadge();
  }

  // The element input is bound to. src/main.js wires src/input.js around it
  // rather than this class listening for presses itself.
  get element() {
    return this.#image;
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

    this.#badge.blast();

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

  // Called from the launch consumer (src/launch.js): a launch of the installed
  // app is the user coming to look, so the badge is acknowledged there
  // (airhorn-2eh8).
  acknowledgeSharedBadge() {
    this.#badge.acknowledge();
  }

  stop({ immediate = false } = {}) {
    this.#loop = false;
    this.#image.classList.remove('horning');
    this.#image.setAttribute('aria-pressed', 'false');
    return this.#horn.stop({ immediate });
  }
}
