/*
 * tests/csp-boot.test.mjs — the page boots UNDER THE SERVED POLICY
 * (airhorn-yxxq). public/_headers was previously pinned only as TEXT
 * (tests/pages-config.test.js); a header that broke the boot — a bad CSP, a
 * nosniff with the wrong MIME, a policy that blocks the inline handlers — could
 * not fail a test. This suite serves dist/ through the ONE shared static
 * server with headers: 'auto' (the real Pages subset) and drives the page:
 *
 *   1. the policy is actually ON THE WIRE (a fetched response carries the
 *      headers - without this, every other assert could pass against a
 *      policy-less server);
 *   2. the module bundle ran: window.__airhorn exists (main.js sets it only
 *      after the AirHorn is constructed and bound), and the watchdog banner
 *      #boot-failure stays hidden;
 *   3. the stylesheet actually APPLIES: the async link's media swap fired
 *      (media becomes 'all'; a blocked inline onload leaves it 'print' and the
 *      page on critical CSS - the reviewer shows this suite red by deleting
 *      that handler), and .stylesheet-failed is absent;
 *   4. the horn works under the policy (click -> aria-pressed flips), the
 *      behaviour the whole page exists for.
 *
 * Nosniff is the header most likely to bite first: a wrong MIME on
 * /styles/main.css or the module scripts would now fail here instead of in
 * production on a Google-owned demo origin.
 */
import { launchBrowser, killTree } from './support/browser.mjs';
import { awaitSocketOpen } from './cdp-command-bound.mjs';
import { serveDist } from './support/static-server.mjs';

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

let browser = null;
let server = null;
try {
  const served = await serveDist({ dir: 'dist', headers: 'auto' });
  server = served.server;
  const origin = `http://127.0.0.1:${served.port}`;

  // 1. The policy is on the wire, not just in a file.
  const res = await fetch(`${origin}/index.html`);
  const servedHeaders = Object.fromEntries([...res.headers].map(([k, v]) => [k.toLowerCase(), v]));
  assert(servedHeaders['x-content-type-options'] === 'nosniff',
    `the served response does not carry the Pages policy headers (got ${JSON.stringify(servedHeaders)}) - ` +
    `the suite would be asserting a boot under NO policy (airhorn-yxxq)`);
  assert(servedHeaders['x-frame-options'] === 'DENY',
    'the served response must carry the full Pages policy (X-Frame-Options missing)');

  browser = await launchBrowser({ label: 'csp-boot', timeoutMs: 20000 });
  const ws = new WebSocket(browser.pageWsUrl);
  try {
    await awaitSocketOpen(ws, { url: browser.pageWsUrl });
  } catch (err) {
    await browser.close();
    server.close();
    throw err;
  }

  let msgId = 1;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) => {
    const id = msgId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page-side: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Page.navigate', { url: `${origin}/` });

  const waitFor = async (expr, timeoutMs, what) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await evaluate(expr).catch(() => undefined);
      if (v) return v;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  // 2. The module bundle ran and the watchdog stayed hidden.
  await waitFor(`typeof window.__airhorn !== 'undefined'`, 10000,
    'the module bundle (window.__airhorn) - a header blocked the boot (airhorn-yxxq)');
  const bannerHidden = await evaluate(`document.getElementById('boot-failure').hidden`);
  assert(bannerHidden === true,
    'the boot watchdog revealed on a healthy boot under the served policy (airhorn-yxxq)');

  // 3. The stylesheet swap fired and the sheet applies.
  await waitFor(`(() => {
    const link = document.querySelector('link[href="/styles/main.css"]');
    return link && link.media === 'all';
  })()`, 10000, "the async stylesheet's media swap - its inline onload handler did not run under the served policy (airhorn-yxxq)");
  const cssFailed = await evaluate(`document.documentElement.classList.contains('stylesheet-failed')`);
  assert(cssFailed === false,
    'the stylesheet FAILED under the served policy (stylesheet-failed set) - nosniff/MIME is blocking /styles/main.css (airhorn-yxxq)');
  const sheetLive = await evaluate(`[...document.styleSheets].some((s) => s.href && s.href.endsWith('/styles/main.css'))`);
  assert(sheetLive === true, 'the full stylesheet is not live in document.styleSheets under the served policy');

  // 4. The horn works under the policy.
  await evaluate(`document.querySelector('.horn').click()`);
  await waitFor(`document.querySelector('.horn').getAttribute('aria-pressed') === 'true'`, 8000,
    'the horn press under the served policy - a header blocked the interaction path (airhorn-yxxq)');

  console.log('csp-boot: the page boots under the SERVED Pages policy - headers on the wire, bundle ran, watchdog hidden, stylesheet applied, horn pressed.');
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
}
