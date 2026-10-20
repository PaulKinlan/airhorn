# Two-minute phone check

Everything else in this repository was verified by a headless Chromium on a Linux VM:
no real screen, no real touch, no real speaker, no Safari. This page is the part only a
phone can answer. It takes about two minutes, standing up, and it is the only evidence
that would let us say "it works on a phone" instead of "it works on our phone-sized
emulation". [EVIDENCE-LIMITS.md](EVIDENCE-LIMITS.md) is the full list of what we cannot
test here.

## Before you start

One URL: the page must be the **V2 build**. `airhorner.com` today serves the old build
(it loads `/scripts/main.min.js` and has no critical-layer CSS), so if V2 is not on a
public HTTPS origin yet, stop here - the first item is the deployment in
[DEPLOY.md](DEPLOY.md), not a phone step. Serve it from the origin root; the service
worker's scope is `/`.

Two phones, because they fail differently:

- **Android, Chrome** - Chromium (what we test), but for real: real install, real touch,
  real speaker, real home-screen badge.
- **iPhone, Safari** - WebKit (what we have never run): no install event at all, strict
  audio-gesture rules, and a hardware mute switch that silences web audio.

## On both phones

1. **Open the URL and wait for the horn.** PASS: a full-screen red horn on blue, no
   banner. Report if you see "The Air Horner couldn't start, so the horn is silent" -
   our script did not run at all on your browser.
2. **Hold one finger on the horn for 3 seconds, then lift.** PASS: sound starts in well
   under half a second, keeps going while held, stops the instant you lift. Report if it
   is silent on press, stops while still held, or keeps going after you lift.
3. **Tap it 10 times quickly.** PASS: every tap blasts (a tap is a short blast, not a
   loop), nothing stutters or fires twice. Report a missed tap or a stuck horn.
4. **Hear it.** Phone at 50% volume: PASS is clearly loud but not painful; at 100% there
   is no crackle or dropout. Report quiet, distorted or inaudible - that is the speaker
   and DAC path no test here has ever touched.
5. **Airplane mode, then reload the app.** PASS: the horn comes back from the copy on
   the device, one banner says "No connection - the Air Horner still works from the copy
   on your device.", and holding the horn still sounds. Report a blank page, or a horn
   that is silent offline.
6. **Rotate, then leave and come back.** Hold the horn, rotate to landscape and back,
   press it again; then press home, wait 10 seconds, and return. PASS: same app, the horn
   still sounds, no error banner, no reload needed. Report if it needs a refresh to work
   again.

## Android, Chrome

7. **Install it.** Wait a few seconds: an **Install** button appears at the bottom. Tap
   it, accept the sheet. PASS: an icon appears on your home screen; open it and the app
   fills the screen with no address bar and the horn works. Report if the button never
   appears (our installability criteria do not hold in the wild) or the installed app
   opens in a normal browser tab.
8. **Long-press the installed icon** for the shortcuts menu, then choose **Instant
   Blast**. PASS: the horn sounds without you pressing the horn. Report if the shortcut
   is missing, or if it opens the app silently.
9. **Badge.** Blast twice, press home, look at the icon. PASS: a number badge on the
   icon. Report only if there is no badge at all - that it never clears is a known gap
   (`airhorn-7x7m`), not something to report.

## iPhone, Safari

10. **Install it.** There should be **no Install button** - iOS never offers the install
    event, so ours must stay hidden. Use Share -> **Add to Home Screen**, then open the
    icon. PASS: no stale button on the page, the icon opens full-screen, and the horn
    works from it. Report a visible Install button that does nothing, or an icon that
    opens in Safari.
11. **Press the horn once, first thing after opening.** PASS: sound on the first press
    (iOS only unlocks audio if it happens inside your touch). Report silence on the
    first press - that is the WebKit gesture rule we cannot see from here.
12. **Flip the side switch to silent, then press the horn.** PASS: silence - iOS mutes
    web audio with the ringer switch. Report if it is still audible: our WebKit notes
    would be wrong, and that matters for a horn app.

## What to send back

One message per failed step: the step number, phone model and OS version, browser and
version, and what you saw or heard instead - a screenshot if it is visual. If every step
passes, say that too: a clean two-phone run is the evidence this repository does not
otherwise have, and it is the gap most likely to decide a ship decision.
