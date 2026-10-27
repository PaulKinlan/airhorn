/*
 * tests/reflow-zoom.test.mjs — WCAG 1.4.10 reflow at 320px and 1.4.4 text
 * resize to 200% (airhorn-xaxg).
 *
 * Two configs, exactly the ones the success criteria name:
 *   - 320x640 at default text size (1.4.10: content must reflow to a 320px
 *     width without two-dimensional scrolling);
 *   - 1280x720 with text resized to 200% (1.4.4: no loss of content or
 *     functionality; this page sizes in rem, so the resize path is the root
 *     font size).
 *
 * Per config, in headless Chrome with real input events:
 *   - no horizontal overflow (the assertion the bead asks to keep from
 *     regressing silently), measured on html and body;
 *   - the horn is fully in the viewport and pressable with a real pointer
 *     event (pressed state flips);
 *   - the live region, filled with a long announcement, either stays inside
 *     the viewport and does not overflow its own box, or is sr-only by
 *     design (airhorn-985r: a live region does not have to be painted);
 *   - NO element anywhere clips or horizontally scrolls its text inside a
 *     clipping/scroll container (airhorn-jw7w: a card's bounding box being
 *     in the viewport proves nothing about its CONTENT - the boot-alert
 *     mutant with overflow:hidden + white-space:nowrap hid 259px of update
 *     text at 320px while every box-level check stayed green);
 *   - the install affordance, forced available, stays on-screen and is the
 *     topmost element at its own centre (nothing covers it);
 *   - the boot-alert card stays inside the viewport.
 *
 * Evidence screenshots are written to /tmp/airhorn-reflow-zoom/<sha>-<stamp>/
 * but the assertions never depend on them.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './support/browser.mjs';
import { awaitSocketOpen } from './cdp-command-bound.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

function makeEvidenceDir() {
  let sha = 'worktree';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim();
  } catch { /* not a git checkout: keep the default name */ }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join('/tmp/airhorn-reflow-zoom', `${sha}-${stamp}`);
}

async function run() {
  const distDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run build first.');
  }
  const evidenceDir = makeEvidenceDir();
  fs.mkdirSync(evidenceDir, { recursive: true });

  const server = http.createServer((req, res) => {
    let filePath = path.join(distDir, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    if (fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`Server listening on port ${port}`);

  let browser = null;
  try {
    browser = await launchBrowser({ label: 'reflow-zoom', timeoutMs: 15000, autoplay: true });

    const ws = new WebSocket(browser.pageWsUrl);
    // Bounded (airhorn-eabw): an unbounded onopen await parks the suite if the
    // socket never opens; this also rejects on error/close so the refusal is named.
    await awaitSocketOpen(ws, { url: browser.pageWsUrl });

    let msgId = 1;
    const pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = msgId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      }
      return r.result.value;
    };
    const shot = async (name) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(evidenceDir, name), Buffer.from(r.data, 'base64'));
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Runtime.evaluate', { expression: '1', returnByValue: true }); // warm the session

    const LONG_ANNOUNCEMENT =
      'The app could not update - you are still on the previous version. ' +
      'Check your connection and reload to try again; the horn keeps working offline meanwhile.';

    // One pass of every layout contract at one viewport/text-size config.
    // `label` names every failure with the viewport and the measurement, as
    // the bead asks.
    const checkConfig = async ({ label, width, height, textScale, shotPrefix }) => {
      await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      });
      await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
      for (let i = 0; i < 100; i++) {
        if (await evaluate(`document.readyState === 'complete'`).catch(() => false)) break;
        await sleep(100);
      }
      // Reset from any previous config, then apply the text scale. The page
      // sizes in rem, so the root font size IS the text-resize path.
      await evaluate(`document.documentElement.removeAttribute('style'); document.getElementById('app-status').textContent = ''; document.getElementById('installer').classList.remove('available'); true`);
      if (textScale !== 100) {
        await evaluate(`document.documentElement.style.fontSize = '${textScale}%'; true`);
      }
      // Styled-horn readiness (same rule as the other suites: border-radius
      // comes only from the stylesheet).
      let pageReady = false;
      for (let i = 0; i < 150; i++) {
        const ready = await evaluate(`document.readyState === 'complete' && (() => {
          const horn = document.querySelector('.horn');
          return !!horn && window.getComputedStyle(horn).borderRadius !== '0px';
        })()`);
        if (ready) { pageReady = true; break; }
        await sleep(100);
      }
      if (!pageReady) {
        throw new Error(`${label}: page never became ready (no styled horn within 15s)`);
      }
      await sleep(300);
      const reported = await evaluate(`(() => {
        const cs = getComputedStyle(document.documentElement);
        return { fontSize: cs.fontSize, forced: matchMedia('(forced-colors: active)').matches };
      })()`);
      if (textScale !== 100 && !reported.fontSize.startsWith('32')) {
        throw new Error(`${label}: text scale not applied (root font size ${reported.fontSize}, expected ~32px)`);
      }
      console.log(`${label}: root font size ${reported.fontSize}`);

      // 1. No horizontal overflow, on html AND body. This is the assertion
      // the bead asks for so reflow cannot regress silently.
      const overflow = await evaluate(`(() => {
        const html = document.documentElement, body = document.body;
        return {
          htmlScrollWidth: html.scrollWidth, bodyScrollWidth: body.scrollWidth,
          innerWidth: window.innerWidth,
          htmlOverflow: html.scrollWidth - window.innerWidth,
          bodyOverflow: body.scrollWidth - window.innerWidth,
        };
      })()`);
      if (overflow.htmlOverflow > 1 || overflow.bodyOverflow > 1) {
        throw new Error(
          `${label}: HORIZONTAL OVERFLOW - html.scrollWidth ${overflow.htmlScrollWidth} / ` +
          `body.scrollWidth ${overflow.bodyScrollWidth} vs innerWidth ${overflow.innerWidth} ` +
          `(html +${overflow.htmlOverflow}px, body +${overflow.bodyOverflow}px) - ` +
          `WCAG 1.4.10 requires no two-dimensional scrolling at this width`
        );
      }
      console.log(`${label}: no horizontal overflow (html ${overflow.htmlScrollWidth}px, viewport ${overflow.innerWidth}px)`);

      // 2. Horn fully visible and pressable with a REAL pointer event.
      const hornGeom = await evaluate(`(() => {
        const horn = document.querySelector('.horn');
        const r = horn.getBoundingClientRect();
        const cs = getComputedStyle(horn);
        return {
          x: r.x, y: r.y, width: r.width, height: r.height,
          inViewport: r.x >= -1 && r.y >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
          visible: cs.display !== 'none' && cs.visibility === 'visible' && r.width > 0 && r.height > 0,
          centreX: Math.round(r.x + r.width / 2), centreY: Math.round(r.y + r.height / 2),
        };
      })()`);
      if (!hornGeom.visible || !hornGeom.inViewport) {
        throw new Error(`${label}: horn not fully visible in viewport: ${JSON.stringify(hornGeom)}`);
      }
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hornGeom.centreX, y: hornGeom.centreY, button: 'left', clickCount: 1 });
      await sleep(350);
      const pressed = await evaluate(`(() => {
        const horn = document.querySelector('.horn');
        return { horning: horn.classList.contains('horning'), ariaPressed: horn.getAttribute('aria-pressed') };
      })()`);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hornGeom.centreX, y: hornGeom.centreY, button: 'left', clickCount: 1 });
      await sleep(120);
      if (!pressed.horning || pressed.ariaPressed !== 'true') {
        throw new Error(`${label}: horn not pressable at (${hornGeom.centreX},${hornGeom.centreY}): ${JSON.stringify(pressed)}`);
      }
      await shot(`${shotPrefix}-pressed.png`);
      console.log(`${label}: horn visible (${hornGeom.width}x${hornGeom.height}) and press toggles at (${hornGeom.centreX},${hornGeom.centreY})`);

      // 3. Live region: a long announcement must reach users. Two shapes are
      // legitimate (airhorn-985r): the app's current painted card (then it
      // must be inside the viewport and not overflow its own box), or a
      // permanently sr-only region (clip-path inset is the standard sr-only
      // pattern and fully WCAG-conforming - a live region does not have to be
      // painted, so requiring visibility here would block a correct a11y
      // refactor). What is NEVER legitimate is a painted region outside the
      // viewport or overflowing its container.
      await evaluate(`(() => {
        const el = document.getElementById('app-status');
        el.textContent = ${JSON.stringify(LONG_ANNOUNCEMENT)};
        return 'set';
      })()`);
      await sleep(120);
      const liveGeom = await evaluate(`(() => {
        const el = document.getElementById('app-status');
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          // sr-only by design: clipped to nothing by its own clip-path (the
          // .visually-hidden / :empty pattern). Distinguished from being
          // clipped by an ANCESTOR's overflow, which loses the announcement
          // box without intent.
          srOnly: cs.clipPath !== 'none',
          inViewport: r.x >= -1 && r.y >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
          internalOverflowX: el.scrollWidth - el.clientWidth,
          internalOverflowY: el.scrollHeight - el.clientHeight,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        };
      })()`);
      if (liveGeom.srOnly) {
        console.log(`${label}: live region is sr-only by design (clip-path inset) - announced without painting, bounds checks not applicable`);
      } else {
        if (!liveGeom.inViewport) {
          throw new Error(`${label}: live region outside the viewport while announcing: ${JSON.stringify(liveGeom)}`);
        }
        if (liveGeom.internalOverflowX > 1 || liveGeom.internalOverflowY > 1) {
          throw new Error(
          `${label}: live region text overflows its container by ` +
          `${liveGeom.internalOverflowX}x${liveGeom.internalOverflowY}px: ${JSON.stringify(liveGeom.rect)}`
        );
      }
        console.log(`${label}: live region announcement in viewport, no container overflow ${JSON.stringify(liveGeom.rect)}`);
      }

      // 4. Install affordance reachable: forced available, on-screen, and the
      // topmost element at its centre.
      await evaluate(`document.getElementById('installer').classList.add('available'); true`);
      await sleep(120);
      const install = await evaluate(`(() => {
        const btn = document.querySelector('#installer .button');
        const r = btn.getBoundingClientRect();
        const inViewport = r.x >= -1 && r.y >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
        const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
        const hit = document.elementFromPoint(cx, cy);
        return { inViewport, cx, cy, hitIsButtonOrChild: btn === hit || btn.contains(hit), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
      })()`);
      if (!install.inViewport) {
        throw new Error(`${label}: install button pushed off-screen: ${JSON.stringify(install.rect)}`);
      }
      if (!install.hitIsButtonOrChild) {
        throw new Error(`${label}: install button covered at its own centre (${install.cx},${install.cy}) - not reachable`);
      }
      console.log(`${label}: install affordance on-screen and hittable ${JSON.stringify(install.rect)}`);

      // 5. Boot-alert card (the update/backup message surface) stays inside
      // the viewport while revealed.
      await evaluate(`document.getElementById('boot-failure').hidden = false; true`);
      await sleep(120);
      const alertGeom = await evaluate(`(() => {
        const el = document.querySelector('.boot-alert');
        const r = el.getBoundingClientRect();
        return {
          inViewport: r.x >= -1 && r.y >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        };
      })()`);
      await shot(`${shotPrefix}-alert.png`);
      if (!alertGeom.inViewport) {
        throw new Error(`${label}: boot-alert card outside the viewport: ${JSON.stringify(alertGeom.rect)}`);
      }
      console.log(`${label}: boot-alert card in viewport ${JSON.stringify(alertGeom.rect)}`);

      // 6. Content census (airhorn-jw7w): box checks above prove a container
      // is PLACED well, not that its CONTENT is readable. An element that
      // clips (hidden/clip) or scrolls (auto/scroll) its own content while
      // the content exceeds the box hides text with no document-level
      // overflow signal. Sweep every element with all surfaces revealed:
      // any non-sr-only element whose content exceeds its box on an axis it
      // clips or scrolls is a defect. (overflow:visible is NOT flagged: the
      // spill paints, stays readable, and the document-level check 1 governs
      // it. clip-path'd elements are sr-only by design - airhorn-985r.)
      const clipped = await evaluate(`(() => {
        const describe = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
          (el.className && typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
        const clipsOrScrolls = (v) => ['hidden', 'clip', 'auto', 'scroll', 'overlay'].includes(v);
        const offenders = [];
        for (const el of document.querySelectorAll('*')) {
          const cs = getComputedStyle(el);
          if (cs.clipPath !== 'none') continue;
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          if (el.clientWidth === 0 && el.clientHeight === 0) continue;
          const overX = el.scrollWidth - el.clientWidth;
          const overY = el.scrollHeight - el.clientHeight;
          if (clipsOrScrolls(cs.overflowX) && overX > 2) {
            offenders.push({ el: describe(el), axis: 'x', overPx: overX, overflow: cs.overflowX });
          }
          if (clipsOrScrolls(cs.overflowY) && overY > 2) {
            offenders.push({ el: describe(el), axis: 'y', overPx: overY, overflow: cs.overflowY });
          }
        }
        return offenders;
      })()`);
      if (clipped.length > 0) {
        throw new Error(
          `${label}: ${clipped.length} element(s) clip or scroll their own content ` +
          `(text unreadable / in-container horizontal scrolling - WCAG 1.4.10): ${JSON.stringify(clipped)}`
        );
      }
      console.log(`${label}: content census clean - no element clips or scrolls its own text`);

      await evaluate(`document.getElementById('boot-failure').hidden = true; document.getElementById('app-status').textContent = ''; document.getElementById('installer').classList.remove('available'); true`);
    };

    /* ---------------- config 1: 320x640, default text ---------------------- */
    await checkConfig({ label: '320x640 @100%', width: 320, height: 640, textScale: 100, shotPrefix: '1-320' });
    await shot('1-320-idle.png');

    /* ---------------- config 2: 1280x720, 200% text ------------------------ */
    await checkConfig({ label: '1280x720 @200%', width: 1280, height: 720, textScale: 200, shotPrefix: '2-200pct' });
    await shot('2-200pct-idle.png');

    console.log('ALL REFLOW/ZOOM CHECKS PASSED');
    console.log(`Evidence: ${evidenceDir}`);
  } finally {
    if (browser) {
      await browser.close();
    }
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
