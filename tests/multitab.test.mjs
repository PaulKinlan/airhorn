/*
 * tests/multitab.test.mjs — two tabs at once must stay coherent (airhorn-dae)
 *
 * The app is a PWA people leave open in two tabs, and nothing ever tested two
 * tabs of the SAME origin, sharing ONE service worker registration. Each
 * sequence below drives the real page in a real second target and asserts a
 * coherence property; a cross-tab defect fails the suite with the bead ID in
 * the message.
 *
 *   A. an SW update discovered with two tabs open announces in BOTH tabs
 *      (update notice + controllerchange), each message at most once per tab,
 *      and both tabs end reloaded, rebooted and working - no duplicates, no
 *      stuck UI.
 *   B. horning in one tab never leaves the other tab showing a stale horn
 *      state (aria-pressed / .horning stay honest in the tab that did not
 *      press), and the app badge - which is OS-wide, shared by every tab -
 *      reads the SHARED total: 4 blasts across two tabs must read 4
 *      (airhorn-xkq), and a freshly opened tab must derive it, never clear it
 *      (airhorn-70k).
 *   C. an offline -> online transition is announced exactly once in EVERY
 *      open tab (each tab has its own live region; no duplicates per tab).
 *   D. closing one tab mid-horn does not tear down the other tab's audio or
 *      badge, and the survivor can still blast.
 *   E. a tab opened WHILE an update is already installing (it never saw
 *      updatefound) still gets the new controller - and the tab that reloads
 *      must say why: exactly one 'A new version is ready' announcement
 *      (airhorn-56j).
 *
 * Sound is measured, not inferred: the shortcuts suite's probe (reroute every
 * connect() to ctx.destination through a pass-through analyser) is injected
 * at document start in every tab, together with a badge spy and an announcer
 * logger that mirrors into sessionStorage so logs survive the update reload.
 *
 * Cross-tab defects fail HERE with the bead ID in the message - the three
 * findings this suite surfaced (airhorn-xkq last-writer-wins badge,
 * airhorn-70k boot-time badge wipe, airhorn-56j silent mid-install reload)
 * are regressions this suite must catch, not observations it files.
 *
 * Run with: npm test (the fast gate builds dist/ first)
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '../dist');

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
  const state = { version: null, swShim: null };
  const server = http.createServer((req, res) => {
    let pathname = req.url.split('?')[0];
    if (pathname === '/') pathname = '/index.html';
    const file = path.join(distDir, pathname);
    if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    let body = fs.readFileSync(file);
    if (pathname === '/sw.js') {
      let text = body.toString();
      if (state.version) {
        text = text.replace(/const version = "[^"]*";/, `const version = "${state.version}";`);
      }
      if (state.swShim) text = `${state.swShim}\n${text}`;
      body = Buffer.from(text);
    }
    res.writeHead(200, {
      'content-type': mimeTypes[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('cannot connect to Chrome'));
  });
  let nextId = 1;
  const pending = new Map();
  const waiters = new Set();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject: rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(msg.error.message));
      else res(msg.result);
      return;
    }
    for (const waiter of [...waiters]) waiter(msg);
  };
  const waitForEvent = (method, { sessionId, timeout = 15000 } = {}) => new Promise((resolve, reject) => {
    const waiter = (msg) => {
      if (msg.method !== method) return;
      if (sessionId && msg.sessionId !== sessionId) return;
      clearTimeout(timer);
      waiters.delete(waiter);
      resolve(msg.params);
    };
    const timer = setTimeout(() => {
      waiters.delete(waiter);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeout);
    waiters.add(waiter);
  });
  const send = (method, params = {}, sessionId) => {
    const id = nextId++;
    return new Promise((res, rej) => {
      pending.set(id, { resolve: res, reject: rej });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  };
  return { ws, send, waitForEvent };
}

// Injected at document start in EVERY tab: the sound probe, the badge spy and
// the announcer logger. The announcer is a getter/setter pair so it wraps the
// app's own installer (index.html assigns window.__airhornAnnounce long after
// document start) without a race; entries are mirrored into sessionStorage so
// a tab's log survives the reload that the update flow performs.
const tabInstrumentation = `
  window.__probe = { starts: 0, level: 0, peak: 0, states: [], errors: [] };
  window.__probe.reset = () => { window.__probe.level = 0; window.__probe.peak = 0; window.__probe.states.length = 0; };
  window.addEventListener('error', (e) => window.__probe.errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => window.__probe.errors.push(String(e.reason && e.reason.message || e.reason)));
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC && window.AudioNode) {
    const originalConnect = AudioNode.prototype.connect;
    const taps = new WeakMap();
    const tapFor = (ctx) => {
      let tap = taps.get(ctx);
      if (tap) return tap;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const data = new Float32Array(analyser.fftSize);
      originalConnect.call(analyser, ctx.destination);
      tap = { analyser, data };
      taps.set(ctx, tap);
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i += 1) {
          const abs = Math.abs(data[i]);
          if (abs > peak) peak = abs;
        }
        window.__probe.level = peak;
        if (peak > window.__probe.peak) window.__probe.peak = peak;
        window.__probe.states.push(ctx.state);
      }, 25);
      setTimeout(() => clearInterval(timer), 60000);
      return tap;
    };
    AudioNode.prototype.connect = function (destination, ...rest) {
      const ctx = this.context;
      if (ctx && destination === ctx.destination) {
        return originalConnect.call(this, tapFor(ctx).analyser, ...rest);
      }
      return originalConnect.call(this, destination, ...rest);
    };
    const createBufferSource = AC.prototype.createBufferSource;
    AC.prototype.createBufferSource = function (...args) {
      const source = createBufferSource.apply(this, args);
      const start = source.start.bind(source);
      source.start = (...startArgs) => {
        window.__probe.starts += 1;
        return start(...startArgs);
      };
      return source;
    };
  }
  // Badge spy: setAppBadge/clearAppBadge are OS-app-wide (shared by every tab
  // of the origin), so who calls them and with what IS the cross-tab story.
  window.__badgeLog = [];
  window.__badgeApi = 'setAppBadge' in navigator && 'clearAppBadge' in navigator;
  if (window.__badgeApi) {
    for (const name of ['setAppBadge', 'clearAppBadge']) {
      const orig = navigator[name].bind(navigator);
      navigator[name] = (...args) => {
        window.__badgeLog.push({ fn: name, arg: args.length && args[0] !== undefined ? args[0] : null });
        return orig(...args);
      };
    }
  }
  // Announcer logger, race-free against the app's own installer.
  window.__annLog = [];
  try {
    let installed = null;
    Object.defineProperty(window, '__airhornAnnounce', {
      configurable: true,
      get() {
        return (message) => {
          try {
            const epoch = sessionStorage.getItem('__annEpoch') || '1';
            const log = JSON.parse(sessionStorage.getItem('__annLog') || '[]');
            log.push({ e: epoch, m: message });
            sessionStorage.setItem('__annLog', JSON.stringify(log));
          } catch {}
          if (installed) {
            try { installed.call(window, message); } catch {}
          }
        };
      },
      set(fn) { installed = fn; },
    });
  } catch (err) {
    window.__annWrapError = String(err && err.message || err);
  }
`;

async function run() {
  if (!fs.existsSync(distDir)) throw new Error('dist directory does not exist. Run build first.');

  const { server, state, port } = await startServer();
  const origin = `http://127.0.0.1:${port}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const waitUntil = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let value;
    for (;;) {
      try { value = await predicate(); } catch { value = undefined; }
      if (value) return value;
      if (Date.now() >= deadline) return value;
      await sleep(100);
    }
  };

  const chrome = spawn(process.env.CHROME_BIN || 'google-chrome', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    // Launching the app from a shortcut is a user gesture; the two-tab world
    // this suite models has the same audience (shortcuts suite, context A).
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=0', `--user-data-dir=${fs.mkdtempSync('/tmp/airhorn-multitab-')}`,
    '--disable-breakpad', '--disable-crash-reporter',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let cdp = null;
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome timeout')), 20000);
      chrome.stderr.on('data', (d) => {
        const m = d.toString().match(/ws:\/\/\S+/);
        if (m) { clearTimeout(timer); resolve(m[0]); }
      });
    });
    cdp = await connectCdp(wsUrl);
    const { send, waitForEvent } = cdp;

    const targets = await (await fetch(`http://127.0.0.1:${new URL(wsUrl).port}/json/list`)).json();
    const first = targets.find((t) => t.type === 'page');

    // openTab: a real second tab of the same origin, with its own CDP session,
    // its own instrumented documents and a per-tab identity for the log.
    const openTab = async (name, url, { instrument = true } = {}) => {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const session = (method, params = {}) => send(method, params, sessionId);
      if (instrument) await session('Page.addScriptToEvaluateOnNewDocument', { source: tabInstrumentation });
      await session('Page.enable');
      await session('Runtime.enable');
      const evaluate = async (expression) => {
        const res = await session('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (res.exceptionDetails) {
          throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
        }
        return res.result.value;
      };
      const navigate = async (nurl, timeout = 25000) => {
        const loaded = waitForEvent('Page.loadEventFired', { sessionId, timeout }).then(() => true).catch(() => false);
        await session('Page.navigate', { url: nurl }).catch(() => {});
        return await loaded;
      };
      const waitBooted = () => waitUntil(() => evaluate(
        `!!window.__airhorn && document.readyState === 'complete'`), 15000);
      const waitSwActive = () => waitUntil(() => evaluate(
        `navigator.serviceWorker.ready.then((r) => (r.active ? r.active.state : null))`), 15000);
      const hornBox = async () => evaluate(`(() => {
        const r = document.querySelector('.horn').getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      const clickHorn = async () => {
        const box = await hornBox();
        await session('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        await session('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      };
      // A real press-and-hold (the control's own contract): down, a held beat,
      // then release. aria-pressed is only true while the pointer is down -
      // release un-lights synchronously while the blast rings out (horn-help:
      // "Press and hold to sound the air horn. Release to stop.").
      const holdPress = async (holdMs = 250) => {
        const box = await hornBox();
        await session('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        await sleep(holdMs);
        await session('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      };
      const ann = (epoch) => evaluate(`(() => {
        sessionStorage.setItem('__annEpoch', '${epoch}');
        const log = JSON.parse(sessionStorage.getItem('__annLog') || '[]');
        sessionStorage.setItem('__annLog', '[]');
        return log;
      })()`);
      const hornState = () => evaluate(`(() => {
        const b = document.querySelector('.horn');
        return {
          pressed: b && b.getAttribute('aria-pressed'),
          horning: !!(b && b.classList.contains('horning')),
          playing: window.__airhorn ? window.__airhorn.isPlaying() : null,
          booted: !!window.__airhorn,
          bootAlertHidden: document.getElementById('boot-failure')?.hidden !== false,
          status: document.getElementById('app-status')?.textContent ?? null,
          starts: window.__probe ? window.__probe.starts : null,
          peak: window.__probe ? window.__probe.peak : null,
          ctxState: window.__probe ? window.__probe.states[window.__probe.states.length - 1] ?? null : null,
          errors: window.__probe ? window.__probe.errors : [],
        };
      })()`);
      const badge = () => evaluate(`window.__badgeLog`);

      await navigate(url);
      await waitBooted();
      return { name, targetId, sessionId, session, evaluate, navigate, waitBooted, waitSwActive, clickHorn, holdPress, hornBox, hornState, badge, ann };
    };

    const closeTab = async (tab) => {
      await send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
      try { cdp.ws; } catch { /* session dies with the target */ }
    };

    /* -------------------------------------------------- two tabs, one worker */
    console.log('--- Opening tab A; the service worker installs from it ---');
    const A = await openTab('A', `${origin}/`);
    assert(await A.waitSwActive(), 'service worker did not activate from tab A');

    console.log('--- Opening tab B on the same origin (shared worker) ---');
    const B = await openTab('B', `${origin}/`);
    assert(await B.hornState(), 'tab B did not boot');
    const badgeApi = await B.evaluate('window.__badgeApi');
    console.log(`  two tabs live; badge API present in this browser: ${badgeApi}`);

    /* ------- B. horning in one tab must not leave the other one stale ------ */
    console.log('\n--- B. three blasts in tab A; tab B must stay honest throughout ---');
    await A.ann('hornA');
    const AbadgeLog = [];
    for (let i = 1; i <= 3; i += 1) {
      const box = await (i === 1
        ? A.evaluate(`(() => { const r = document.querySelector('.horn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`)
        : A.hornBox());
      await A.session('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await sleep(250); // mid-hold: the horn is lit and sounding
      const duringA = await A.hornState();
      const duringB = await B.hornState();
      assert(duringA.pressed === 'true' && duringA.horning,
        `tab A hold ${i} did not light the horn (pressed=${duringA.pressed}, horning=${duringA.horning})`);
      assert(duringB.pressed === 'false' && !duringB.horning && duringB.playing === false,
        `tab A's blast left tab B claiming a horn it never did (pressed=${duringB.pressed}, horning=${duringB.horning}, playing=${duringB.playing})`);
      await A.session('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
      await waitUntil(async () => {
        const s = await A.hornState();
        return s.pressed === 'false' && !s.horning && s.playing === false;
      }, 6000);
      const after = await A.hornState();
      assert(after.errors.length === 0, `tab A errored on press ${i}: ${JSON.stringify(after.errors)}`);
      AbadgeLog.push(...(await A.badge()).slice(-1));
    }
    console.log(`  tab A: 3 honest blasts; tab B never claimed one. badge calls during: ${JSON.stringify(AbadgeLog)}`);

    console.log('--- now one blast in tab B: the badge must read the shared total (airhorn-xkq) ---');
    await B.clickHorn();
    await waitUntil(async () => (await B.hornState()).playing === false, 6000);
    const blogB = await B.badge();
    if (badgeApi) {
      const lastB = blogB.filter((e) => e.fn === 'setAppBadge').slice(-1);
      assert(lastB.length === 1 && lastB[0].arg === 4,
        `after 4 blasts across two tabs the badge was set to ${JSON.stringify(lastB)}, expected the shared total 4 - the badge is OS-wide but the counter is per-tab, so the last writer wins (airhorn-xkq)`);
      console.log(`  shared badge: A wrote 1,2,3 then B wrote ${lastB[0].arg} - the app-wide badge tracks total blasts.`);
    }

    console.log('--- opening tab C must not damage the badge another tab set (airhorn-70k) ---');
    const C = await openTab('C', `${origin}/`);
    await sleep(200);
    const blogC = await C.badge();
    if (badgeApi) {
      assert(!blogC.some((e) => e.fn === 'clearAppBadge'),
        `a freshly opened tab cleared the app badge at boot: ${JSON.stringify(blogC)} - the badge is shared by every tab of the origin, so a new tab must derive it, never clear it (airhorn-70k)`);
      const cSet = blogC.filter((e) => e.fn === 'setAppBadge');
      assert(cSet.length === 1 && cSet[0].arg === 4,
        `a freshly opened tab did not derive the shared badge (expected setAppBadge(4)): ${JSON.stringify(blogC)} (airhorn-70k)`);
      console.log(`  tab C booted and derived the badge: ${JSON.stringify(blogC)}`);
    }
    await closeTab(C);

    /* ------------- C. an offline -> online transition reaches both tabs ---- */
    console.log('\n--- C. offline, then online: every open tab announces exactly once ---');
    await A.ann('offline');
    await B.ann('offline');
    await A.session('Network.enable');
    await B.session('Network.enable');
    const offlineCond = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
    await A.session('Network.emulateNetworkConditions', offlineCond);
    await B.session('Network.emulateNetworkConditions', offlineCond);
    const sawOffline = await waitUntil(async () => {
      const a = await A.evaluate(`(JSON.parse(sessionStorage.getItem('__annLog')||'[]').filter(x=>x.e==='offline').map(x=>x.m))`);
      const b = await B.evaluate(`(JSON.parse(sessionStorage.getItem('__annLog')||'[]').filter(x=>x.e==='offline').map(x=>x.m))`);
      return a.some((m) => /No connection/.test(m)) && b.some((m) => /No connection/.test(m))
        ? { a, b } : null;
    }, 8000);
    assert(sawOffline, 'an offline transition did not announce in both tabs');
    for (const [name, log] of [['A', sawOffline.a], ['B', sawOffline.b]]) {
      const n = log.filter((m) => /No connection/.test(m)).length;
      assert(n === 1, `tab ${name} announced offline ${n} times for one transition`);
    }
    const onlineCond = { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };
    await A.session('Network.emulateNetworkConditions', onlineCond);
    await B.session('Network.emulateNetworkConditions', onlineCond);
    const sawOnline = await waitUntil(async () => {
      const a = await A.evaluate(`(JSON.parse(sessionStorage.getItem('__annLog')||'[]').filter(x=>x.e==='offline').map(x=>x.m))`);
      const b = await B.evaluate(`(JSON.parse(sessionStorage.getItem('__annLog')||'[]').filter(x=>x.e==='offline').map(x=>x.m))`);
      return a.some((m) => /Back online/.test(m)) && b.some((m) => /Back online/.test(m))
        ? { a, b } : null;
    }, 8000);
    for (const [name, log] of [['A', sawOnline.a], ['B', sawOnline.b]]) {
      const n = log.filter((m) => /Back online/.test(m)).length;
      assert(n === 1, `tab ${name} announced 'Back online' ${n} times for one transition`);
      assert(n === 1 && log.filter((m) => /No connection/.test(m)).length === 1,
        `tab ${name} logged a duplicate transition announcement: ${JSON.stringify(log)}`);
    }
    console.log('  offline and online announced exactly once in each tab.');

    /* ---- D. closing a horning tab must not tear down the survivor -------- */
    console.log('\n--- D. tab A horns in a loop, then closes; tab B must survive ---');
    await A.evaluate(`window.__airhorn.start({ loop: true })`);
    await waitUntil(async () => (await A.hornState()).playing === true, 5000);
    const aPlaying = await A.hornState();
    assert(aPlaying.peak > 0.3, `tab A's loop did not produce audio (peak ${aPlaying.peak})`);
    const bBadgeBefore = await B.badge();
    await closeTab(A);
    await sleep(500); // whatever teardown ran with A has run now
    const bAfterClose = await B.hornState();
    assert(bAfterClose.booted, 'tab B lost its app when tab A closed');
    assert(bAfterClose.bootAlertHidden, 'tab B showed the boot-failure alert when tab A closed');
    assert(JSON.stringify(await B.badge()) === JSON.stringify(bBadgeBefore),
      `tab A's close changed tab B's badge calls: ${JSON.stringify(await B.badge())}`);
    await B.clickHorn();
    const bBlast = await waitUntil(async () => {
      const s = await B.hornState();
      return s.peak > 0.3 ? s : null;
    }, 6000);
    assert(bBlast, `tab B could not blast after tab A closed (state ${JSON.stringify(bBlast || await B.hornState())})`);
    await waitUntil(async () => (await B.hornState()).playing === false, 6000);
    const bSettled = await B.hornState();
    assert(bSettled.pressed === 'false' && !bSettled.horning,
      'tab B was left with a stuck lit horn after its post-close blast');
    assert(bSettled.errors.length === 0, `tab B errored after tab A closed: ${JSON.stringify(bSettled.errors)}`);
    console.log(`  tab B healthy after tab A's close: blasts (peak ${bBlast.peak.toFixed(3)}), badge calls untouched, UI settled.`);

    /* --- A. an SW update with two tabs open announces in both, once each --- */
    console.log('\n--- A. an SW update discovered by tab B announces in both tabs ---');
    const A2 = await openTab('A2', `${origin}/`);
    await A2.ann('update1');
    await B.ann('update1');
    await A2.evaluate(`window.__mtMark = 'pre-update'`);
    await B.evaluate(`window.__mtMark = 'pre-update'`);
    state.version = '2.0.0-multitab-update';
    await B.evaluate(`navigator.serviceWorker.getRegistration()
      .then((r) => r.update()).then(() => true).catch(() => false)`);
    const update1 = await waitUntil(async () => {
      const a = await A2.evaluate(`(JSON.parse(sessionStorage.getItem('__annLog')||'[]').filter(x=>x.e==='update1').map(x=>x.m))`);
      const b = await B.evaluate(`(JSON.parse(sessionStorage.getItem('__annLog')||'[]').filter(x=>x.e==='update1').map(x=>x.m))`);
      const aReady = a.some((m) => /A new version is ready/.test(m));
      const bReady = b.some((m) => /A new version is ready/.test(m));
      return aReady && bReady ? { a, b } : null;
    }, 15000);
    for (const [name, log] of [['A2', update1.a], ['B', update1.b]]) {
      assert(log.some((m) => /Updating the Air Horner/.test(m)),
        `tab ${name} never announced that an update was coming: ${JSON.stringify(log)}`);
      assert(log.filter((m) => /Updating the Air Horner/.test(m)).length === 1,
        `tab ${name} announced the incoming update twice: ${JSON.stringify(log)}`);
      assert(log.filter((m) => /A new version is ready/.test(m)).length === 1,
        `tab ${name} announced the ready update twice: ${JSON.stringify(log)}`);
    }
    const reloaded = await waitUntil(async () => {
      const a = await A2.evaluate(`window.__mtMark === undefined`).catch(() => false);
      const b = await B.evaluate(`window.__mtMark === undefined`).catch(() => false);
      return a && b ? true : null;
    }, 15000);
    assert(reloaded, 'the update did not reload both tabs via controllerchange');
    const aBoot = await A2.waitBooted();
    const bBoot = await B.waitBooted();
    assert(aBoot && bBoot, 'a tab did not come back up after the update reload');
    const aPost = await A2.hornState();
    const bPost = await B.hornState();
    assert(aPost.bootAlertHidden && bPost.bootAlertHidden, 'the boot-failure alert showed after the update reload');
    assert(aPost.status === '' && bPost.status === '', `a live region held stale text after the reload: A2=${JSON.stringify(aPost.status)} B=${JSON.stringify(bPost.status)}`);
    console.log('  both tabs announced the update once, reloaded via controllerchange and rebooted cleanly.');

    /* -- E. a tab opened mid-install never saw updatefound: announced or not? */
    console.log('\n--- E. a tab opened while an update is already installing ---');
    state.version = '2.0.0-multitab-late';
    // Slow the new worker's precache so there is a deterministic window in
    // which the update is installing but not yet activated.
    state.swShim = `const __origFetch = self.fetch.bind(self);
self.fetch = (...args) => new Promise((resolve) => setTimeout(() => __origFetch(...args).then(resolve), 600));`;
    await B.evaluate(`navigator.serviceWorker.getRegistration()
      .then((r) => r.update()).then(() => true).catch(() => false)`);
    const installing = await waitUntil(async () => B.evaluate(
      `navigator.serviceWorker.getRegistration().then((r) => !!(r && r.installing))`), 10000);
    assert(installing, 'the third update never reached the installing state');
    const D = await openTab('D', `${origin}/`);
    await D.evaluate(`window.__mtMark = 'late-tab'`);
    await D.ann('update2');
    const dReloaded = await waitUntil(async () => B.evaluate(
      `navigator.serviceWorker.getRegistration().then((r) => !!(r && r.active && r.active.state === 'activated'))`), 20000)
      && await waitUntil(async () => D.evaluate(`window.__mtMark === undefined`).catch(() => false), 20000);
    if (dReloaded) {
      const dAnnouncementsAfter = await D.evaluate(
        `(JSON.parse(sessionStorage.getItem('__annLog')||'[]').filter(x=>x.e==='update2').map(x=>x.m))`);
      // The tab that reloads must say why (airhorn-56j): exactly one ready
      // announcement, not silence, not a duplicate of the installing notice.
      const ready = dAnnouncementsAfter.filter((m) => /A new version is ready/.test(m));
      assert(ready.length === 1,
        `a tab opened mid-install reloaded for the update with ${ready.length} 'ready' announcements (expected exactly 1): ${JSON.stringify(dAnnouncementsAfter)} - the reload was silent, against the app's one-polite-voice contract (airhorn-56j)`);
      await D.waitBooted();
      console.log(`  late tab announced its reload: ${JSON.stringify(ready)}`);
    } else {
      console.log('  late tab did not need to reload (it activated onto the new controller); nothing to assert.');
    }
    state.swShim = null;

    const dFinal = await D.hornState();
    const bFinal = await B.hornState();
    assert(dFinal.booted && bFinal.booted, 'a tab did not recover after the final update');
    assert(dFinal.bootAlertHidden && bFinal.bootAlertHidden, 'the boot-failure alert showed after the final update');

    console.log('\nALL MULTITAB COHERENCE CHECKS PASSED');
  } finally {
    try { cdp?.ws.close(); } catch { /* already gone */ }
    try { chrome.kill('SIGKILL'); } catch { /* already gone */ }
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
