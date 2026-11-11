// Boot watchdog. The static HTML paints a complete horn, so when the
// module bundle never executes - or executes and then fails during
// setup - the page looks alive but is inert and silent. This notices,
// and says so. src/main.js calls window.__airhornBooted() only once the
// app is actually usable, so 'booted' means the horn works.
(function () {
  var booted = false;
  var banner = document.getElementById('boot-failure');
  var retry = document.getElementById('boot-retry');

  function show() {
    if (booted || !banner || !banner.hidden) return;
    banner.hidden = false;
    if (retry) retry.focus();
  }

  // Booting cancels every pending watchdog timer, so a healthy page is
  // left with none: a permanently pending timer would keep the page
  // from ever reading as quiescent (a11y and sw-offline suites wait
  // for observed quiescence).
  var backstop = 0;
  window.__airhornBooted = function () {
    booted = true;
    clearTimeout(backstop);
    // A late bundle retires the notice: the page was wrong to claim the
    // horn was dead, so take it back (airhorn-duj). The banner took focus
    // when it appeared, so it has to hand focus on when it goes - a bare
    // retry.blur() dropped focus to <body> and left a keyboard user who
    // was waiting on "Try again" with no focus position at all, their
    // next Tab restarting from the top of the document (airhorn-bjk1).
    // Same rule the installer's focus restoration already follows: hand
    // it to the control that now works, and only if the banner still had
    // it (never steal focus the user has already moved).
    if (banner && !banner.hidden) {
      banner.hidden = true;
      if (retry) {
        var horn = document.querySelector('.horn');
        if (document.activeElement === retry && horn) horn.focus();
        else retry.blur();
      }
    }
  };

  // Fast path: the module element fires `error` when its fetch fails
  // (blocked) or its source fails to compile (corrupt cache body).
  var moduleScript = document.querySelector('script[type=module]');
  if (moduleScript) moduleScript.addEventListener('error', show);

  // Slow path, for a hung fetch that fires neither `error` nor `load`:
  // arm on load - the module always boots before load when it runs -
  // with a short grace, plus a hard backstop measured from parse. The
  // backstop is effectively ~14s: the timer calls arm() at 12s and arm
  // schedules the reveal 2s later.
  var armed = false;
  function arm() {
    if (armed || booted) return;
    armed = true;
    setTimeout(show, 2000);
  }
  window.addEventListener('load', arm);
  backstop = setTimeout(arm, 12000);

  if (retry) retry.addEventListener('click', function () { window.location.reload(); });

  // The one polite voice (see #app-status above). Intentionally no
  // timers: a message stays until the next one replaces it, so a
  // healthy page schedules nothing and reads as quiescent.
  var statusRegion = document.getElementById('app-status');
  window.__airhornAnnounce = function (message) {
    if (statusRegion) statusRegion.textContent = message;
  };
})();
