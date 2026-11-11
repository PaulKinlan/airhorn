// Async stylesheet loader (airhorn-xnd1). The main sheet below is fetched with
// media='print' so it never blocks first paint; this swaps it to 'all' once it
// lands, or marks the failed state that reveals the labelled-unstyled fallback
// (airhorn-zb0).
//
// This used to be onload/onerror attributes on the link. Under the shipped CSP
// (script-src 'self', public/_headers) inline event-handler attributes are
// blocked silently - the sheet would load, media would stay 'print', and the
// page would never get its real stylesheet. So it is an external file, loaded
// by the <script defer> right after the link: the fetch starts during parse but
// the script runs after it, so nothing here is a round trip in front of first
// paint (airhorn-xnd1 requirement: no paint-timing change).
//
// Deferring means the load/error events can arrive BEFORE this script runs, so
// the DOM's own state decides those cases - never a timer, and never the
// assumption that an event was seen:
//   - a sheet the browser fetched and parsed ANSWERS WITH ITS RULES;
//   - a sheet whose fetch failed (blocked, offline, 404) is an EMPTY SHELL in
//     Chrome: link.sheet is non-null and reading cssRules throws SecurityError.
// That second fact is why "link.sheet is set" is NOT the test for success - a
// blocked sheet sets it too, and treating it as success leaves media='print'
// swapped to 'all' over nothing while .stylesheet-failed is never added and the
// label never appears. Measured (airhorn-xnd1): blocked -> {sheet: true, rules:
// SecurityError}, loaded -> {sheet: true, rules: 11}.
(function () {
  var link = document.getElementById('main-css');
  if (!link) return;

  function applied() {
    if (link.media !== 'all') link.media = 'all';
  }

  function failed() {
    document.documentElement.classList.add('stylesheet-failed');
  }

  function loaded() {
    if (!link.sheet) return false;
    try {
      return link.sheet.cssRules.length > 0;
    } catch (e) {
      // The empty shell of a sheet that never arrived.
      return false;
    }
  }

  link.addEventListener('load', applied);
  link.addEventListener('error', failed);

  // A sheet that already loaded needs no event. Not a failure verdict: a sheet
  // still in flight looks identical here, and it must not be declared dead.
  if (loaded()) applied();

  // Same reasoning one step later, before the deferred bundle's own work is
  // observable.
  document.addEventListener('DOMContentLoaded', function () {
    if (loaded()) applied();
  });

  // The full verdict belongs at window load: every subresource has finished by
  // then, so a sheet with no rules is a sheet that failed. This is the latest
  // the failure can be declared without a parser-blocking script - and the
  // earliest point at which "no rules" is a fact rather than a sheet in flight.
  window.addEventListener('load', function () {
    if (loaded()) applied();
    else failed();
  });
})();
