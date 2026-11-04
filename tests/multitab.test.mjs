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
 *   F. coming back to the app acknowledges the shared badge (airhorn-7x7m):
 *      the count means "activity since you last looked", so the tab that
 *      becomes visible again clears the shared count and the OS badge (for
 *      every tab - the badge is one), the tab that goes hidden does not
 *      acknowledge, the next blast still works, and a fresh tab then boots
 *      owing nothing.
 *
 * Sound is measured, not inferred: the shortcuts suite's probe (reroute every
 * connect() to ctx.destination through a pass-through analyser) is injected
 * at document start in every tab, together with a badge spy and an announcer
 * logger that mirrors into sessionStorage so logs survive the update reload.
 *
 * Cross-tab defects fail HERE with the bead ID in the message - the four
 * tab-state regressions this suite must catch, not observations it files:
 * airhorn-xkq last-writer-wins badge, airhorn-70k boot-time badge wipe,
 * airhorn-56j silent mid-install reload, airhorn-7x7m badge count nothing
 * ever acknowledges.
 *
 * Run with: npm test (the fast gate builds dist/ first)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './support/browser.mjs';
import { awaitSocketOpen } from './cdp-command-bound.mjs';
import { installSignalExit } from './support/signal-exit.mjs';

// A bound-kill (SIGTERM first, then the grace bound) bypasses the try/finally
// in run(), which is the only place the browser is closed (SIGTERM, tree
// SIGKILL, profile removal): without this, a timed-out run leaked the whole
// chrome tree plus its /tmp profile (airhorn-1l0a). The handler itself is
// shared with the other suites and the browser tools (tests/support/
// signal-exit.mjs, airhorn-4vfn); it runs once, races the close against the
// grace bound, and exits with the signal's own code.
let liveBrowser = null;
installSignalExit(async () => {
  const browser = liveBrowser;
  liveBrowser = null;
  if (browser) await browser.close().catch(() => {});
});

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
  // Bounded (airhorn-eabw): an unbounded onopen await parks the suite if the
  // socket never opens; this also rejects on error/close so the refusal is named.
  await awaitSocketOpen(ws, { url: wsUrl });
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
  // Write spy + lock spy (airhorn-lg0e). The guard in sequence I used to claim
  // "no blast can be lost" while only proving a lock request was QUEUED, which
  // says nothing about where the storage write happens. These two wrappers make
  // that observable: every setItem of the shared count records whether it ran
  // inside a navigator.locks.request callback for that lock. A bump that writes
  // outside the lock is exactly the read-modify-write the guard exists to stop,
  // so the assertion can go red for it (and does - see the mutant in the bead).
  window.__badgeWrites = [];
  window.__heldLocks = [];
  try {
    const request = navigator.locks && navigator.locks.request;
    if (request) {
      navigator.locks.request = function (name, ...rest) {
        const cb = rest[rest.length - 1];
        if (typeof cb !== 'function') return request.call(this, name, ...rest);
        const wrapped = (...args) => {
          window.__heldLocks.push(name);
          try {
            return cb(...args);
          } finally {
            const at = window.__heldLocks.lastIndexOf(name);
            if (at >= 0) window.__heldLocks.splice(at, 1);
          }
        };
        rest[rest.length - 1] = wrapped;
        return request.call(this, name, ...rest);
      };
    }
    const setItem = Storage.prototype.setItem;
    const note = (value) => {
      // Named lock, not "some lock": a write while an unrelated lock is held is
      // still an unlocked write of THIS counter.
      window.__badgeWrites.push({ value: String(value), inLock: window.__heldLocks.includes('airhorn:blast-count') });
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'airhorn:blast-count') note(value);
      return setItem.call(this, key, value);
    };
    // setItem is NOT the only way to write: a named-property assignment on the
    // storage object goes through the WebIDL named setter and never calls setItem,
    // so a wrapper on
    // setItem alone recorded nothing and the guard stayed green while an unlocked
    // writer clobbered the count (airhorn-srpo, review of airhorn-lg0e). Proxy the
    // Storage object behind the window getter so BOTH paths are recorded.
    const realStorage = window.localStorage;
    const proxied = new Proxy(realStorage, {
      get(target, key) {
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, key, value) {
        if (key === 'airhorn:blast-count') note(value);
        return Reflect.set(target, key, value);
      },
      deleteProperty(target, key) {
        if (key === 'airhorn:blast-count') note('<deleted>');
        return Reflect.deleteProperty(target, key);
      },
    });
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => proxied });
  } catch {}

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

  const browser = await launchBrowser({ autoplay: true, label: 'multitab', timeoutMs: 20000 });
  liveBrowser = browser;

  let cdp = null;
  try {
    cdp = await connectCdp(browser.browserWsUrl);
    const { send, waitForEvent } = cdp;

    // openTab: a real second tab of the same origin, with its own CDP session,
    // its own instrumented documents and a per-tab identity for the log.
    const openTab = async (name, url, { instrument = true, preScript = null } = {}) => {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const session = (method, params = {}) => send(method, params, sessionId);
      if (instrument) await session('Page.addScriptToEvaluateOnNewDocument', { source: tabInstrumentation });
      if (preScript) await session('Page.addScriptToEvaluateOnNewDocument', { source: preScript });
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
    // .booted, not object truthiness: hornState() returns an object even when
    // the tab never booted, and an object is always truthy (airhorn-tuuq M1).
    assert((await B.hornState()).booted, 'tab B did not boot');
    const badgeApi = await B.evaluate('window.__badgeApi');
    console.log(`  two tabs live; badge API present in this browser: ${badgeApi}`);
    // The badge assertions below are the point of sections B/C (airhorn-xkq,
    // airhorn-70k); an `if (badgeApi)` guard with no else reads green by
    // skipping them (airhorn-tuuq M5). Fail loudly instead: without the API
    // this suite cannot verify its headline behavior, and the gate's Chrome
    // always has it.
    assert(badgeApi === true, 'setAppBadge/clearAppBadge not exposed in this browser; the badge-sharing assertions would be skipped');

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
    // The badge total has to be COMPUTED (airhorn-g0qr.9). Asserting only "tab B's last
    // call was 4" cannot say so: the right answer and a hardcoded 4 are the same number, so
    // a shared-total path that hardcodes or caps 4 passes it. Tab A's own three blasts
    // separate the two - a real aggregate writes 1, then 2, then 3 - and pinning the
    // sequence fixes the increment as well as the value.
    assert(
      JSON.stringify(AbadgeLog.map((e) => `${e.fn}:${e.arg}`)) === JSON.stringify(['setAppBadge:1', 'setAppBadge:2', 'setAppBadge:3']),
      `tab A's badge did not follow its own blasts 1,2,3 (got ${JSON.stringify(AbadgeLog)}); a badge that only ever writes one number is a constant, not the shared total`
    );
    console.log(`  tab A: 3 honest blasts; tab B never claimed one. badge calls during: ${JSON.stringify(AbadgeLog)}`);

    console.log('--- now one blast in tab B: the badge must read the shared total (airhorn-xkq) ---');
    await B.clickHorn();
    await waitUntil(async () => (await B.hornState()).playing === false, 6000);
    const blogB = await B.badge();
    if (badgeApi) {
      const lastB = blogB.filter((e) => e.fn === 'setAppBadge').slice(-1);
      const storageState = await B.evaluate(`(() => {
        try { return { shared: window.localStorage.getItem('airhorn:blast-count'), len: window.localStorage.length, ok: true }; }
        catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })()`);
      const storageStateA = await A.evaluate(`(() => {
        try { return { shared: window.localStorage.getItem('airhorn:blast-count'), href: location.href }; }
        catch (e) { return { ok: false, error: String(e && e.message || e) }; }
      })()`);
      assert(lastB.length === 1 && lastB[0].arg === 4,
        `after 4 blasts across two tabs the badge was set to ${JSON.stringify(lastB)}, expected the shared total 4 - the badge is OS-wide but the counter is per-tab, so the last writer wins (airhorn-xkq); tab B storage: ${JSON.stringify(storageState)}, tab A storage: ${JSON.stringify(storageStateA)}, tab B badge log: ${JSON.stringify(blogB)}`);
      console.log(`  shared badge: A wrote 1,2,3 then B wrote ${lastB[0].arg} - the app-wide badge tracks total blasts.`);
    }

    // A fifth blast makes the shared total 5, so a path that hardcodes or caps 4 is out
    // (airhorn-g0qr.9). Done before tab C boots, so C deriving the shared total below is
    // still the same claim with the number the fixture actually earned.
    if (badgeApi) {
      const beforeFifth = (await B.badge()).length;
      await B.clickHorn();
      await waitUntil(async () => (await B.hornState()).playing === false, 6000);
      // The count is bumped behind an origin lock, so the badge write lands after the
      // sound stops: wait for it rather than sampling once.
      const fifth = await waitUntil(async () => {
        const sets = (await B.badge()).slice(beforeFifth).filter((e) => e.fn === 'setAppBadge');
        return sets.length ? sets : null;
      }, 6000) || [];
      assert(fifth.length >= 1,
        `a fifth blast wrote no badge at all (appended ${JSON.stringify(fifth)}) - the badge must follow every blast`);
      assert(fifth.every((e) => e.arg === 5),
        `a fifth blast set the badge to ${JSON.stringify(fifth.map((e) => e.arg))}, expected 5 - a badge that reads 4 for both four and five blasts is capped, not the shared total`);
      console.log(`  fifth blast (second in tab B): badge 4 -> ${fifth[fifth.length - 1].arg}, so the total is computed.`);
    }

    console.log('--- opening tab C must not damage the badge another tab set (airhorn-70k) ---');
    const C = await openTab('C', `${origin}/`);
    await sleep(200);
    const blogC = await C.badge();
    if (badgeApi) {
      assert(!blogC.some((e) => e.fn === 'clearAppBadge'),
        `a freshly opened tab cleared the app badge at boot: ${JSON.stringify(blogC)} - the badge is shared by every tab of the origin, so a new tab must derive it, never clear it (airhorn-70k)`);
      const cSet = blogC.filter((e) => e.fn === 'setAppBadge');
      // 5 is the total the fixture has actually earned by here (3 in A + 2 in B); the
      // assertion is unchanged in kind - a fresh tab must DERIVE the shared total - only the
      // number moved with the extra blast that proves the total is computed.
      assert(cSet.length === 1 && cSet[0].arg === 5,
        `a freshly opened tab did not derive the shared badge (expected setAppBadge(5)): ${JSON.stringify(blogC)} (airhorn-70k)`);
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
      // D opened on an origin the previous worker already controlled, so it
      // hadController at parse and MUST reload via controllerchange when the
      // new worker takes over (airhorn-56j). 'No reload needed' cannot happen
      // here; letting it log-and-pass made this section green when the reload
      // was removed entirely (airhorn-tuuq M9, mutation-verified).
      throw new Error('the mid-install tab never reloaded on controllerchange - the airhorn-56j announcement path was not exercised');
    }
    state.swShim = null;

    const dFinal = await D.hornState();
    const bFinal = await B.hornState();
    assert(dFinal.booted && bFinal.booted, 'a tab did not recover after the final update');
    assert(dFinal.bootAlertHidden && bFinal.bootAlertHidden, 'the boot-failure alert showed after the final update');

    /* --- F. coming back to the app acknowledges the badge (airhorn-7x7m) --- */
    console.log('\n--- F. returning to a tab acknowledges the shared badge (airhorn-7x7m) ---');
    // Deterministic foreground: B front, then A2 - so the settled end state is
    // A2 foreground, B hidden, and every activation acknowledge (the tab that
    // becomes visible clears the count) has ALREADY fired before anything is
    // baselined below. Prove tab switching really drives visibility here too.
    await send('Target.activateTarget', { targetId: B.targetId });
    await waitUntil(async () => (await B.evaluate(`document.visibilityState`)) === 'visible', 5000);
    await send('Target.activateTarget', { targetId: A2.targetId });
    const bFronted = await waitUntil(async () => {
      const a = await A2.evaluate(`document.visibilityState`).catch(() => null);
      const b = await B.evaluate(`document.visibilityState`).catch(() => null);
      return b === 'hidden' && a === 'visible' ? true : null;
    }, 5000);
    assert(bFronted, `activating a target does not move visibility in this browser ` +
      `(A2=${await A2.evaluate(`document.visibilityState`)}, B=${await B.evaluate(`document.visibilityState`)}) - ` +
      `sequence F cannot drive a real 'looked at it again' moment here`);
    if (badgeApi) {
      // A blast in the VISIBLE foreground tab A2: the shared count and the OS
      // badge move. This look is live - there is nothing to acknowledge yet.
      await A2.clickHorn();
      await waitUntil(async () => (await A2.hornState()).playing === false, 6000);
      // Same race as the count above (airhorn-wzcw): wait for the write rather than read once.
      let aCount = 0;
      const advanced = await waitUntil(async () => {
        aCount = Number(await A2.evaluate(`Number(window.localStorage.getItem('airhorn:blast-count')) || 0`));
        return aCount > 0;
      }, 6000);
      assert(advanced, `a foreground blast did not advance the shared badge count (still ${aCount})`);
      // The user switches to tab B: B is now the tab being looked at, so B
      // acknowledges the count ("activity since you last looked"). The badge
      // is one per origin, so the acknowledgement must clear it for A2 too -
      // and A2, the tab that goes hidden, must not acknowledge anything.
      const bLogBefore = (await B.badge()).length;
      const aLogBefore = (await A2.badge()).length;
      // The user's actual return: B, hidden since A2 came to the front, is
      // activated and becomes the tab being looked at.
      await send('Target.activateTarget', { targetId: B.targetId });
      const acked = await waitUntil(async () => {
        const bLog = await B.badge();
        return bLog.length > bLogBefore && bLog.slice(bLogBefore).some((e) => e.fn === 'clearAppBadge') ? bLog : null;
      }, 5000);
      const aStorage = await A2.evaluate(`window.localStorage.getItem('airhorn:blast-count')`);
      const bStorage = await B.evaluate(`window.localStorage.getItem('airhorn:blast-count')`);
      const aLogAfter = await A2.badge();
      assert(acked && aStorage === null && bStorage === null,
        `returning to the app did not acknowledge the badge count: B's badge calls after activation ${JSON.stringify(acked)}, ` +
        `storage A2=${JSON.stringify(aStorage)} B=${JSON.stringify(bStorage)} - the shared count is lifetime-cumulative, ` +
        `once the first blast happened nothing ever clears it, so the OS badge shows yesterday's total on every launch (airhorn-7x7m)`);
      assert(aLogAfter.length === aLogBefore,
        `the tab that went HIDDEN acknowledged the count (${JSON.stringify(aLogAfter.slice(aLogBefore))}) - ` +
        `only the tab being looked at acknowledges (airhorn-7x7m)`);
      // And the acknowledged state holds for a brand-new tab: it boots
      // deriving the count, the count is gone, so it must set nothing.
      const ACK = await openTab('ACK', `${origin}/`);
      await sleep(200);
      const ackLog = await ACK.badge();
      assert(!ackLog.some((e) => e.fn === 'setAppBadge'),
        `a fresh tab re-displayed an acknowledged count: ${JSON.stringify(ackLog)} - ` +
        `the count should have been cleared when the user came back to the app (airhorn-7x7m)`);
      await closeTab(ACK);
      // Closing the foreground ACK tab can flip a hidden tab back to visible,
      // and its acknowledge would race the blast below - settle the
      // foreground on B first (a no-op if B never went hidden).
      await send('Target.activateTarget', { targetId: B.targetId });
      await waitUntil(async () => (await B.evaluate(`document.visibilityState`)) === 'visible', 5000);
      // The badge still works after an acknowledgement: a foreground blast
      // in B starts the shared count from one again.
      await B.clickHorn();
      await waitUntil(async () => (await B.hornState()).playing === false, 6000);
      // Read the count by WAITING for it, not once after the blast's audio finished: the write is
      // asynchronous, so a loaded host read the acknowledged 0 here (airhorn-wzcw).
      let afterBlast = 0;
      const restarted = await waitUntil(async () => {
        afterBlast = Number(await B.evaluate(`Number(window.localStorage.getItem('airhorn:blast-count')) || 0`));
        return afterBlast === 1;
      }, 6000);
      assert(restarted && afterBlast === 1,
        `after an acknowledgement a fresh blast did not restart the shared count at 1 (got ${afterBlast}) (airhorn-7x7m)`);
      console.log('  switching back to the app cleared the shared count for every tab, a fresh tab boots owing nothing, and a fresh blast restarts the count at 1.');
    }

    /* -- G. a storage-blocked tab must not wipe the badge (airhorn-danq) --- */
    console.log('\n--- G. a tab that cannot read storage must leave the shared badge alone ---');
    if (badgeApi) {
      // A normal foreground blast first: a shared count and badge exist for
      // the blocked tab to (not) disturb.
      await B.clickHorn();
      await waitUntil(async () => (await B.hornState()).playing === false, 6000);
      let gCount = 0;
      const gAdvanced = await waitUntil(async () => {
        gCount = Number(await B.evaluate(`Number(window.localStorage.getItem('airhorn:blast-count')) || 0`));
        return gCount > 0;
      }, 6000);
      assert(gAdvanced, `a foreground blast did not advance the shared badge count (still ${gCount})`);
      // The airhorn-danq repro: a tab whose localStorage access THROWS
      // (blocked cookies/site data, some embedded webviews). The app must
      // still boot, must not touch the badge whose count it cannot know, and
      // its own blasts must still badge via the per-tab fallback.
      const blocked = `Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('blocked'); } });`;
      const G2 = await openTab('G2', `${origin}/`, { preScript: blocked });
      await sleep(200);
      const g2State = await G2.hornState();
      assert(g2State.booted, 'the storage-blocked tab did not boot at all');
      const g2Boot = await G2.badge();
      assert(!g2Boot.some((e) => e.fn === 'clearAppBadge'),
        `a storage-blocked tab cleared the app badge at boot: ${JSON.stringify(g2Boot)} - ` +
        `it cannot know the shared count, so it must not touch the badge another tab set (airhorn-danq)`);
      await G2.clickHorn();
      await waitUntil(async () => (await G2.hornState()).playing === false, 6000);
      const g2After = await G2.badge();
      assert(g2After.some((e) => e.fn === 'setAppBadge' && e.arg === 1),
        `the storage-blocked tab's own blast did not badge via the per-tab fallback: ${JSON.stringify(g2After)} (airhorn-danq)`);
      // The badge the blocked tab set for itself is acknowledged when the
      // user looks at it again (airhorn-0w1q): the OS badge is one per
      // origin, so its look-transition is the same acknowledge any tab
      // performs, and its fallback counter restarts.
      const g2LogBefore = (await G2.badge()).length;
      await send('Target.activateTarget', { targetId: B.targetId });
      await waitUntil(async () => (await B.evaluate(`document.visibilityState`)) === 'visible', 5000);
      await send('Target.activateTarget', { targetId: G2.targetId });
      const g2Acked = await waitUntil(async () => {
        const l = await G2.badge();
        return l.length > g2LogBefore && l.slice(g2LogBefore).some((e) => e.fn === 'clearAppBadge') ? l : null;
      }, 5000);
      assert(g2Acked,
        `the blocked-storage tab never acknowledged the badge it set itself (calls after its look-transition: ${JSON.stringify((await G2.badge()).slice(g2LogBefore))}) - ` +
        `no event in the app can ever clear that badge (airhorn-0w1q)`);
      await G2.clickHorn();
      await waitUntil(async () => (await G2.hornState()).playing === false, 6000);
      const g2Restart = await G2.badge();
      assert(g2Restart.slice(-1).some((e) => e.fn === 'setAppBadge' && e.arg === 1),
        `after its acknowledgement the blocked tab's next blast did not restart at 1: ${JSON.stringify(g2Restart)} (airhorn-0w1q)`);
      await closeTab(G2);
      console.log('  storage-blocked tab booted, left the shared badge alone, badged its own blasts from one, and acknowledged them when looked at again.');
    }

    /* -- H. a launch of the installed app acknowledges the badge (airhorn-2eh8) -- */
    console.log('\n--- H. a launch of the installed app acknowledges the badge ---');
    if (badgeApi) {
      // The sequences before this one move focus around and G ends by closing
      // its own (activated) tab, which hands tab B a look-transition - the
      // same acknowledge as sequence F. That clear is asynchronous (it runs
      // under the origin lock), so a blast fired straight after it is
      // acknowledged away and H measures the previous look instead of the
      // launch (gate 649e7ea7 on the airhorn-ecp union: 'a foreground blast
      // did not advance the shared badge count'). Settle the look first, then
      // make the count, so the only thing that can clear it is the launch.
      await send('Target.activateTarget', { targetId: B.targetId });
      await waitUntil(async () => (await B.evaluate(`document.visibilityState`)) === 'visible', 5000);
      const hSettled = await waitUntil(async () =>
        (await B.evaluate(`window.localStorage.getItem('airhorn:blast-count')`)) === null ? true : null, 5000);
      assert(hSettled,
        'tab B never settled its look-transition acknowledge before the launch sequence: ' +
        `storage is ${JSON.stringify(await B.evaluate(`window.localStorage.getItem('airhorn:blast-count')`))}`);
      // A shared count exists (blast in the foreground tab B).
      await B.clickHorn();
      await waitUntil(async () => (await B.hornState()).playing === false, 6000);
      const hCount = await waitUntil(async () => {
        const n = Number(await B.evaluate(`window.localStorage.getItem('airhorn:blast-count')`)) || 0;
        return n > 0 ? n : null;
      }, 5000);
      assert(hCount > 0, 'a foreground blast did not advance the shared badge count');
      // A cold launch: a fresh tab whose launch queue has a delivery queued
      // BEFORE the app loads - the platform delivers a queued launch to
      // setConsumer right at startup, which is the cold-launch path. The app
      // must acknowledge the shared badge in that consumer: the launch is
      // the user coming to look. A plain tab boot (sequence B's tab C) never
      // fires a launch and still only derives (airhorn-70k).
      const LQ = await openTab('LQ', `${origin}/`, { preScript: `
        try {
          Object.defineProperty(window, 'launchQueue', { configurable: true, value: { setConsumer(fn) { fn({}); } } });
        } catch (e) { window.__lqStubError = String(e); }
      ` });
      await sleep(300);
      const lqStub = await LQ.evaluate('window.__lqStubError || null');
      assert(!lqStub, `could not queue a launch delivery in the test tab: ${lqStub}`);
      const lqLog = await LQ.badge();
      assert(lqLog.some((e) => e.fn === 'clearAppBadge'),
        `a launch of the app did not acknowledge the shared badge: ${JSON.stringify(lqLog)} - ` +
        `the cold launch displays yesterday's count with nothing clearing it (airhorn-2eh8)`);
      const lqStorage = await LQ.evaluate(`window.localStorage.getItem('airhorn:blast-count')`);
      assert(lqStorage === null,
        `the launch did not clear the stored count (got ${JSON.stringify(lqStorage)}) (airhorn-2eh8)`);
      await closeTab(LQ);
      console.log('  the launch consumer acknowledged the badge; plain tab boots still only derive (airhorn-70k).');
    }

    /* -- I. two simultaneous bumps cannot lose an increment (airhorn-rqz1) -- */
    console.log('\n--- I. simultaneous blasts in two tabs cannot lose an increment ---');
    const haveLocks = await A2.evaluate(`!!navigator.locks?.request`);
    if (haveLocks) {
      // Deterministic interleaving: the TEST holds the app's origin lock, so
      // (with the fix) any blast bump in either tab queues behind it and both
      // serialize on release - the shared count must end at before+2. Without
      // the lock both tabs read the pre-blast count and write before+1:
      // one blast lost.
      //
      // SCOPE (airhorn-lg0e): everything below is about bumps that QUEUE ON THE
      // ORIGIN LOCK. It does not, and cannot, rule out a writer that never asks
      // for the lock - the reviewer scheduled a stale unlocked write of count=1
      // 1200 ms later and the shared count ended at 1 while this guard stayed
      // green {queued:true,during:0,settled:2,after:1}. An unlocked writer is
      // outside the lock's contract: serializing it is not something the app can
      // do, so the assertion messages say "a bump that takes the origin lock"
      // rather than "no blast can ever be lost".
      await send('Target.activateTarget', { targetId: A2.targetId });
      await waitUntil(async () => (await A2.evaluate(`document.visibilityState`)) === 'visible', 5000);
      const before = await A2.evaluate(`Number(window.localStorage.getItem('airhorn:blast-count')) || 0`);
      // The assignment expression evaluates to the REQUEST'S PROMISE, and
      // evaluate awaits promises - so return a plain true and never let the
      // harness await a promise that resolves only at release.
      await A2.evaluate(`(() => { window.__rqz1Hold = navigator.locks.request('airhorn:blast-count', () => new Promise((r) => { window.__rqz1Release = r; })); return true; })()`);
      // locks.request's PROMISE resolves only when the callback COMPLETES
      // (at release) - awaiting it here would hang the suite. The lock is
      // GRANTED when the callback invokes, which is when __rqz1Release
      // appears; poll for that.
      const held = await waitUntil(async () => {
        try { return await A2.evaluate(`typeof window.__rqz1Release === 'function'`); } catch { return false; }
      }, 5000);
      assert(held, 'the test could not hold the origin badge lock - sequence I cannot force the interleaving');
      await A2.evaluate(`window.__airhorn.start()`);
      // Wait for the bump to QUEUE, not for a clock (airhorn-g0qr.8). A fixed app asks
      // the lock manager for the app's own lock in order to bump, and Web Locks reports
      // that request in query().pending while the test holds it - so the queue is
      // observable without waiting for a write. The old check slept a fixed 300 ms and
      // then read storage, which only saw an unlocked write that happened to land inside
      // that window: with the write delayed to 800 ms the suite went GREEN and printed
      // "no blast lost" while increments could still clobber.
      const queued = await waitUntil(async () => {
        try {
          const q = await A2.evaluate(`navigator.locks.query().then((q) => JSON.stringify({
            held: q.held.map((l) => l.name),
            pending: q.pending.map((l) => l.name),
          }))`);
          const parsed = JSON.parse(q);
          return parsed.pending.includes('airhorn:blast-count') ? parsed : null;
        } catch {
          return null;
        }
      }, 5000);
      assert(queued,
        `a blast's increment never queued on the origin lock while the test held it (queues seen: ${JSON.stringify(queued)}) - ` +
        `the app's bump is then an unlocked read-modify-write, and interleaved tabs can lose a blast (airhorn-rqz1)`);
      // ...and with the bump queued, nothing may have been written. This is now
      // deterministic rather than a race against 300 ms: the app is demonstrably
      // still waiting, so any count here came from a write that bypassed the lock.
      const duringHold = await A2.evaluate(`Number(window.localStorage.getItem('airhorn:blast-count')) || 0`);
      assert(duringHold === before,
        `a blast's increment was written while another holder owned the origin lock (count ${before} -> ${duringHold} under the hold) - ` +
        `the bump did not take the lock, so it is a non-atomic read-modify-write and interleaved tabs can lose a blast (airhorn-rqz1)`);
      await A2.evaluate(`window.__rqz1Release && window.__rqz1Release()`);
      await B.evaluate(`window.__airhorn.start()`);
      const settled = await waitUntil(async () => {
        const n = await A2.evaluate(`Number(window.localStorage.getItem('airhorn:blast-count')) || 0`);
        return n === before + 2 ? n : null;
      }, 5000);
      const after = await A2.evaluate(`Number(window.localStorage.getItem('airhorn:blast-count')) || 0`);
      assert(settled,
        `two blasts in two tabs produced a shared count of ${after}, expected ${before + 2} - ` +
        `the two bumps, which both queued on the origin lock, were not serialized: one clobbered the other and a blast was lost (airhorn-rqz1). ` +
        `(A separate, unlocked writer is not covered here - airhorn-lg0e)`);
      // The claim this sequence makes is that a blast's increment is a LOCKED
      // read-modify-write, because that is what makes interleaved tabs add up
      // instead of clobbering (airhorn-rqz1). "A request was queued" is not that
      // claim: it says nothing about where the write happened (airhorn-lg0e).
      // Every write of the shared count must therefore be observed INSIDE a
      // navigator.locks.request callback for the same lock - recorded at the
      // moment of the write, so no sleep decides it.
      // Both tabs blasted: a bump writes in whichever page pressed, so both
      // pages' records count (a write is either inside the lock or it is not).
      const fromA2 = JSON.parse(await A2.evaluate(`JSON.stringify(window.__badgeWrites || [])`));
      const fromB = JSON.parse(await B.evaluate(`JSON.stringify(window.__badgeWrites || [])`));
      const records = [...fromA2, ...fromB];
      // COMPLETENESS (airhorn-srpo): "every write happened inside the lock" is only
      // as good as the spy's coverage. A wrapper on setItem alone missed the WebIDL
      // named setter, so an unlocked named-property write clobbered the count and the
      // guard stayed green. Two defences: the proxy above records that path too, and
      // this check refuses to trust the record when the value actually stored was not
      // produced by any write the spy saw - so a NEW bypass fails loudly instead of
      // passing quietly.
      const storedNow = await A2.evaluate(`Number(window.localStorage.getItem('airhorn:blast-count')) || 0`);
      const lastRecorded = records.length ? Number(records[records.length - 1].value) : null;
      assert(records.length > 0 && lastRecorded === storedNow,
        `the stored blast count is ${storedNow} but the last write the spy recorded is ${JSON.stringify(lastRecorded)} ` +
        `(records: ${JSON.stringify(records)}) - a write happened that the instrument did not observe, so "every write was ` +
        `inside the lock" is untested on that path (airhorn-srpo)`);
      const writes = JSON.stringify(records);
      assert(records.length > 0,
        `no write of the shared blast count was observed in the tab that blasted (records: ${writes}) - ` +
        `the guard cannot claim a locked increment if it never saw the write (airhorn-lg0e)`);
      const unlocked = records.filter((r) => !r.inLock);
      assert(unlocked.length === 0,
        `${unlocked.length} of ${records.length} write(s) of the shared blast count happened OUTSIDE the origin lock ` +
        `(${JSON.stringify(unlocked)}) - an unlocked read-modify-write is what lets interleaved tabs lose a blast (airhorn-rqz1, airhorn-lg0e)`);

      // THE BOUNDARY, measured rather than asserted away (airhorn-lg0e; revised for
      // airhorn-f5ut, whose monotonic merge this tail used to fail ON). Two facts,
      // both observable, neither racy:
      //   1. A RAW write (outside the app's API) still takes effect: the app does
      //      not and cannot defend storage written behind its back (lg0e's boundary).
      //   2. The app's own contract after such a clobber (f5ut): the next bump BUILDS
      //      ON whatever is stored - the locked path re-reads inside the origin lock
      //      (rqz1); the no-locks fallback merges off the freshest same-turn read,
      //      pinned browser-free in tests/badge-count.test.js. It never re-publishes
      //      a total captured before the clobber.
      // The OLD tail asserted the clobber was FINAL (2 -> 1). Under full-gate load a
      // variably-late app bump (3 writes quiet, 4 under load) landed after the raw
      // write and merged 1 -> 2 - the product working as f5ut designed - and the
      // union gate failed on correct behaviour. So quiesce FIRST, observably: no
      // bump pending on the origin lock AND the stored count stable across two
      // reads, so no late write can race the raw write.
      const quiesced = await waitUntil(async () => {
        const q = JSON.parse(await A2.evaluate(`navigator.locks.query().then((q) => JSON.stringify({
          pending: q.pending.map((l) => l.name),
        }))`));
        if (q.pending.includes('airhorn:blast-count')) return null;
        const first = await A2.evaluate(`window.localStorage.getItem('airhorn:blast-count')`);
        await new Promise((r) => setTimeout(r, 150));
        const second = await A2.evaluate(`window.localStorage.getItem('airhorn:blast-count')`);
        return first === second && first !== null ? first : null;
      }, 5000);
      assert(quiesced !== null && Number(quiesced) === before + 2,
        `the bumps never quiesced at ${before + 2} (last stable read: ${JSON.stringify(quiesced)}) - ` +
        `a late count write is still in flight and the boundary measurement would race it (airhorn-f5ut)`);
      await B.evaluate(`(window.localStorage.setItem('airhorn:blast-count', '1'), true)`);
      const afterUnlocked = await A2.evaluate(`Number(window.localStorage.getItem('airhorn:blast-count'))`);
      const lateRecords = JSON.parse(await B.evaluate(`JSON.stringify(window.__badgeWrites || [])`));
      const late = lateRecords.filter((r) => !r.inLock);
      assert(late.length >= 1,
        `the unlocked write performed by this test was NOT recorded as an unlocked write (records: ${JSON.stringify(lateRecords)}) - ` +
        `the guard cannot tell a locked increment from an unlocked one, so its "inside the lock" claim is untested (airhorn-lg0e)`);
      assert(afterUnlocked === 1,
        `a raw write outside the app's API did NOT take effect (count reads ${afterUnlocked}, expected 1) - ` +
        `the boundary moved: the app now claims storage it does not own (airhorn-lg0e)`);
      // The f5ut half: an app bump after the raw clobber BUILDS ON the stored value
      // (1 -> 2); it must not re-publish a total captured before the clobber (which
      // would read 3). In this browser the bump takes the origin lock, so this pins
      // the rqz1 re-read inside the lock; the no-locks merge is pinned browser-free
      // by tests/badge-count.test.js, which goes RED when the merge is reverted.
      await B.evaluate(`window.__airhorn.start()`);
      const merged = await waitUntil(async () => {
        const n = await A2.evaluate(`Number(window.localStorage.getItem('airhorn:blast-count')) || 0`);
        return n === 2 ? n : null;
      }, 5000);
      const mergedNow = await A2.evaluate(`Number(window.localStorage.getItem('airhorn:blast-count')) || 0`);
      assert(merged === 2,
        `an app bump after a raw clobber to 1 left the count at ${mergedNow} - ` +
        `the bump re-published a stale captured total instead of building on what is stored (airhorn-f5ut)`);
      console.log(`  simultaneous bumps that take the origin lock serialized: ${before} -> ${after}, neither lost ` +
        `(every one of ${records.length} count write(s) observed inside the lock); a raw write outside the app's API then took it to ` +
        `${afterUnlocked} (the lg0e boundary, still true), and the next app bump built on it: ${mergedNow} (airhorn-f5ut).`);

      await A2.evaluate(`window.__airhorn.stop({ immediate: true })`);
      await B.evaluate(`window.__airhorn.stop({ immediate: true })`);
    } else {
      console.log('  navigator.locks unavailable in this browser; nothing to assert.');
    }

    /* -- J. a launch's acknowledge wins over a pending locked bump (airhorn-3v90) -- */
    console.log('\n--- J. a launch cannot be overwritten by a blast bump that queued before the look ---');
    if (haveLocks) {
      // The reviewer's repro (airhorn-3v90): a blast's bump queues on the
      // origin lock; a launch delivery then arrives - the user coming to
      // look. The acknowledge must WIN: the pending bump must not publish
      // its stale total after the look cleared the badge. Stand-in launch
      // consumer installed before the page scripts so the app's consumer
      // lands in it (the platform cannot deliver launches headless).
      const launchStandIn = `(() => {
        window.__jLaunchParams = null;
        Object.defineProperty(window, 'launchQueue', { configurable: true, value: { setConsumer(fn) { window.__launchConsumer = fn; } } });
        return true;
      })()`;
      const J2 = await openTab('J2', `${origin}/`, { preScript: launchStandIn });
      await send('Target.activateTarget', { targetId: J2.targetId });
      await waitUntil(async () => (await J2.evaluate(`document.visibilityState`)) === 'visible', 5000);
      // The test owns the origin lock: J2's blast bump queues behind it.
      await J2.evaluate(`(() => { window.__jHold = navigator.locks.request('airhorn:blast-count', () => new Promise((r) => { window.__jRelease = r; })); return true; })()`);
      const jHeld = await waitUntil(async () => {
        try { return await J2.evaluate(`typeof window.__jRelease === 'function'`); } catch { return false; }
      }, 5000);
      assert(jHeld, 'the test could not hold the origin badge lock - sequence J cannot force the ordering');
      await J2.evaluate(`window.__airhorn.start()`);
      await sleep(300);
      // The launch arrives while the bump is still queued: the user comes
      // to look. (Today the acknowledge runs immediately and finds no count
      // to clear; with the fix it queues behind the bump on the lock.)
      await J2.evaluate(`window.__launchConsumer({ targetURL: ${JSON.stringify(origin + '/')}, files: [] })`);
      await sleep(200);
      await J2.evaluate(`window.__jRelease && window.__jRelease()`);
      await sleep(600);
      const jCount = await J2.evaluate(`window.localStorage.getItem('airhorn:blast-count')`);
      const jBadge = await J2.badge();
      const last = jBadge[jBadge.length - 1];
      assert(jCount === null && last && last.fn === 'clearAppBadge',
        `the launch acknowledged the badge but a stale queued bump republished it: storage=${JSON.stringify(jCount)}, last badge call=${JSON.stringify(last)} - ` +
        `the user's look must win over a blast that happened before it (airhorn-3v90)`);
      // And acknowledgement must not break later badge movement.
      await J2.evaluate(`window.__airhorn.start()`);
      await waitUntil(async () => (await J2.hornState()).playing === false, 6000);
      const jAfter = await J2.badge();
      assert(jAfter.some((e) => e.fn === 'setAppBadge'),
        `a blast after the launch acknowledge did not badge the fresh count: ${JSON.stringify(jAfter)} (airhorn-3v90)`);
      await closeTab(J2);
      console.log('  the launch acknowledge beat the queued bump, and later blasts still badge.');
    } else {
      console.log('  navigator.locks unavailable; nothing to assert.');
    }

    console.log('\nALL MULTITAB COHERENCE CHECKS PASSED');
  } finally {
    liveBrowser = null;
    try { cdp?.ws.close(); } catch { /* already gone */ }
    // browser.close() does what airhorn-jx9's inline group-kill + rmSync did:
    // SIGTERM, tree-SIGKILL after 1.5s, profile removal.
    try { await browser.close(); } catch { /* already gone */ }
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
