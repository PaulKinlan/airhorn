if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(reg => {
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (newWorker) {
        // At updatefound the worker is already 'installing', so that
        // state never reaches the statechange listener below (airhorn-
        // d5q): announce the update now, not from a branch that cannot
        // run.
        if (navigator.serviceWorker.controller) {
          window.__airhornAnnounce?.('Updating the Air Horner to a new version...');
        }
        // 'redundant' means this worker was replaced or dropped; only a
        // worker that never reached 'installed' is a lost upgrade. A
        // replaced worker - like the current controller superseded by
        // the next update - fires 'redundant' on every SUCCESSFUL
        // update, and announcing failure there lied on the happy path
        // (airhorn-swq).
        let reachedInstalled = false;
        newWorker.addEventListener('statechange', () => {
          // Update notices (airhorn-8nz): only when an update arrives
          // over an existing controller - a first install is silent.
          // The message is transient by design: with a controller the
          // page reloads itself via controllerchange right after;
          // mechanics (skipWaiting + reload) are unchanged.
          if (newWorker.state === 'installed') {
            // Record the transition for every worker: a first-install
            // worker reaches 'installed' without a controller, and it
            // is exactly that worker whose later 'redundant' must stay
            // silent (airhorn-swq). Only the ANNOUNCE is gated on an
            // update context.
            reachedInstalled = true;
            if (navigator.serviceWorker.controller) {
              window.__airhornAnnounce?.('A new version is ready - reloading...');
              // This tab has now said why it is about to reload; the
              // controllerchange handler below must not say it a
              // second time (airhorn-56j).
              announcedReady = true;
              newWorker.postMessage('skipWaiting');
            }
          } else if (newWorker.state === 'redundant' && !reachedInstalled && navigator.serviceWorker.controller) {
            // The upgrade was dropped - a denied cache write during precache is the
            // common cause. Say so: silently staying on the previous build is the
            // failure the user cannot see (airhorn-nv9). Through the one polite
            // voice (airhorn-8nz), not a second channel.
            window.__airhornAnnounce?.('The app could not update - you are still on the previous version.');
          }
        });
      }
    });
  });

  const hadController = !!navigator.serviceWorker.controller;
  let announcedReady = false;
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !refreshing) {
      refreshing = true;
      // A tab that opened mid-install never saw updatefound, so nothing
      // has told it why the page is about to reload on its own
      // (airhorn-56j). The tab that reloads says why - and only once:
      // a tab that announced the ready line above stays silent here.
      if (!announcedReady) {
        window.__airhornAnnounce?.('A new version is ready - reloading...');
      }
      window.location.reload();
    }
  });
}
