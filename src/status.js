/*
 * src/status.js — connection-status awareness (airhorn-8nz).
 *
 * Say when the connection drops or returns. The horn itself keeps working
 * offline (cached shell plus the synth fallback), so the copy promises exactly
 * that and nothing more. Announced through the one polite live region defined by
 * the inline boot script in index.html. Only transitions speak: the normal,
 * connected case stays silent, and a page opened offline says so once at boot.
 *
 * bindStatus() is called at MODULE scope from src/main.js, not inside the load
 * handler: the boot-time check and both listeners have to be in place before
 * load - that is when they ran when this lived in main.js.
 */

function announceOffline() {
  window.__airhornAnnounce?.('No connection - the Air Horner still works from the copy on your device.');
}

function announceOnline() {
  window.__airhornAnnounce?.('Back online.');
}

export function bindStatus() {
  if (!navigator.onLine) {
    announceOffline();
  }
  window.addEventListener('offline', announceOffline);
  window.addEventListener('online', announceOnline);
}
