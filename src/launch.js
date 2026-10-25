/*
 * src/launch.js — deep links and installed-app launches (#instant, airhorn-hlg, airhorn-lw9, airhorn-2eh8).
 *
 * public/manifest.json advertises one shortcut, "Instant Blast" -> /#instant, and
 * the platform delivers a launch two ways: the URL (load + hashchange) in an
 * ordinary tab, and window.launchQueue when the installed app is already running
 * and the platform focuses the existing window instead of navigating it.
 *
 * Deduplicating those two is the subtle part: a COLD launch is reported through
 * the queue as well, after the load handler has already served the URL, so the
 * first delivery is that launch - serving it again would start a second
 * overlapping source, bump the badge twice and track the event twice
 * (airhorn-lw9). A later delivery is a genuine repeat press and does re-fire.
 */

export function bindLaunch({ start, acknowledgeBadge }) {
  let urlLaunchAt = null;
  let coldLaunchSettled = false;

  const fireInstant = () => start();

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
      acknowledgeBadge();
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
}
