/*
 * tests/support/browser.mjs — the suites' entry point to the one Chrome launch
 * path (airhorn-2po9), with the gate's shared browser in front of it
 * (airhorn-w1wh).
 *
 * This module used to BE that path. It now lives in tools/lib/chrome.mjs,
 * because the eight tools had their own copies and the drift was paid for one
 * merge at a time.
 *
 * Two modes, and the suites never choose between them:
 *
 *   shared    tools/shared-chrome.mjs has started ONE browser for the whole gate
 *             run and exported AIRHORN_CHROME_WS[_AUTOPLAY|_WEBMCP]; a suite then
 *             gets a fresh page (Target.createTarget) in that browser instead of
 *             launching its own. This is the starved-host path: on a box stealing
 *             88-96% of the CPU a launch costs 22-57s, and eleven of them cannot
 *             fit any gate bound, while one can (airhorn-w1wh).
 *   cold      no env var (a suite run by hand, a family the gate did not start,
 *             or a healthy host where sharing was measured SLOWER - the ecp A/B
 *             in tools/lib/chrome.mjs's header). Straight to launchChrome.
 *
 * A missing family env var falls back to the cold launch, so a gap in the gate's
 * family map costs time, never correctness.
 *
 * The cold mode is a re-export, not a wrapper: same options, same handle, same
 * failure messages.
 */
import { launchChrome } from '../../tools/lib/chrome.mjs';

export { chromeBin, killTree, sweepProfile, launchChrome, connectPage } from '../../tools/lib/chrome.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envUrlFor({ autoplay = false, webmcp = false } = {}) {
  if (webmcp) return process.env.AIRHORN_CHROME_WS_WEBMCP;
  if (autoplay) return process.env.AIRHORN_CHROME_WS_AUTOPLAY;
  return process.env.AIRHORN_CHROME_WS;
}

async function openSocket(wsUrl, timeoutMs, what) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${what}: WebSocket open timeout (${timeoutMs}ms)`)), timeoutMs);
    ws.onopen = () => { clearTimeout(timeout); resolve(); };
    ws.onerror = (e) => { clearTimeout(timeout); reject(new Error(`${what}: WebSocket error ${e.message || ''}`)); };
  });
  return ws;
}

/*
 * A fresh page in the gate's browser, behind the same handle a cold launch
 * returns - so a suite cannot tell which mode it got, which is what keeps the
 * shared path from becoming a second behaviour to test.
 */
async function sharedLaunch(browserWsUrl, { label = 'shared', timeoutMs = 15000 } = {}) {
  const bound = Math.max(timeoutMs, 20000);   // a created target is ms; the bound is for a starved box
  const ws = await openSocket(browserWsUrl, bound, `shared chrome (${label})`);
  let messageId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  };
  let open = true;
  const send = (method, params = {}) => {
    if (!open) return Promise.reject(new Error(`shared chrome (${label}): browser socket closed`));
    const id = messageId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  // The default context on purpose: serviceWorker is undefined in an off-the-
  // record context (probed for airhorn-ecp), and most suites drive the SW.
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  // A created target starts BACKGROUNDED, and Chrome throttles a background
  // page's timers (up to 1/minute), which turns every poll in a suite into a
  // crawl (measured for ecp: shortcuts 19s foreground vs 107s backgrounded).
  await send('Target.activateTarget', { targetId });

  // /json/list is the only place the page ws URL is published, and a shared
  // browser lists EVERY suite's targets - so match by target id, never by order.
  const port = new URL(browserWsUrl).port;
  const deadline = Date.now() + bound;
  let pageWsUrl = null;
  while (!pageWsUrl && Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      pageWsUrl = targets.find((target) => target.id === targetId)?.webSocketDebuggerUrl || null;
    } catch { /* the devtools endpoint is briefly unavailable; retry until the bound */ }
    if (!pageWsUrl) await sleep(100);
  }
  if (!pageWsUrl) {
    open = false;
    try { ws.close(); } catch { /* already gone */ }
    throw new Error(`shared chrome (${label}): page target ${targetId} never appeared in /json/list`);
  }

  let closed = false;
  return {
    shared: true,
    chrome: null,
    browserWsUrl,
    port: Number(port),
    pageTargetId: targetId,
    pageWsUrl,
    profileDir: null,
    async close() {
      if (closed) return 0;
      closed = true;
      try { await send('Target.closeTarget', { targetId }); } catch { /* the browser may be gone */ }
      open = false;
      try { ws.close(); } catch { /* already closed */ }
      return 0;
    },
    // The gate owns the shared browser: there is nothing suite-local to kill, and
    // a suite's signal handler must not take the other suites' pages with it.
    killNow() { /* no-op by design */ },
  };
}

export async function launchBrowser(options = {}) {
  const sharedWs = envUrlFor(options);
  return sharedWs ? sharedLaunch(sharedWs, options) : launchChrome(options);
}
