/*
 * src/badge.js — the app badge (airhorn-70k, airhorn-xkq, airhorn-rqz1, airhorn-3v90).
 *
 * The app badge is OS-wide - every tab of the origin shares one badge - so the
 * count it displays must be shared too. It lives in localStorage and is DERIVED
 * by every tab that needs it: a fresh tab reads and re-displays the count instead
 * of clearing what another tab just set (airhorn-70k), and a blast anywhere
 * increments the shared count so 4 blasts in two tabs read 4, not 1
 * (airhorn-xkq).
 *
 * A badge means "activity since you last looked" (airhorn-7x7m): when a tab
 * becomes visible again the user has looked, so the shared count is
 * acknowledged - cleared from storage and from the OS badge.
 */

const BADGE_COUNT_KEY = 'airhorn:blast-count';
const BADGE_EPOCH_KEY = 'airhorn:badge-epoch';

export class BlastBadge {
  // Per-tab fallback, used only when shared storage is unavailable and the
  // shared count is therefore unknowable.
  #counter = 0;

  constructor() {
    if (!('setAppBadge' in navigator || 'clearAppBadge' in navigator)) return;

    const shared = this.#readSharedBadgeCount();
    // Storage unavailable: the shared count is unknowable, so do nothing to
    // the badge here - clearing it would wipe a badge another tab just set
    // (airhorn-danq). Blasts still badge via the per-tab fallback in blast().
    if (shared !== null) {
      if (shared > 0) navigator.setAppBadge?.(shared);
      else navigator.clearAppBadge?.();
    }

    // When this tab becomes visible again the user has looked, so the shared
    // count is acknowledged - cleared from storage and from the OS badge. The
    // boot-time derive above stays untouched: a boot is not a
    // visibilitychange, so a fresh tab still displays the total another tab
    // earned (airhorn-70k) without immediately wiping it. A focus listener
    // would NOT be safe here: a fresh page fires focus at boot with a derived
    // non-zero count, which would re-create the airhorn-70k wipe.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.acknowledge();
    });
  }

  // A blast bumps the shared count and paints the OS badge with the total.
  // Serialized behind an origin lock (airhorn-rqz1), so the value arrives
  // asynchronously. No badge API, no bump: the count is only ever a badge.
  blast() {
    if (!('setAppBadge' in navigator)) return;
    this.#bumpSharedBadgeCount().then((n) => {
      if (n !== null) navigator.setAppBadge(n);
    });
  }

  // The launch consumer calls this: a launch of the installed app is the user
  // coming to look, so the badge is acknowledged there (airhorn-2eh8). A plain
  // tab open never fires a launch, so the boot-time derive a second tab
  // performs (airhorn-70k) is untouched.
  acknowledge() {
    this.#acknowledgeSharedBadgeCount();
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
}
