/*
 * src/input.js — pointer and keyboard semantics for the horn (airhorn-slmt, airhorn-ay73, airhorn-5a5x).
 *
 * One hold machine for both input paths: a press (primary button, Space, Enter)
 * starts a looping blast, and the RELEASE retires it - whatever form the release
 * takes (pointerup, keyup, a context menu, focus loss, the window losing
 * focus, the tab hiding). The two P0 semantics live here and nowhere else: a
 * secondary-button gesture never starts a hold, and a cancelled keyboard hold
 * must not be restarted by the key's own auto-repeat tail.
 *
 * Bound by src/main.js after the horn is constructed; it drives the horn only
 * through the start/stop callbacks it is given, so it holds no horn state.
 */

export function bindHornInput({ target, start, stop }) {
  let handledByPointerOrKey = false;

  target.addEventListener('pointerdown', (e) => {
    // Only the primary button holds the horn. A right-click's release is a
    // contextmenu, not a pointerup, so without this guard the loop it
    // started was never released and the horn sounded forever
    // (airhorn-slmt).
    if (e.button !== 0) return;
    e.preventDefault();
    handledByPointerOrKey = true;
    start({ loop: true });
  });

  // The release listeners live on window, not documentElement: a release
  // delivered at window level must still retire the hold (airhorn-slmt).
  const releasePointerHold = () => {
    stop();
    setTimeout(() => { handledByPointerOrKey = false; }, 100);
  };
  window.addEventListener('pointerup', releasePointerHold);
  window.addEventListener('pointercancel', releasePointerHold);
  // A context menu opening mid-hold (long-press menu, or the release half
  // of a secondary-button gesture) is not followed by a pointerup, so
  // without this the horn kept sounding behind the menu (airhorn-slmt).
  window.addEventListener('contextmenu', () => stop());

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
    stop();
    setTimeout(() => { handledByPointerOrKey = false; }, 100);
  };

  target.addEventListener('keydown', (e) => {
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
      start({ loop: true });
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
  target.addEventListener('blur', holdLost);
  // Losing the WINDOW (alt-tab) mid-hold means the pointerup may never
  // arrive either: stop a POINTER hold unconditionally, not just retire a
  // keyboard one - a looping horn whose release event went to the newly
  // focused window sounded forever (airhorn-slmt). stop() on an idle horn
  // is a no-op, and endHold's own stop keeps the keyboard path unchanged.
  window.addEventListener('blur', () => { stop(); holdLost(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stop();
      // The hold is retired too: repeats and the keyup can be lost while
      // hidden, and neither may leave the hold armed (airhorn-ay73).
      holdLost();
    }
  });

  target.addEventListener('click', () => {
    if (!handledByPointerOrKey) {
      start({ loop: false });
    }
  });
}
