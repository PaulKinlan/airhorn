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
 *        the original reduced-motion blocks missed - airhorn-1jrc);
 *      - a DOCUMENT-WIDE census (not a selector whitelist, airhorn-epbq):
 *        any element declaring a timed transition or animation under reduce
 *        fails, so a future element cannot rot in unnoticed.
 *
 *   3. typography system & scale hierarchy (airhorn-fonts, airhorn-m2tt):
 *      - all painted elements resolve to the unified modern system font stack;
 *      - active painted hierarchy holds: body (16px) > button (15px) > caption (14px);
 *      - button weight (500) > body/caption (400) with proportional line-heights;
 *      - the caption tier PAINTS: #app-status is a 1px box while it has nothing
 *        to say, so the asserted caption was only ever measured on a box that is
 *        not on screen. The app's own offline announcement is fired through its
 *        real listener and the caption is asserted to grow, and captured in the
 *        active-hierarchy screenshot (airhorn-7q0x);
 *      - fallback heading tier (.horn-label under .stylesheet-failed) paints with
 *        computed heading scale (20px / 600 weight);
 *      - dead typography rules on .horn-label in main.css are eliminated - pinned
 *        at the source, because a painted-element census cannot see declarations
 *        on a display: none element come back (airhorn-xfkf).
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
import { WAIT_TIMEOUT_MS, waitForCondition } from './support/poll.mjs';

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
    // Wait for a STATE, never for the clock (airhorn-sesh): every sleep-then-read
    // below used to give the app 150-400 ms to react, which is a machine-state
    // assertion - on a loaded box the key event, the class change and the style
    // flush queue behind other lanes and a correct app read red.
    const waitFor = async (predicate, { label = 'condition', timeout = WAIT_TIMEOUT_MS } = {}) =>
      waitForCondition(async () => {
        const value = await predicate();
        return value || null;
      }, { label, timeout, observe: () => 'see the failure above' });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (r.exceptionDetails) {
        throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
      }
      return r.result.value;
    };
    const shot = async (name, { fullPage = false } = {}) => {
      const params = { format: 'png' };
      if (fullPage) {
        // The status caption sits after a full-height horn, so it is below the
        // fold: a viewport capture cannot show the tier the shot is named for.
        const metrics = await send('Page.getLayoutMetrics');
        const size = metrics.cssContentSize || metrics.contentSize;
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
      }
      const r = await send('Page.captureScreenshot', params);
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
    await waitFor(() => evaluate(`document.activeElement === document.querySelector('.horn') && document.activeElement.matches(':focus-visible')`),
      { label: 'Tab to land :focus-visible on the horn' });
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
    const readPressed = () => evaluate(`(() => {
      const horn = document.querySelector('.horn');
      const cs = getComputedStyle(horn);
      return {
        horning: horn.classList.contains('horning'),
        ariaPressed: horn.getAttribute('aria-pressed'),
        outlineWidth: cs.outlineWidth, outlineStyle: cs.outlineStyle, outlineColor: cs.outlineColor,
        translate: cs.translate,
      };
    })()`);
    const pressed = await waitFor(async () => {
      const state = await readPressed();
      return state.horning && state.ariaPressed === 'true' ? state : null;
    }, { label: 'the forced-colors pressed state after holding Space' });
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
        borderStyle: card.borderTopStyle, borderWidth: card.borderTopWidth, borderColor: card.borderTopColor,
        bg: card.backgroundColor, ink: card.color,
        display: card.display, visibility: card.visibility,
      };
    })()`);
    if (alert.display === 'none' || alert.visibility !== 'visible') {
      throw new Error(`Forced colors: boot-alert card not rendered: ${JSON.stringify(alert)}`);
    }
    if (!isPainted(alert.borderStyle, alert.borderWidth)) {
      throw new Error(`Forced colors: boot-alert card boundary not painted: ${JSON.stringify(alert)}`);
    }
    // borderColor IS returned by the probe, so these two are live checks
    // (airhorn-1ir4: it used to read a property the probe never returned, so
    // isOpaque(undefined) was always true - an assertion that could not fail).
    if (!isOpaque(alert.borderColor)) {
      throw new Error(`Forced colors: boot-alert card boundary fully transparent: ${alert.borderColor}`);
    }
    if (alert.borderColor === alert.bg) {
      throw new Error(`Forced colors: boot-alert boundary colour identical to its background (no visible edge): ${alert.borderColor}`);
    }
    if (alert.bg === alert.ink) {
      throw new Error(`Forced colors: boot-alert ink identical to its background (text invisible): ${alert.bg}`);
    }
    await shot('4-forced-colors-alert.png');
    await evaluate(`document.getElementById('boot-failure').hidden = true; true`);
    console.log(`Forced colors alert card: border ${alert.borderColor} differs from bg ${alert.bg}, ink differs too`);

    /* ----------------- 2. prefers-reduced-motion: reduce -------------------- */
    await setFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await sleep(300);
    if (!(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`))) {
      throw new Error('reduced-motion emulation not applied: matchMedia reports no override');
    }

    // 2a. Named regression pins, kept for readable failure messages: every
    // element that ever carried a transition must report zero-duration now.
    // The alert button is the pin for the hover transition the original
    // reduced-motion blocks missed (airhorn-1jrc). The census in 2a-bis
    // (airhorn-epbq) subsumes these but fails with a raw offender dump; these
    // fail naming the contract.
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
    console.log('Reduced motion: all named transition durations are 0s, including .boot-alert .alert-button');

    // 2a-bis. Document-wide census (airhorn-epbq): the named pins above are a
    // whitelist - a NEW element with a live transition under reduce passed
    // green (proven by the reviewer with #app-status). Sweep every element:
    // any computed transition with a timed duration and a non-none property,
    // or any non-none timed animation, is a defect - wherever it appears.
    const motionDecls = await evaluate(`(() => {
      const describe = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
        (el.className && typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
      const timed = (list) => String(list).split(',').some((d) => parseFloat(d) > 0);
      const offenders = [];
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (cs.transitionProperty !== 'none' && timed(cs.transitionDuration)) {
          offenders.push({ el: describe(el), kind: 'transition', property: cs.transitionProperty, durations: cs.transitionDuration });
        }
        if (cs.animationName !== 'none' && timed(cs.animationDuration)) {
          offenders.push({ el: describe(el), kind: 'animation', name: cs.animationName, durations: cs.animationDuration });
        }
      }
      return offenders;
    })()`);
    if (motionDecls.length > 0) {
      throw new Error(`reduced motion: ${motionDecls.length} element(s) still declare timed motion: ${JSON.stringify(motionDecls)}`);
    }
    console.log('Reduced motion: document-wide census clean - no element declares timed motion');

    // 2b. While the horn is sounding, NOTHING on the page animates. Focus is
    // still on the horn; hold Space. (A Tab here would move to the installer
    // button and sound nothing.)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
    const readCensus = () => evaluate(`(() => {
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
    // Wait for the pressed state, THEN read the census: the claim is "nothing
    // animates while it sounds", which is a state condition, not a 400 ms one.
    const census = await waitFor(async () => {
      const state = await readCensus();
      return state.horning ? state : null;
    }, { label: 'the reduced-motion pressed state after holding Space' });
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

    /* ----------------- 3. Typography: modern system stack & hierarchy (airhorn-m2tt) -- */
    console.log('--- 3. Typography: system font stack & hierarchy');
    // Ensure standard elements and alerts are revealed for inspection in the active app.
    await evaluate(`(() => {
      document.getElementById('boot-failure').hidden = false;
      document.getElementById('installer').classList.add('available');
    })()`);
    await sleep(200);

    const expectedSystemStack = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
    const px = (val) => parseFloat(val);

    // 3a. Active painted elements hierarchy: verify elements that actually render on screen.
    const activeTypography = await evaluate(`(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          fontFamily: cs.fontFamily,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          lineHeight: cs.lineHeight,
          display: cs.display,
          visibility: cs.visibility,
          isPainted: cs.display !== 'none' && cs.visibility !== 'visible' ? false : (r.width > 0 && r.height > 0),
        };
      };
      return {
        body: pick('body'),
        installerButton: pick('#installer .button'),
        alertButton: pick('.alert-button'),
        bootAlertP: pick('.boot-alert p'),
        status: pick('#app-status'),
        hornLabel: pick('.horn-label'),
        h1: pick('h1'),
      };
    })()`);

    // In the active styled app, .horn-label is intentionally hidden (display: none)
    // because the concentric horn disc speaks for itself and is labeled by aria-label.
    if (activeTypography.hornLabel.display !== 'none') {
      throw new Error(`Active app must keep .horn-label hidden (display: none), got ${activeTypography.hornLabel.display}`);
    }

    // Verify all painted elements resolve to the modern system stack.
    const paintedElements = {
      body: activeTypography.body,
      installerButton: activeTypography.installerButton,
      alertButton: activeTypography.alertButton,
      bootAlertP: activeTypography.bootAlertP,
      status: activeTypography.status,
    };
    for (const [name, metrics] of Object.entries(paintedElements)) {
      if (!metrics) throw new Error(`Active element '${name}' not found`);
      if (name !== 'body' && !metrics.isPainted) {
        throw new Error(`Active element '${name}' is not painted on screen`);
      }
      if (metrics.fontFamily !== expectedSystemStack) {
        throw new Error(`Active element '${name}' font-family mismatch: ${metrics.fontFamily}`);
      }
    }
    console.log('Active app typography: all painted elements resolve to modern system font stack');

    // Active painted hierarchy: Body (16px) > Button (15px) > Caption (14px)
    const bodySize = px(activeTypography.body.fontSize);
    const buttonSize = px(activeTypography.installerButton.fontSize);
    const captionSize = px(activeTypography.status.fontSize);
    if (!(bodySize > buttonSize && buttonSize > captionSize)) {
      throw new Error(
        `Active hierarchy violation: body (${bodySize}px) > button (${buttonSize}px) > caption (${captionSize}px)`
      );
    }
    console.log(`Active painted hierarchy verified: body (${bodySize}px) > button (${buttonSize}px) > caption (${captionSize}px)`);

    // Weights: button (500) > body/caption (400)
    if (activeTypography.installerButton.fontWeight !== '500' || activeTypography.alertButton.fontWeight !== '500') {
      throw new Error('Buttons must have medium font weight (500)');
    }
    if (activeTypography.body.fontWeight !== '400' || activeTypography.status.fontWeight !== '400') {
      throw new Error('Body and status must have regular font weight (400)');
    }
    console.log('Active painted weights verified: button (500) > body/caption (400)');

    // The caption tier's element is #app-status, which is deliberately a 1px
    // absolute box until it has something to say - so its font-size above was
    // read off a box that is not on screen, and the capture this suite took for
    // the hierarchy showed only the boot-failure card: no caption tier at all.
    // Put the app in the state where those two tiers really do paint, through
    // the app's OWN listeners (a stand-in beforeinstallprompt, which is what
    // Chrome fires and the a11y suite walks too, and the window 'offline' event
    // src/main.js announces from), then prove they paint and capture that
    // state (airhorn-7q0x).
    const liveState = await evaluate(`(() => {
      window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), {
        prompt() {},
        userChoice: Promise.resolve({ outcome: 'dismissed' }),
      }));
      window.dispatchEvent(new Event('offline'));
      // The live app, not the boot-failure card case 1d revealed to measure it:
      // the two states are mutually exclusive in reality (a dead bundle cannot
      // announce anything), so measuring them together must not be photographed
      // together.
      document.getElementById('boot-failure').hidden = true;
      const pick = (sel) => {
        const el = document.querySelector(sel);
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          text: (el.textContent || '').trim(),
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          disabled: !!el.disabled,
          display: cs.display,
          width: r.width,
          height: r.height,
        };
      };
      return { caption: pick('#app-status'), install: pick('#installer .button') };
    })()`);
    const captionPainted = liveState.caption;
    if (!captionPainted.text) {
      throw new Error('caption tier: the app announced nothing on the offline event, so the caption tier cannot be shown to paint');
    }
    if (!(captionPainted.width > 4 && captionPainted.height > 4)) {
      throw new Error(`caption tier: #app-status holds ${JSON.stringify(captionPainted.text)} but is still a ${captionPainted.width}x${captionPainted.height} box - the caption does not paint`);
    }
    if (px(captionPainted.fontSize) !== captionSize || captionPainted.fontWeight !== '400') {
      throw new Error(`caption tier: painted caption is ${captionPainted.fontSize}/${captionPainted.fontWeight} (expected ${captionSize}px/400)`);
    }
    // ... and the control whose tier it is hierarchy-compared against is on
    // screen too, so the screenshot contains both painted tiers, not a comparison
    // between a painted element and a hidden one.
    if (liveState.install.disabled || !(liveState.install.width > 4 && liveState.install.height > 4)) {
      throw new Error(`active hierarchy: the install control is not a live painted control in the captured state: ${JSON.stringify(liveState.install)}`);
    }
    console.log(`Caption tier verified PAINTED: "${captionPainted.text}" at ${captionPainted.fontSize}/${captionPainted.fontWeight} in a ${Math.round(captionPainted.width)}x${Math.round(captionPainted.height)} box, next to the ${liveState.install.fontSize}/${liveState.install.fontWeight} install control`);

    await shot('6-typography-live-tiers.png', { fullPage: true });
    // Back to the normal, silent state: no announcement in the region, no install
    // offer, so later sections measure the app as a user first sees it.
    await evaluate(`(() => {
      window.dispatchEvent(new Event('online'));
      document.getElementById('app-status').textContent = '';
      document.getElementById('installer').classList.remove('available');
      document.querySelector('#installer button').disabled = true;
    })()`);
    await sleep(100);

    // 3a-pin. The dead declarations themselves are the regression (airhorn-xfkf).
    // .horn-label is display: none whenever main.css applies, so a font-family,
    // font-size, font-weight or line-height on that selector can never paint -
    // and it cannot be caught by measuring painted elements, because the element
    // it would paint on is hidden. One commit deleted exactly that block and a
    // later one could put it back with every assertion here still green, so pin
    // the source: the rule may hide the label and nothing else.
    const mainCss = fs.readFileSync(path.join(__dirname, '../public/styles/main.css'), 'utf8');
    const hornLabelBlock = /&\s*\.horn-label\s*\{([^}]*)\}/.exec(mainCss);
    if (!hornLabelBlock) {
      throw new Error('main.css has no `& .horn-label` rule any more; if the rule moved, move this pin with it');
    }
    const hornLabelDeclarations = hornLabelBlock[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((declaration) => declaration.trim())
      .filter(Boolean);
    const deadTypography = hornLabelDeclarations.filter((declaration) => /^(font|line-height)/i.test(declaration));
    if (deadTypography.length) {
      throw new Error(`main.css \`& .horn-label\` declares typography that can never paint (the rule is display: none): ${deadTypography.join(', ')}`);
    }
    if (!hornLabelDeclarations.some((declaration) => /^display:\s*none$/i.test(declaration))) {
      throw new Error(`main.css \`& .horn-label\` must stay display: none with the stylesheet active, got: ${hornLabelDeclarations.join('; ')}`);
    }
    console.log(`Dead .horn-label typography pinned at the source: main.css declares only ${hornLabelDeclarations.join('; ')}`);

    // 3b. Fallback heading tier: verify .horn-label where it ACTUALLY renders
    // (when main.css is blocked or failed, triggering .stylesheet-failed).
    await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['*styles/*.css'] });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });

    // Wait for the fallback heading to REACH THE SCREEN, not for 600 ms to pass:
    // the navigation, the blocked stylesheet's failure and the inline watchdog
    // that adds .stylesheet-failed are all queued behind other lanes on a loaded
    // box, and the old sleep read `null` for an element that had not been
    // created yet - a correct page reading as a broken one (airhorn-sesh).
    const readFallbackHeading = () => evaluate(`(() => {
      const el = document.querySelector('.horn-label');
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        display: cs.display,
        visibility: cs.visibility,
        rect: { width: r.width, height: r.height, top: r.top, left: r.left },
        isPainted: cs.display === 'block' && cs.visibility === 'visible' && r.width > 0 && r.height > 0,
      };
    })()`);

    const fallbackHeading = await waitFor(async () => {
      const heading = await readFallbackHeading();
      return heading && heading.isPainted ? heading : null;
    }, { label: 'the blocked-stylesheet fallback heading to paint' });

    if (!fallbackHeading.isPainted) {
      throw new Error(`Fallback heading (.horn-label) failed to paint under blocked stylesheet: ${JSON.stringify(fallbackHeading)}`);
    }
    if (fallbackHeading.fontFamily !== expectedSystemStack) {
      throw new Error(`Fallback heading font-family mismatch: ${fallbackHeading.fontFamily}`);
    }
    const headingSize = px(fallbackHeading.fontSize);
    if (headingSize !== 20) {
      throw new Error(`Fallback heading size expected 20px (1.25rem), got ${fallbackHeading.fontSize}`);
    }
    if (fallbackHeading.fontWeight !== '600') {
      throw new Error(`Fallback heading weight expected 600 (semibold), got ${fallbackHeading.fontWeight}`);
    }
    if (headingSize <= bodySize) {
      throw new Error(`Fallback heading (${headingSize}px) must be larger than body (${bodySize}px)`);
    }
    console.log(`Fallback heading tier verified: .horn-label painted (${headingSize}px / weight ${fallbackHeading.fontWeight} > body ${bodySize}px)`);

    await shot('7-typography-fallback-heading.png');

    // Clean up blocked URLs
    await send('Network.setBlockedURLs', { urls: [] });

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
