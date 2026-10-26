/*
 * src/analytics.js — the one analytics call the app makes.
 *
 * gtag is only present when a page loads the analytics snippet, so the call is
 * guarded rather than assumed. Kept apart from the concerns that emit events
 * (the horn and the installer) so that a change to one of those does not drag
 * every other concern's suites into its gate row.
 */

export function trackEvent(eventName, params) {
  if (typeof gtag === 'function') {
    gtag('event', eventName, params);
  }
}
