/*
 * tests/keyboard.test.mjs — can someone operate this with no pointer at all? (airhorn-bjk1)
 *
 * Every other suite drives the app with pointers, synthetic clicks or deep
 * links. This one walks it the way a keyboard-only user does: real CDP key
 * events (Input.dispatchKeyEvent), starting from an untouched page load, and it
 * asserts the two things that decide whether that journey is usable:
 *
 *   1. every focus stop is VISIBLE. Not "outline: none", not "an outline
 *      property is set": a painted indicator whose colour clears 3:1 against
 *      the background it is actually drawn on (WCAG 1.4.11), measured from the
 *      computed style, not from the stylesheet.
 *   2. nothing traps, loses or strands focus: a hold survives only while the
 *      key is held, Escape retires it, tabbing away retires it, a blast does not
 *      move focus, an offline flip does not move focus, and a control that
 *      retires itself restores focus to the horn.
 *
 * The keyboard surface this walks (all of it authors keyboard behaviour):
 *   index.html              the Tab order, the boot-failure banner and its
 *                           retry button (the watchdog focuses it itself)
 *   src/main.js             Space/Enter hold, Escape, blur/visibility retire,
 *                           the installer's focus restoration
 *   public/styles/main.css  the focus rings it asserts a 3:1 indicator for
 *
 * The last case is a real defect this journey found: on a cold load whose
 * bundle never runs, the watchdog moves focus to "Try again" - and a
 * programmatic focus on a page that has had no keyboard input does NOT match
 * :focus-visible, so the button was focused with no indicator at all.
 *
 * Run with: npm test (the fast gate builds dist/ first)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './support/browser.mjs';
import { installSignalExit } from './support/signal-exit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '../dist');

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startServer() {
  const server = http.createServer((req, res) => {
    let filePath = path.join(DIST, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Colour maths for the focus ring assertion. The ring is drawn OUTSIDE the
// element (outline-offset), so its background is the nearest opaque ancestor
// background, not the control's own fill - measuring navy-on-blue-700 would
// report ~2.6:1 for a ring that never touches blue-700.
function alphaOf(color) {
  const text = String(color).trim();
  const comma = /^rgba?\(([^)]*)\)$/i.exec(text);
  if (comma && comma[1].includes(',')) {
    const parts = comma[1].split(',').map((v) => parseFloat(v));
    return parts.length === 4 && Number.isFinite(parts[3]) ? parts[3] : 1;
  }
  const slash = /\(\s*[^)]*\/\s*([\d.]+)(%?)\s*\)$/.exec(text);
  if (slash) {
    const value = parseFloat(slash[1]);
    return slash[2] === '%' ? value / 100 : value;
  }
  return 1;
}

function relativeLuminance(color) {
  const channels = String(color).match(/[\d.]+/g);
  if (!channels) throw new Error(`cannot read an RGB colour from '${color}'`);
  const [r, g, b] = channels.slice(0, 3).map(Number).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function hasClass(stop, name) {
  return !!(stop && typeof stop.cls === 'string' && stop.cls.split(' ').includes(name));
}

function describeStop(stop) {
  if (!stop) return '<no focus>';
  if (stop.tag === 'BODY') return '<body> (focus left the document)';
  const name = stop.name ? ` "${stop.name}"` : '';
  return `<${stop.tag.toLowerCase()}${stop.id ? '#' + stop.id : ''}${stop.cls ? '.' + stop.cls.split(' ').join('.') : ''}>${name}`;
}

// The one focus-visibility assertion every stop in the journey goes through.
// `label` names the exact key sequence that produced the stop, because a
// keyboard failure without its keystrokes is not reproducible.
function assertFocusRing(stop, label) {
  assert(stop && stop.tag !== 'BODY', `${label}: focus is not on any control (document.activeElement is <body>)`);
  const where = `${label}: ${describeStop(stop)} at ${stop.rect.x.toFixed(0)},${stop.rect.y.toFixed(0)} (${stop.rect.w}x${stop.rect.h}px)`;
  assert(
    stop.visibility !== 'hidden' && stop.rect.w > 0 && stop.rect.h > 0,
    `${where} is focused but not visible (visibility: ${stop.visibility}) - an invisible stop is a lost keypress`
  );
  assert(
    stop.outlineStyle && stop.outlineStyle !== 'none' && stop.outlineStyle !== 'hidden',
    `${where} shows no focus indicator (outline-style: ${stop.outlineStyle})`
  );
  const width = parseFloat(stop.outlineWidth);
  assert(Number.isFinite(width) && width >= 2, `${where} focus ring is ${stop.outlineWidth} wide (need >= 2px to read as an indicator)`);
  assert(alphaOf(stop.outlineColor) > 0, `${where} focus ring colour ${stop.outlineColor} is fully transparent`);
  assert(stop.ringBehind, `${where} has no opaque background behind its focus ring; cannot prove the ring is visible`);
  const ratio = contrastRatio(stop.outlineColor, stop.ringBehind);
  assert(
    ratio >= 3,
    `${where} focus ring ${stop.outlineColor} on ${stop.ringBehind} (${stop.ringBehindOwner}) is ${ratio.toFixed(2)}:1, below the 3:1 indicator minimum`
  );
  return ratio;
}

/*
 * Instrumentation, installed before any page script runs.
 *
 *   __kb.starts        blast starts, split by voice: one buffer source per
 *                      sample blast, three oscillators per synth blast. Measuring
 *                      both is how "one key press = one blast" is decided - a
 *                      press that goes through both the app's keydown handler and
 *                      the button's native activation would count twice.
 *   __kb.ringOf(el)    the computed focus indicator of an element, plus the
 *                      background the ring is painted on.
 *   __kb.stops         every focus stop of the document, in order, so a case can
 *                      prove no stop was invisible even between assertions.
 *   __kb.realOffers    how many REAL beforeinstallprompt offers Chrome made. They
 *                      are swallowed (see __kb.stub): whether headless Chrome
 *                      considers the app installable is machine state, and a test
 *                      whose tab order depends on it fails for the wrong reason.
 *                      The real offer -> enabled button path is asserted by the
 *                      a11y suite; the offer this suite walks is explicit.
 */
const instrumentation = `
  window.__kb = { sources: 0, oscillators: 0, realOffers: 0, prompts: 0, stub: true, stops: [], errors: [] };
  const countStarts = (proto, key) => {
    if (!proto) return;
    const original = proto.start;
    proto.start = function (...args) { window.__kb[key] += 1; return original.apply(this, args); };
  };
  countStarts(window.AudioBufferSourceNode && AudioBufferSourceNode.prototype, 'sources');
  countStarts(window.OscillatorNode && OscillatorNode.prototype, 'oscillators');
  addEventListener('beforeinstallprompt', (event) => {
    if (event.__stub) return;
    window.__kb.realOffers += 1;
    // Installed before the page's own listener, so a real offer never reaches
    // the app while the suite is driving a deterministic offer of its own.
    if (window.__kb.stub) event.stopImmediatePropagation();
  }, true);
  window.addEventListener('error', (e) => window.__kb.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => window.__kb.errors.push(String(e.reason && e.reason.message || e.reason)));

  window.__kbRing = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!el.tagName || el === document.body || el === document.documentElement) {
      return { tag: 'BODY', rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, outlineStyle: cs.outlineStyle };
    }
    // The ring lives outside the element's border box, so the colour it is
    // actually drawn on is the first opaque ANCESTOR background.
    let ringBehind = null;
    let ringBehindOwner = null;
    let node = el.parentElement;
    while (node) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        ringBehind = bg;
        ringBehindOwner = node.tagName.toLowerCase() + (node.id ? '#' + node.id : '');
        break;
      }
      node = node.parentElement;
    }
    return {
      tag: el.tagName,
      id: el.id,
      cls: typeof el.className === 'string' ? el.className : '',
      name: el.getAttribute('aria-label') || (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
      focusVisible: el.matches(':focus-visible'),
      visibility: cs.visibility,
      outlineStyle: cs.outlineStyle,
      outlineWidth: cs.outlineWidth,
      outlineColor: cs.outlineColor,
      outlineOffset: cs.outlineOffset,
      ringBehind,
      ringBehindOwner,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      disabled: !!el.disabled,
    };
  };
  window.__kbFocus = () => window.__kbRing(document.activeElement);
  document.addEventListener('focusin', (e) => {
    const stop = window.__kbRing(e.target);
    if (stop) window.__kb.stops.push({ ...stop, trail: window.__kb.stops.length });
  }, true);
`;

const openBrowsers = new Set();
installSignalExit(() => {
  for (const browser of openBrowsers) browser.browser.killNow();
});

async function launch({ label = 'keyboard' } = {}) {
  const browser = await launchBrowser({ label, timeoutMs: 15000 });

  const ws = new WebSocket(browser.pageWsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let id = 1;
  const pending = new Map();
  const consoleErrors = [];
  let navigations = 0;
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Page.frameNavigated') navigations += 1;
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      consoleErrors.push(details?.exception?.description || details?.text || 'uncaught exception');
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const messageId = id++;
    pending.set(messageId, { resolve, reject });
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error('page evaluation failed: ' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
    }
    return result.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  // A headless page is not a focused document, and :focus / :focus-visible only
  // match in one: without this, every focus-ring assertion here measures the
  // headless artefact "no ring" instead of the style (measured both ways -
  // #boot-retry's ring appears with emulation on and vanishes with it off, in
  // the same document). A real tab is focused, so emulate that.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const snapshot = () => evaluate(`(() => {
    const horn = document.querySelector('.horn');
    const status = document.getElementById('app-status');
    const install = document.querySelector('#installer button');
    const banner = document.getElementById('boot-failure');
    return {
      booted: !!window.__airhorn,
      horning: !!horn && horn.classList.contains('horning'),
      pressed: horn ? horn.getAttribute('aria-pressed') : null,
      active: window.__kbFocus(),
      sources: window.__kb.sources,
      oscillators: window.__kb.oscillators,
      status: status ? status.textContent : null,
      install: install ? {
        disabled: install.disabled,
        available: document.getElementById('installer').classList.contains('available'),
      } : null,
      banner: banner ? { hidden: banner.hidden } : null,
      realOffers: window.__kb.realOffers,
      prompts: window.__kb.prompts,
      stops: window.__kb.stops.length,
      errors: window.__kb.errors.slice(),
    };
  })()`);

  const waitFor = async (predicate, { timeout = 6000, interval = 50, label = 'condition' } = {}) => {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      last = await snapshot();
      if (predicate(last)) return last;
      await sleep(interval);
    }
    throw new Error(`${label} was not reached within ${timeout}ms; last observed: ${JSON.stringify(last)}`);
  };

  const KEYS = {
    Tab: { code: 'Tab', vk: 9 },
    Space: { code: 'Space', vk: 32, text: ' ' },
    Enter: { code: 'Enter', vk: 13, text: '\r' },
    Escape: { code: 'Escape', vk: 27 },
  };
  const key = (type, name, extra = {}) => send('Input.dispatchKeyEvent', {
    type,
    key: name === 'Space' ? ' ' : name,
    code: KEYS[name].code,
    windowsVirtualKeyCode: KEYS[name].vk,
    nativeVirtualKeyCode: KEYS[name].vk,
    ...extra,
  });
  // A real press is a `keyDown` carrying the key's text - that is what makes
  // Enter/Space activate a button natively (a rawKeyDown never does). An
  // auto-repeat is a rawKeyDown with autoRepeat: it carries repeat=true and no
  // text, exactly like the tail of a physically held key.
  const hold = (name, { repeat = false } = {}) => (repeat
    ? key('rawKeyDown', name, { autoRepeat: true })
    : key('keyDown', name, KEYS[name].text ? { text: KEYS[name].text } : {}));
  const release = (name) => key('keyUp', name);
  const tab = async ({ shift = false } = {}) => {
    const modifiers = shift ? 8 : 0;
    await send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Tab', code: 'Tab',
      windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers,
    });
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Tab', code: 'Tab',
      windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers,
    });
    await sleep(120);
    return evaluate('window.__kbFocus()');
  };
  const focus = async (selector) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await sleep(80);
    return evaluate('window.__kbFocus()');
  };
  // main.css is fetched non-render-blocking (index.html swaps its media on load),
  // so a ring assertion can run against an unstyled frame: it measured a 1px UA
  // outline on a 71x21 unstyled Try-again button in a fast-gate run on a loaded
  // box. Wait for the sheet itself, using a property that is NOT the thing under
  // test (the card's radius; the critical inline block styles .horn, not
  // .boot-alert), so the wait cannot mask a missing focus ring.
  const stylesheetApplied = () => evaluate(`(() => {
    const card = document.querySelector('.boot-alert');
    return !!card && getComputedStyle(card).borderTopLeftRadius !== '0px';
  })()`);
  const setOffline = (offline) => send('Network.emulateNetworkConditions', {
    offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  const offerInstall = ({ outcome = 'dismissed' } = {}) => evaluate(`(() => {
    // A stand-in offer the app cannot tell apart: __stub marks it so the
    // instrumentation lets it through, and prompt()/userChoice are the parts a
    // headless browser cannot provide.
    window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), {
      __stub: true,
      prompt() { window.__kb.prompts += 1; },
      userChoice: Promise.resolve({ outcome: ${JSON.stringify(outcome)} }),
    }));
    const button = document.querySelector('#installer button');
    return { disabled: button.disabled, available: document.getElementById('installer').classList.contains('available') };
  })()`);

  const handle = { browser, get navigations() { return navigations; }, get consoleErrors() { return consoleErrors; } };
  openBrowsers.add(handle);
  const close = async () => {
    openBrowsers.delete(handle);
    try { ws.close(); } catch {}
    await browser.close();
  };

  return { send, evaluate, snapshot, waitFor, hold, release, tab, key, focus, setOffline, offerInstall, stylesheetApplied, sleep, close, handle };
}

// A blast must not double-fire: a hold is one start on the sample voice, or
// three (one per oscillator) on the synth fallback, and the release starts
// nothing. Returns the number of voices that started so a failure can name it.
function blastStarts(before, after) {
  const sources = after.sources - before.sources;
  const oscillators = after.oscillators - before.oscillators;
  return { sources, oscillators, total: sources + oscillators };
}

async function run() {
  if (!fs.existsSync(DIST)) throw new Error('dist directory does not exist. Run build first.');
  const server = await startServer();
  const port = server.address().port;
  let app = null;
  try {
    app = await launch();
    const { send, evaluate, snapshot, waitFor, hold, release, tab, key, focus, setOffline, offerInstall, stylesheetApplied, sleep } = app;
    const base = `http://127.0.0.1:${port}/`;

    await send('Page.navigate', { url: base });
    await waitFor((s) => s.booted, { label: 'the app to boot (window.__airhorn)', timeout: 15000 });
    await waitFor(() => stylesheetApplied(), { label: 'the stylesheet to be applied', timeout: 15000 });
    await sleep(300);

    // ---------------------------------------------------------------- case 1
    console.log('--- 1. Tab from a cold load: the horn is the first stop, and it is visible ---');
    const stopped = await snapshot();
    assert(
      stopped.stops === 0,
      `Tab → horn (cold load): the page focused something before the first Tab (${stopped.stops} focus stop(s)) - a keyboard user starts with no idea where they are`
    );
    const first = await tab();
    assert(stopped.active && stopped.active.tag === 'BODY', `cold load: expected focus to start on <body>, got ${describeStop(stopped.active)}`);
    assert(hasClass(first, 'horn'), `Tab → horn (cold load): first Tab stop is ${describeStop(first)}, not the horn`);
    const firstRatio = assertFocusRing(first, 'Tab → horn (cold load)');
    console.log(`  horn is the first tab stop; ring ${first.outlineColor} on ${first.ringBehind} = ${firstRatio.toFixed(2)}:1`);

    // ---------------------------------------------------------------- case 2
    console.log('--- 2. the whole tab order, forwards and backwards, with no invisible stop ---');
    const offer = await offerInstall({ outcome: 'dismissed' });
    assert(offer.available && !offer.disabled, `Tab order: the install offer did not become available (${JSON.stringify(offer)})`);
    const fromHorn = await focus('.horn');
    assert(hasClass(fromHorn, 'horn'), 'Tab order: could not focus the horn to start the walk');
    const second = await tab();
    assert(hasClass(second, 'button'), `Tab → install offer: expected the install button, got ${describeStop(second)}`);
    assertFocusRing(second, 'Tab → install offer');
    const third = await tab();
    assert(third.tag === 'BODY', `Tab → past the last control: expected focus to leave the document, got ${describeStop(third)} - a stop after the last control usually means a hidden control is in the tab order`);
    const back1 = await tab({ shift: true });
    assert(hasClass(back1, 'button'), `Shift+Tab → install offer: expected the install button, got ${describeStop(back1)}`);
    assertFocusRing(back1, 'Shift+Tab → install offer');
    const back2 = await tab({ shift: true });
    assert(hasClass(back2, 'horn'), `Shift+Tab → horn: expected the horn, got ${describeStop(back2)}`);
    assertFocusRing(back2, 'Shift+Tab → horn');
    console.log(`  order: horn -> install -> out of the document; backwards it reverses`);

    // ---------------------------------------------------------------- case 3
    console.log('--- 3. Space holds the horn: one blast while held, silence on release ---');
    await focus('.horn');
    const beforeSpace = await snapshot();
    await hold('Space');
    // aria-pressed flips optimistically, so wait for the voice itself: the count
    // of starts is what "it sounded" means here.
    const duringSpace = await waitFor((s) => s.horning && s.sources + s.oscillators > beforeSpace.sources + beforeSpace.oscillators, {
      label: 'Space keydown to start a voice',
      timeout: 3000,
    });
    assert(duringSpace.pressed === 'true', `hold Space: aria-pressed is ${duringSpace.pressed} while the horn sounds`);
    const spaceBlast = blastStarts(beforeSpace, duringSpace);
    assert(
      spaceBlast.total === 1 || spaceBlast.total === 3,
      `hold Space: one keydown started ${spaceBlast.total} voice(s) (${spaceBlast.sources} sample + ${spaceBlast.oscillators} synth) - expected one blast`
    );
    assertFocusRing(duringSpace.active, 'hold Space (while sounding)');
    await release('Space');
    const afterSpace = await waitFor((s) => !s.horning, { label: 'Space keyup to stop the horn', timeout: 3000 });
    assert(afterSpace.pressed === 'false', `release Space: aria-pressed stayed ${afterSpace.pressed}`);
    await sleep(250);
    const settledSpace = await snapshot();
    const spaceTail = blastStarts(duringSpace, settledSpace);
    assert(
      spaceTail.total === 0,
      `release Space: the keyup started another ${spaceTail.total} voice(s) - the press fired twice (app handler plus native button activation)`
    );
    assertFocusRing(settledSpace.active, 'after a Space blast');
    console.log(`  ${spaceBlast.sources ? 'sample' : 'synth'} voice: ${spaceBlast.total} start(s) on keydown, 0 on keyup; focus and ring kept`);

    // ---------------------------------------------------------------- case 4
    console.log('--- 4. Enter holds the horn the same way ---');
    const beforeEnter = await snapshot();
    await hold('Enter');
    const duringEnter = await waitFor((s) => s.horning && s.sources + s.oscillators > beforeEnter.sources + beforeEnter.oscillators, {
      label: 'Enter keydown to start a voice',
      timeout: 3000,
    });
    const enterBlast = blastStarts(beforeEnter, duringEnter);
    assert(
      enterBlast.total === 1 || enterBlast.total === 3,
      `hold Enter: one keydown started ${enterBlast.total} voice(s) - expected one blast`
    );
    assertFocusRing(duringEnter.active, 'hold Enter (while sounding)');
    await release('Enter');
    const afterEnter = await waitFor((s) => !s.horning, { label: 'Enter keyup to stop the horn', timeout: 3000 });
    await sleep(200);
    const settledEnter = await snapshot();
    assert(blastStarts(afterEnter, settledEnter).total === 0, 'release Enter: the keyup started another blast');
    assertFocusRing(settledEnter.active, 'after an Enter blast');
    console.log('  Enter holds and releases identically');

    // ---------------------------------------------------------------- case 5
    console.log('--- 5. Escape retires a hold, and the key repeat tail cannot restart it ---');
    await focus('.horn');
    await hold('Space');
    await waitFor((s) => s.horning, { label: 'Space keydown (before Escape)', timeout: 3000 });
    await key('keyDown', 'Escape');
    await key('keyUp', 'Escape');
    const escaped = await waitFor((s) => !s.horning, { label: 'Escape to retire the hold', timeout: 3000 });
    assert(escaped.pressed === 'false', `Escape: aria-pressed stayed ${escaped.pressed}`);
    // The key is still physically down: the browser keeps sending auto-repeats.
    await hold('Space', { repeat: true });
    await sleep(250);
    const tail = await snapshot();
    assert(!tail.horning, 'Escape then a Space auto-repeat: the horn came back - the cancelled hold\'s repeat tail restarted it');
    await release('Space');
    await sleep(120);
    // A genuine new press (repeat=false) after the release must still work.
    await hold('Space');
    const fresh = await waitFor((s) => s.horning, { label: 'a fresh Space press after Escape', timeout: 3000 });
    assert(fresh.horning, 'a fresh Space press after Escape did not sound the horn');
    await release('Space');
    await waitFor((s) => !s.horning, { label: 'release after the fresh press', timeout: 3000 });
    assertFocusRing((await snapshot()).active, 'after Escape and a re-press');
    console.log('  Escape stops it; repeats stay quiet; a new press still works');

    // ---------------------------------------------------------------- case 6
    console.log('--- 6. tabbing away mid-hold retires the hold (no stuck horn, no lost focus) ---');
    await focus('.horn');
    await hold('Space');
    await waitFor((s) => s.horning, { label: 'Space keydown before tabbing away', timeout: 3000 });
    const away = await tab();
    assert(hasClass(away, 'button'), `Tab away mid-hold: expected the next control (install), got ${describeStop(away)}`);
    await sleep(150);
    const afterAway = await snapshot();
    assert(!afterAway.horning, 'Tab away mid-hold: the horn kept sounding after focus left it');
    assert(afterAway.pressed === 'false', `Tab away mid-hold: aria-pressed is ${afterAway.pressed}`);
    assertFocusRing(afterAway.active, 'Tab away mid-hold → install offer');
    // The keyup can arrive after the hold was retired: it must not resurrect it.
    await release('Space');
    await sleep(250);
    assert(!(await snapshot()).horning, 'the keyup that arrived after tabbing away restarted the horn');
    console.log('  blur retires the hold; the late keyup is harmless');

    // ---------------------------------------------------------------- case 7
    console.log('--- 7. the install offer is operable with the keyboard and restores focus ---');
    const offer7 = await offerInstall({ outcome: 'dismissed' });
    assert(offer7.available && !offer7.disabled, `install offer: not available for the keyboard case (${JSON.stringify(offer7)})`);
    await focus('.horn');
    const installStop = await tab();
    assert(installStop.tag === 'BUTTON' && hasClass(installStop, 'button'), `Tab → install (keyboard): expected the install button, got ${describeStop(installStop)}`);
    assertFocusRing(installStop, 'Tab → install button');
    const beforePrompt = await snapshot();
    await hold('Enter');
    await release('Enter');
    const chosen = await waitFor((s) => s.status === 'Installation cancelled', {
      label: 'Enter on the install button to prompt and announce the outcome',
      timeout: 3000,
    });
    assert(
      chosen.prompts === beforePrompt.prompts + 1,
      `Enter on the install button called prompt() ${chosen.prompts - beforePrompt.prompts} time(s), expected once`
    );
    assert(chosen.install && chosen.install.disabled, 'install offer: the button stayed enabled after the choice');
    assert(hasClass(chosen.active, 'horn'), `install retired: focus went to ${describeStop(chosen.active)} instead of the horn`);
    const restoredRatio = assertFocusRing(chosen.active, 'install retired → focus restored to the horn');
    console.log(`  Enter prompted once, announced "${chosen.status}", focus restored with a ${restoredRatio.toFixed(2)}:1 ring`);

    // ---------------------------------------------------------------- case 8
    console.log('--- 8. an offline flip keeps focus and does not take the keyboard away ---');
    await focus('.horn');
    await setOffline(true);
    const offline = await waitFor((s) => /No connection/.test(s.status || ''), { label: 'the offline announcement', timeout: 4000 });
    assert(hasClass(offline.active, 'horn'), `offline flip: focus moved to ${describeStop(offline.active)}`);
    assertFocusRing(offline.active, 'offline flip (focus kept on the horn)');
    await setOffline(false);
    const online = await waitFor((s) => s.status === 'Back online.', { label: 'the back-online announcement', timeout: 4000 });
    assert(hasClass(online.active, 'horn'), `back online: focus moved to ${describeStop(online.active)}`);
    await hold('Space');
    const afterFlip = await waitFor((s) => s.horning, { label: 'a keyboard blast after the connection flips', timeout: 3000 });
    await release('Space');
    await waitFor((s) => !s.horning, { label: 'release after the connection flip', timeout: 3000 });
    assertFocusRing((await snapshot()).active, 'after a blast following the offline flip');
    console.log('  announced, not moved: focus stayed on the horn through offline, online and a blast');

    // ---------------------------------------------------------------- case 9
    console.log('--- 9. no trap: tabbing on from the horn always returns to a real control ---');
    await focus('.horn');
    const cycle = [];
    for (let i = 0; i < 4; i++) {
      const stop = await tab();
      cycle.push(stop);
      if (stop.tag !== 'BODY') assertFocusRing(stop, `Tab x${i + 1} from the horn (trap check)`);
    }
    assert(
      cycle.some((stop) => hasClass(stop, 'horn')),
      `trap check: four Tabs from the horn never came back to it (${cycle.map(describeStop).join(' -> ')})`
    );
    console.log(`  four Tabs: ${cycle.map((s) => (s.tag === 'BODY' ? 'out of document' : s.cls || s.tag)).join(' -> ')}`);

    // Every focus stop of the whole journey, not just the sampled ones.
    const trail = await evaluate('window.__kb.stops');
    const badStops = trail.filter((stop) => stop.tag !== 'BODY' && stop.outlineStyle === 'none');
    assert(
      badStops.length === 0,
      `the journey recorded ${badStops.length} focus stop(s) with no indicator: ${badStops.map(describeStop).join(', ')}`
    );
    const pageErrors = (await snapshot()).errors;
    assert(pageErrors.length === 0, `page errors during the keyboard journey: ${JSON.stringify(pageErrors)}`);
    assert(app.handle.consoleErrors.length === 0, `console errors during the keyboard journey: ${JSON.stringify(app.handle.consoleErrors)}`);

    // --------------------------------------------------------------- case 10
    console.log('--- 10. a dead bundle: the banner, and focus that can be SEEN (airhorn-bjk1 defect) ---');
    // Block the module: the page paints a complete horn but the app never boots,
    // so the inline watchdog reveals #boot-failure and focuses "Try again".
    // The app's own worker precaches the shell, so a plain reload would serve the
    // previous build from cache - including the stylesheet this case is about.
    // Unregister and drop the caches so the reload is an ordinary network load.
    await evaluate(`(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    })()`);
    await send('Network.setBlockedURLs', { urls: ['*/assets/*.js', '*/src/main.js'] });
    const navigationsBefore = app.handle.navigations;
    await send('Page.reload');
    const banner = await waitFor((s) => s.banner && s.banner.hidden === false, {
      label: 'the boot-failure banner (module blocked)',
      timeout: 20000,
    });
    assert(banner.active && banner.active.id === 'boot-retry', `boot failure: focus is on ${describeStop(banner.active)}, not the Try again button`);
    await waitFor(() => stylesheetApplied(), { label: 'the stylesheet on the boot-failure page', timeout: 15000 });
    const retryRatio = assertFocusRing(banner.active, 'boot failure → watchdog focuses Try again (programmatic focus, no prior keyboard input)');
    // Tabbing off Try again must not strand the keyboard: the banner page still
    // has the horn behind it, and whatever Tab reaches must be a visible stop.
    const retryTab = await tab();
    if (retryTab.tag !== 'BODY') assertFocusRing(retryTab, 'Tab from Try again (the banner page keeps tabbing)');
    // Focus order on this page is horn -> Try again (the install control never
    // became available), so Tab from the horn is the way back.
    const backToRetry = await tab();
    assert(backToRetry.id === 'boot-retry', `boot failure: Tab from the horn reached ${describeStop(backToRetry)}, not Try again`);
    await hold('Enter');
    await release('Enter');
    const reloaded = await (async () => {
      for (let i = 0; i < 60; i++) {
        if (app.handle.navigations > navigationsBefore) return true;
        await sleep(100);
      }
      return false;
    })();
    assert(reloaded, 'boot failure: Enter on Try again did not reload the page');
    console.log(`  banner shown, visible ${retryRatio.toFixed(2)}:1 ring on Try again, Enter reloads`);

    // --------------------------------------------------------------- case 11
    console.log('--- 11. the late bundle retires the notice without dropping focus on the floor ---');
    const bannerAgain = await waitFor((s) => s.banner && s.banner.hidden === false, {
      label: 'the boot-failure banner after the retry reload',
      timeout: 20000,
    });
    assert(bannerAgain.active && bannerAgain.active.id === 'boot-retry', `retry reload: focus is on ${describeStop(bannerAgain.active)}, not Try again`);
    // Stand in for the bundle that arrives after the watchdog gave up (the 12s
    // backstop path): that is exactly what src/main.js calls once the app is
    // usable, and calling it is the same as the late bundle doing so - the
    // alternative would be a 14s hang in the fast gate.
    await evaluate('window.__airhornBooted()');
    await sleep(150);
    const retired = await snapshot();
    assert(retired.banner.hidden, 'late bundle: the notice stayed on screen after the app became usable');
    assert(
      retired.active && retired.active.tag !== 'BODY',
      'late bundle retires the notice: focus fell to <body> - a keyboard user waiting on Try again lost their place (next Tab restarts from the top of the document)'
    );
    assert(hasClass(retired.active, 'horn'), `late bundle retires the notice: focus went to ${describeStop(retired.active)}, not the horn that now works`);
    const retiredRatio = assertFocusRing(retired.active, 'late bundle retires the notice → focus handed to the horn');
    console.log(`  notice retired, focus handed to the horn with a ${retiredRatio.toFixed(2)}:1 ring`);

    console.log('ALL KEYBOARD JOURNEY CHECKS PASSED');
  } finally {
    if (app) await app.close();
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
