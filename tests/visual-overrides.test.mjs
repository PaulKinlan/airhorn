/*
 * tests/visual-overrides.test.mjs — user visual overrides stay usable (airhorn-1jrc).
 *
 * The app relies on colour and motion it controls; users can override both at
 * the OS/browser level. This suite emulates the two overrides that matter and
 * pins the observable contracts in headless Chrome, so they cannot rot:
 *
 *   1. forced-colors: active (+ prefers-contrast: more):
 *      - the horn keeps a painted, opaque boundary (not colour-only) against
 *        the page;
 *      - keyboard focus produces a painted :focus-visible ring;
 *      - the pressed/looping state stays legible without the brand colours
 *        (a painted outline plus the translate settle).
 *
 *   2. prefers-reduced-motion: reduce:
 *      - while the horn is sounding, ZERO animations or transitions run
 *        anywhere on the page;
 *      - every transitioned element reports a zero-duration transition,
 *        including the boot-alert button (its hover transition was the one
 *        the original reduced-motion blocks missed - airhorn-1jrc).
 *
 * Evidence screenshots are written to /tmp/airhorn-visual-overrides/<sha>-<stamp>/
 * but the assertions never depend on them.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './support/browser.mjs';

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
  return path.join('/tmp/airhorn-visual-overrides', `${sha}-${stamp}`);
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
    browser = await launchBrowser({ label: 'visual-overrides', timeoutMs: 10000 });

    const ws = new WebSocket(browser.pageWsUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

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
    // Real key paths (Input domain), not element.focus()/dispatchEvent:
    // :focus-visible and the horn's key handlers only respond to trusted events.
    const pressKey = async (key, code, vk) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...(key.length === 1 ? { text: key } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    };
    const setFeatures = (features) => send('Emulation.setEmulatedMedia', { media: 'screen', features });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    // Same readiness condition as a11y.test.mjs: border-radius comes only from
    // the stylesheet, so this cannot pass against an unstyled page.
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
      throw new Error('Page never became ready: no styled horn within 15s');
    }
    await sleep(300);

    /* ----------------- 1. forced-colors: active ----------------------------- */
    await setFeatures([
      { name: 'forced-colors', value: 'active' },
      { name: 'prefers-contrast', value: 'more' },
    ]);
    await sleep(300);
    if (!(await evaluate(`matchMedia('(forced-colors: active)').matches`))) {
      throw new Error('forced-colors emulation not applied: matchMedia reports no active override');
    }
    await shot('1-forced-colors-idle.png');

    // 1a. Boundary survives, not colour-only: an opaque painted border of
    // real width on the horn, plus the boundary outline still painted.
    const idle = await evaluate(`(() => {
      const cs = getComputedStyle(document.querySelector('.horn'));
      return {
        borderWidth: cs.borderTopWidth, borderStyle: cs.borderTopStyle, borderColor: cs.borderTopColor,
        outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor,
        display: cs.display, visibility: cs.visibility,
      };
    })()`);
    const isPainted = (style, width) => style && style !== 'none' && style !== 'hidden' && parseFloat(width) > 0;
    const isOpaque = (color) => !/rgba\([\d.]+,\s*[\d.]+,\s*[\d.]+,\s*0\)/.test(color);
    if (!isPainted(idle.borderStyle, idle.borderWidth) || !isOpaque(idle.borderColor)) {
      throw new Error(`Forced colors: horn boundary border is not painted/opaque: ${JSON.stringify(idle)}`);
    }
    if (parseFloat(idle.borderWidth) < 2) {
      throw new Error(`Forced colors: horn boundary border thinner than the forced-colors rule's 2px: ${idle.borderWidth}`);
    }
    if (!isPainted(idle.outlineStyle, idle.outlineWidth)) {
      throw new Error(`Forced colors: horn boundary outline is not painted: ${JSON.stringify(idle)}`);
    }
    if (idle.display === 'none' || idle.visibility !== 'visible') {
      throw new Error(`Forced colors: the horn disappeared into the page: ${JSON.stringify(idle)}`);
    }
    console.log(`Forced colors idle: border ${idle.borderWidth} ${idle.borderColor}, outline ${idle.outlineWidth} painted`);

    // 1b. Keyboard focus ring survives: real Tab -> :focus-visible with a
    // painted >=3px outline (the UA palette may recolour it; painting is the contract).
    await pressKey('Tab', 'Tab', 9);
    await sleep(150);
    const focus = await evaluate(`(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return {
        isHorn: el === document.querySelector('.horn'),
        focusVisible: el.matches(':focus-visible'),
        outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor,
      };
    })()`);
    if (!focus.isHorn) throw new Error(`Forced colors: Tab did not land on the horn, activeElement is ${JSON.stringify(focus)}`);
    if (!focus.focusVisible) throw new Error('Forced colors: keyboard Tab did not produce :focus-visible on the horn');
    if (!isPainted(focus.outlineStyle, focus.outlineWidth) || parseFloat(focus.outlineWidth) < 3) {
      throw new Error(`Forced colors: focus ring not painted at >=3px: ${JSON.stringify(focus)}`);
    }
    await shot('2-forced-colors-focus.png');
    console.log(`Forced colors focus: :focus-visible, outline ${focus.outlineWidth} painted`);

    // 1c. Pressed state legible without colour: while held, the pressed cue
    // (outline) must be painted at real width and the horn must settle (translate).
    // Focus is still on the horn from the Tab above; hold Space through CDP.
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
    await sleep(400);
    const pressed = await evaluate(`(() => {
      const horn = document.querySelector('.horn');
      const cs = getComputedStyle(horn);
      return {
        horning: horn.classList.contains('horning'),
        ariaPressed: horn.getAttribute('aria-pressed'),
        outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor,
        translate: cs.translate,
      };
    })()`);
    if (!pressed.horning || pressed.ariaPressed !== 'true') {
      throw new Error(`Forced colors: held Space did not enter the pressed state: ${JSON.stringify(pressed)}`);
    }
    if (!isPainted(pressed.outlineStyle, pressed.outlineWidth) || parseFloat(pressed.outlineWidth) < 2) {
      throw new Error(`Forced colors: pressed-state cue not painted at >=2px: ${JSON.stringify(pressed)}`);
    }
    if (!isOpaque(pressed.outlineColor)) {
      throw new Error(`Forced colors: pressed-state cue is fully transparent: ${pressed.outlineColor}`);
    }
    if (pressed.translate === 'none') {
      throw new Error('Forced colors: pressed state lost its translate settle (the motion-free press cue)');
    }
    await shot('3-forced-colors-pressed.png');
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await sleep(150);
    console.log(`Forced colors pressed: outline ${pressed.outlineWidth} painted, translate ${pressed.translate}`);

    // 1d. The boot-failure card stays legible (nothing disappears into the
    // background): revealed, it keeps an opaque painted border and its ink
    // differs from its background.
    await evaluate(`document.getElementById('boot-failure').hidden = false; true`);
    await sleep(150);
    const alert = await evaluate(`(() => {
      const card = getComputedStyle(document.querySelector('.boot-alert'));
      return {
        borderStyle: card.borderTopStyle, borderWidth: card.borderTopWidth,
        bg: card.backgroundColor, ink: card.color,
        display: card.display, visibility: card.visibility,
      };
    })()`);
    if (alert.display === 'none' || alert.visibility !== 'visible') {
      throw new Error(`Forced colors: boot-alert card not rendered: ${JSON.stringify(alert)}`);
    }
    if (!isPainted(alert.borderStyle, alert.borderWidth) || !isOpaque(alert.borderColor)) {
      throw new Error(`Forced colors: boot-alert card boundary not painted/opaque: ${JSON.stringify(alert)}`);
    }
    if (alert.bg === alert.ink) {
      throw new Error(`Forced colors: boot-alert ink identical to its background (text invisible): ${alert.bg}`);
    }
    await shot('4-forced-colors-alert.png');
    await evaluate(`document.getElementById('boot-failure').hidden = true; true`);
    console.log(`Forced colors alert card: border painted, ink ${alert.ink} differs from bg ${alert.bg}`);

    /* ----------------- 2. prefers-reduced-motion: reduce -------------------- */
    await setFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await sleep(300);
    if (!(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`))) {
      throw new Error('reduced-motion emulation not applied: matchMedia reports no override');
    }

    // 2a. Every transitioned element reports zero-duration transitions. The
    // alert button is the regression pin: its hover transition survived the
    // original reduced-motion blocks (airhorn-1jrc).
    const transitions = await evaluate(`(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const durations = cs.transitionDuration.split(',').map((d) => d.trim());
        return { durations, delays: cs.transitionDelay.split(',').map((d) => d.trim()) };
      };
      return {
        horn: pick('.horn'), inner: pick('.horn .inner'), center: pick('.horn .center'),
        installer: pick('#installer'), installerButton: pick('#installer .button'),
        alertButton: pick('.boot-alert .alert-button'),
      };
    })()`);
    for (const [name, t] of Object.entries(transitions)) {
      if (!t) throw new Error(`reduced motion: element for '${name}' not found`);
      const moving = t.durations.some((d) => parseFloat(d) > 0);
      if (moving) {
        throw new Error(`reduced motion: ${name} still declares a timed transition (durations ${t.durations.join(', ')})`);
      }
    }
    console.log('Reduced motion: all transition durations are 0s, including .boot-alert .alert-button');

    // 2b. While the horn is sounding, NOTHING on the page animates. Focus is
    // still on the horn; hold Space. (A Tab here would move to the installer
    // button and sound nothing.)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
    await sleep(400);
    const census = await evaluate(`(() => {
      const all = document.getAnimations({ subtree: true });
      return {
        horning: document.querySelector('.horn').classList.contains('horning'),
        total: all.length,
        running: all.filter((a) => a.playState === 'running').map((a) => ({
          kind: a.constructor.name,
          target: (a.effect?.target?.className || a.effect?.target?.id || a.effect?.target?.tagName || '?'),
        })),
      };
    })()`);
    if (!census.horning) {
      throw new Error(`reduced motion: horn did not enter the pressed state: ${JSON.stringify(census)}`);
    }
    if (census.running.length > 0) {
      throw new Error(
        `reduced motion: ${census.running.length} animation(s)/transition(s) still running while sounding: ` +
        JSON.stringify(census.running)
      );
    }
    await shot('5-reduced-motion-pressed.png');
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    console.log(`Reduced motion: horn sounding, ${census.total} animations on the page, 0 running`);

    // Restore automatic media so nothing leaks into any later reuse.
    await setFeatures([]);

    console.log('ALL VISUAL OVERRIDE CHECKS PASSED');
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
