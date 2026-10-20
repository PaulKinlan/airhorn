/*
 * tests/shortcuts.test.mjs — does the manifest's shortcut actually do what it
 * promises? (airhorn-x4l)
 *
 * public/manifest.json advertises one shortcut, "Instant Blast" -> /#instant.
 * The promise is threefold: the deep link loads the app, the horn sounds
 * immediately, and the URL keeps the state so it can be shared or bookmarked.
 * Then the negatives: an unknown hash, a shortcut opened offline, and a
 * shortcut followed by a normal navigation must none of them leave the horn
 * stuck or the UI inconsistent.
 *
 * TWO browser launches, on purpose:
 *
 *   A) with --autoplay-policy=no-user-gesture-required. Launching an installed
 *      app from its shortcut is a user gesture, so this is the context the
 *      manifest promise is made in; every "it blasts" assertion runs here.
 *
 *   B) with the default policy, i.e. a shared /#instant link pasted into an
 *      ordinary tab. Chrome refuses to start audio there, and the one thing
 *      the app must never do is claim it is playing while the graph is
 *      suspended. B asserts "state matches audibility", and that the first
 *      real press then plays - so a blocked deep link is a quiet page, not a
 *      lying one.
 *
 * Sound is measured, not inferred: an injected probe reroutes every connect()
 * aimed at the AudioContext destination through a pass-through analyser, so
 * `peak` is the signal at the destination's input - after the app's own gain -
 * and `ctxState` is the browser's own verdict. A control checks both directions
 * before anything is trusted (checkProbeIntegrity).
 *
 * Run with: npm test (the fast gate builds dist/ first)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './support/browser.mjs';

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

// "Did it sound" is answered at the AudioContext destination's INPUT, not at the
// source: every connect() aimed at ctx.destination is rerouted through a
// pass-through analyser (node -> analyser -> destination), so the measurement
// sits AFTER whatever gain the app applied. A graph the app muted to zero
// therefore measures zero - and checkProbeIntegrity proves that both ways
// (muted -> 0, unmuted -> >0.3) before any shortcut is measured. An earlier
// version tapped the source's output in parallel and reported sound from a muted
// output (airhorn-aos).
const instrumentation = `
  window.__probe = { starts: 0, level: 0, peak: 0, states: [], errors: [] };
  // Launch Handler API: headless Chrome 155 DOES expose window.launchQueue, but a
  // page cannot make the platform deliver a launch, so the platform's half is
  // stood in for - record the consumer the page registers, deliver the cold
  // launch's params at setConsumer, and let the test fire repeat launches. The
  // real API's presence is recorded so the report cannot claim otherwise.
  const nativeLaunchQueue = typeof window.launchQueue?.setConsumer === 'function';
  window.__launchQueueSource = nativeLaunchQueue ? 'native+stand-in' : 'stand-in';
  // A cold launch carries LaunchParams that are enqueued before the page runs
  // and delivered when the consumer is set: model that, because that delivery is
  // what double-fired the horn alongside the load-time URL handling
  // (airhorn-lw9).
  window.__pendingLaunches = location.hash === '#instant'
    ? [{ targetURL: location.href, files: [] }]
    : [];
  try {
    Object.defineProperty(window, 'launchQueue', {
      configurable: true,
      value: {
        setConsumer(fn) {
          window.__launchConsumer = fn;
          const pending = window.__pendingLaunches.slice();
          window.__pendingLaunches.length = 0;
          for (const params of pending) setTimeout(() => fn(params), 0);
        },
      },
    });
  } catch (err) {
    window.__launchQueueError = String(err && err.message || err);
  }
  window.__fireLaunch = (targetURL) => {
    if (typeof window.__launchConsumer !== 'function') {
      throw new Error('the page never registered a launch consumer');
    }
    window.__launchConsumer({ targetURL, files: [] });
  };
  window.__probe.reset = () => { window.__probe.level = 0; window.__probe.peak = 0; window.__probe.states.length = 0; };
  window.addEventListener('error', (e) => window.__probe.errors.push(e.message));
  window.addEventListener('unhandledrejection', (e) => window.__probe.errors.push(String(e.reason && e.reason.message || e.reason)));
  const AC = window.AudioContext || window.webkitAudioContext;
  if (AC && window.AudioNode) {
    const originalConnect = AudioNode.prototype.connect;
    const taps = new WeakMap();
    // One tap per context: node -> analyser -> (the real) destination.
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
      setTimeout(() => clearInterval(timer), 20000);
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
`;

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

// Close a browser the way it has to be closed: killing the parent alone leaves
// its renderers behind (the reaper found 13 processes, 47 minutes old, from one
// such run). browser.mjs's killNow() tree-kills deepest-first, and browsers are
// registered so SIGTERM/SIGINT (what a bound-kill sends first) does the same
// thing. In the gate's shared Chrome killNow() is a no-op - the gate owns that
// browser's whole tree and reaps it, targets included.
const openBrowsers = new Set();

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const browser of openBrowsers) browser.browser.killNow();
    process.exit(143);
  });
}

async function launch({ autoplay, label }) {
  const browser = await launchBrowser({ autoplay, label, timeoutMs: 15000 });

  const ws = new WebSocket(browser.pageWsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let id = 1;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Log.entryAdded' && message.params.entry.level !== 'info') {
      logs.push(`${message.params.entry.level}: ${message.params.entry.text}`);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      logs.push(`exception: ${message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text}`);
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const snapshot = () => evaluate(`(() => {
    const horn = document.querySelector('.horn');
    return {
      href: location.href,
      hash: location.hash,
      booted: !!window.__airhorn,
      pressed: horn && horn.getAttribute('aria-pressed'),
      horning: horn && horn.classList.contains('horning'),
      playing: window.__airhorn ? window.__airhorn.isPlaying() : null,
      fallback: window.__airhorn ? window.__airhorn.usingFallback : null,
      starts: window.__probe.starts,
      level: window.__probe.level,
      peak: window.__probe.peak,
      ctxState: window.__probe.states[window.__probe.states.length - 1] || null,
      errors: window.__probe.errors.slice(),
      controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      onLine: navigator.onLine,
      status: (document.getElementById('app-status') || {}).textContent || '',
      active: (document.activeElement && document.activeElement.className) || '',
    };
  })()`);

  const navigate = async (url, { wait = 250 } = {}) => {
    await send('Page.navigate', { url });
    await sleep(wait);
    return snapshot();
  };

  // The app only reads the hash once the window load event has fired, and the
  // sample has to be fetched and decoded before there is anything to hear, so a
  // fixed sleep is a race on a loaded box. Poll for the condition instead, and
  // fail with the last snapshot so the message says what was actually observed.
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

  const press = async (hold = 300) => {
    const box = await evaluate(`(() => { const horn = document.querySelector('.horn'); if (!horn) return null; const r = horn.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error('the horn was not on the page to press');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(hold);
    const during = await snapshot();
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await sleep(400);
    return { during, after: await snapshot() };
  };

  const setOffline = (offline) => send('Network.emulateNetworkConditions', {
    offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });

  const handle = { browser };
  openBrowsers.add(handle);
  const close = async () => {
    openBrowsers.delete(handle);
    try { ws.close(); } catch {}
    await browser.close();
  };

  return { send, evaluate, snapshot, navigate, waitFor, press, setOffline, close, sleep, logs };
}

async function checkManifest() {
  console.log('--- 1. the manifest fields the shortcut depends on ---');
  const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  assert(Array.isArray(manifest.shortcuts) && manifest.shortcuts.length >= 1, 'manifest.json has no shortcuts to verify');
  assert(manifest.scope === '/', `scope must be '/' for /#instant to be inside it, got ${JSON.stringify(manifest.scope)}`);
  assert(manifest.launch_handler?.client_mode === 'focus-existing',
    `launch_handler.client_mode should be focus-existing, got ${JSON.stringify(manifest.launch_handler)}`);

  for (const shortcut of manifest.shortcuts) {
    const url = new URL(shortcut.url, 'https://airhorner.com');
    assert(url.pathname === '/' && url.hash === '#instant',
      `shortcut "${shortcut.name}" points at ${shortcut.url}, which is not the /#instant deep link`);
    assert(shortcut.name && shortcut.short_name && shortcut.description,
      `shortcut "${shortcut.name}" is missing one of name/short_name/description`);
    for (const icon of shortcut.icons || []) {
      const iconPath = path.join(DIST, icon.src);
      assert(fs.existsSync(iconPath), `shortcut "${shortcut.name}" references ${icon.src}, which is not in dist/`);
      const declared = icon.sizes.split('x').map(Number);
      assert(declared.length === 2 && declared.every((n) => n > 0),
        `shortcut "${shortcut.name}" declares a malformed icon size ${icon.sizes}`);
    }
    // The URL a user copies out of the shortcut menu must be the one the app reads.
    console.log(`  ${shortcut.name}: ${shortcut.url} (scope ${manifest.scope}, ${manifest.launch_handler.client_mode})`);
  }
  assert(manifest.start_url.startsWith('/'), `start_url ${manifest.start_url} should be same-origin`);
  console.log('  manifest shortcut contract: OK');
}

// The probe itself is checked both ways before it is trusted: a graph muted to
// zero at the output must measure zero, and the same graph at unity must measure
// sound. Without this, an upstream tap would happily "prove" audio for a muted
// app (airhorn-aos - the reviewer's repro was exactly a zero gain before the
// destination).
async function checkProbeIntegrity(browser) {
  console.log('--- 0. the probe measures the output, not the source ---');
  await browser.navigate('about:blank', { wait: 100 });
  const control = await browser.evaluate(`(async () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    const measure = async (muteTheOutput) => {
      const ctx = new AC();
      await ctx.resume();
      window.__probe.reset();
      const buffer = ctx.createBuffer(1, 44100, 44100);
      buffer.getChannelData(0).fill(0.7);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = muteTheOutput ? 0 : 1;
      gain.connect(ctx.destination);
      source.connect(gain);
      source.start();
      await new Promise((resolve) => setTimeout(resolve, 450));
      const peak = window.__probe.peak;
      window.__probe.reset();
      try { source.stop(); } catch {}
      try { await ctx.close(); } catch {}
      return peak;
    };
    return { muted: await measure(true), audible: await measure(false) };
  })()`);
  assert(control.muted === 0,
    `the probe measured ${control.muted} through an output muted to zero: it is tapping upstream of the app's gain, so "it sounded" is not a claim it can support`);
  assert(control.audible > 0.3,
    `the probe measured only ${control.audible} from an audible graph, so a quiet reading cannot be trusted either`);
  console.log(`  muted output -> peak ${control.muted}; audible output -> peak ${control.audible.toFixed(3)}`);
}

async function checkPromptAndShareable(base) {
  console.log('--- 2. a launch of /#instant loads the app, blasts, and keeps the URL ---');
  const browser = await launch({ autoplay: true, label: 'launch' });
  try {
    await checkProbeIntegrity(browser);
    // A blank page first, so the next navigation is a real, cold document load -
    // exactly what an OS shortcut launch does in a fresh window.
    await browser.navigate('about:blank', { wait: 50 });
    await browser.navigate(`${base}/#instant`);
    const instant = await browser.waitFor((s) => s.booted && s.peak > 0.3,
      { label: 'the /#instant blast', timeout: 8000 });

    assert(instant.booted, `/#instant did not boot the app (href ${instant.href})`);
    assert(instant.hash === '#instant',
      `the URL after a #instant launch is ${instant.href}; the deep link must survive so it can be shared`);
    assert(instant.pressed === 'true' && instant.horning,
      `/#instant did not light the horn up: aria-pressed=${instant.pressed}, horning=${instant.horning}`);
    // Exactly one: the platform reports the cold launch through the queue as well,
    // and the load handler has already served the URL (airhorn-lw9).
    assert(instant.starts === 1,
      `/#instant started ${instant.starts} source(s), expected exactly 1 (a cold launch is reported twice: URL + launch queue)`);
    assert(instant.peak > 0.3,
      `/#instant produced no audio (peak ${instant.peak.toFixed(4)}, ctx ${instant.ctxState})`);
    assert(instant.ctxState === 'running', `/#instant ran the graph in state ${instant.ctxState}`);
    assert(instant.errors.length === 0, `/#instant logged ${JSON.stringify(instant.errors)}`);
    console.log(`  blasted: starts=${instant.starts} peak=${instant.peak.toFixed(3)} ctx=${instant.ctxState} hash=${instant.hash}`);

    console.log('--- 3. reloading that shared URL blasts again ---');
    await browser.send('Page.reload', {});
    const reloaded = await browser.waitFor((s) => s.booted && s.peak > 0.3,
      { label: 'the shared URL to blast again on reload', timeout: 8000 });
    assert(reloaded.starts === 1 && reloaded.peak > 0.3,
      `reloading ${reloaded.href} did not blast again (starts ${reloaded.starts}, peak ${reloaded.peak.toFixed(4)})`);
    assert(reloaded.pressed === 'true', 'after a reload of the shared URL the horn should be lit');
    await browser.evaluate('window.__airhorn.stop({ immediate: true })');
    console.log(`  shared URL reloads and blasts: starts=${reloaded.starts} peak=${reloaded.peak.toFixed(3)}`);

    console.log('--- 4. a second launch while the app is already on #instant ---');
    // launch_handler: focus-existing reuses the existing window; a navigation to
    // the URL it is already on is a no-op, so nothing re-triggers. Recorded as a
    // documented limitation rather than a failure: the horn is at rest and the
    // UI is consistent, which is what the bead asks of the negatives.
    const again = await browser.navigate(`${base}/#instant`, { wait: 700 });
    assert(again.starts === reloaded.starts,
      `a same-URL navigation restarted the horn (starts ${reloaded.starts} -> ${again.starts}); behaviour changed, update this suite and the manifest's launch_handler note`);
    assert(again.pressed === 'false' && again.playing === false,
      `after a same-URL navigation the horn is ${again.pressed}/${again.playing}, expected at rest`);
    console.log('  second launch on the identical URL is a no-op (focus-existing), horn at rest');

    console.log('--- 4b. a repeat launch re-fires the deep link (airhorn-hlg) ---');
    // The case the product call is about: the window is already on #instant, and
    // a second press of the shortcut must fire again rather than be swallowed as
    // a duplicate. The same-URL navigation above is a no-op; the launch queue is
    // the signal that says "this was a real press".
    const queue = await browser.evaluate('({ source: window.__launchQueueSource, hasConsumer: typeof window.__launchConsumer === "function" })');
    assert(queue.hasConsumer, `the page registered no launch consumer, so a repeat launch cannot re-fire (launchQueue: ${queue.source})`);
    const beforeLaunch = await browser.snapshot();
    await browser.evaluate(`window.__probe.reset(); window.__fireLaunch(${JSON.stringify(base + '/#instant')}); 1`);
    const relaunched = await browser.waitFor((s) => s.peak > 0.3, { label: 'the repeat launch to blast', timeout: 8000 });
    assert(relaunched.starts > beforeLaunch.starts,
      `a repeat launch did not start anything (starts ${beforeLaunch.starts} -> ${relaunched.starts})`);
    assert(relaunched.pressed === 'true' && relaunched.playing === true,
      `a repeat launch left the horn unpressed/unplaying (aria-pressed ${relaunched.pressed}, playing ${relaunched.playing})`);
    assert(relaunched.hash === '#instant', `a repeat launch moved the URL to ${relaunched.href}`);
    console.log(`  repeat launch blasted again (${queue.source} queue): starts ${beforeLaunch.starts} -> ${relaunched.starts}, peak ${relaunched.peak.toFixed(3)}`);

    // A launch that is not the instant deep link must not sound the horn. Wait
    // for the repeat blast to finish ringing out first - otherwise the previous
    // source's tail is still in the analyser window and "peak stayed low" says
    // nothing about the launch being tested (the gate caught exactly that).
    await browser.waitFor((s) => s.playing === false, { label: 'the repeat blast to finish', timeout: 8000 });
    await browser.evaluate(`window.__probe.reset(); window.__fireLaunch(${JSON.stringify(base + '/')}); 1`);
    await browser.sleep(700);
    const otherLaunch = await browser.snapshot();
    // Not "exactly 0": the previous blast's ring-out can leave a sliver in the
    // analyser window. Anything below the blast threshold means nothing sounded.
    assert(otherLaunch.peak < 0.05 && otherLaunch.starts === relaunched.starts,
      `a launch of / sounded the horn (peak ${otherLaunch.peak.toFixed(6)}, starts ${relaunched.starts} -> ${otherLaunch.starts})`);
    assert(otherLaunch.hash === '#instant', `a launch of / moved the URL to ${otherLaunch.href}`);

    console.log('--- 5. an unknown hash: nothing blasts, the horn still works ---');
    await browser.navigate('about:blank', { wait: 50 });
    await browser.navigate(`${base}/#nonsense`);
    const unknown = await browser.waitFor((s) => s.booted, { label: '/#nonsense to boot', timeout: 8000 });
    // A bounded quiet window: long enough that a blast would have started.
    await browser.sleep(700);
    Object.assign(unknown, await browser.snapshot());
    assert(unknown.booted, '/#nonsense did not load the app');
    assert(unknown.hash === '#nonsense', `an unknown hash was rewritten to ${unknown.href}`);
    assert(unknown.starts === 0 && unknown.pressed === 'false',
      `/#nonsense acted on the horn: starts=${unknown.starts}, aria-pressed=${unknown.pressed}`);
    const afterUnknown = await browser.press(300);
    assert(afterUnknown.during.peak > 0.3 && afterUnknown.during.pressed === 'true',
      `the horn did not work after an unknown hash (peak ${afterUnknown.during.peak.toFixed(4)}, aria-pressed ${afterUnknown.during.pressed})`);
    assert(afterUnknown.after.horning === false,
      'the horn stayed in .horning after release following an unknown hash');
    console.log(`  unknown hash ignored; press afterwards played (peak ${afterUnknown.during.peak.toFixed(3)})`);

    console.log('--- 6. shortcut, then a normal navigation ---');
    await browser.navigate(`${base}/#instant`);
    await browser.waitFor((s) => s.peak > 0.3, { label: 'the #instant blast before navigating away', timeout: 8000 });
    const toRoot = await browser.navigate(`${base}/`, { wait: 900 });
    assert(toRoot.booted, 'navigating from #instant to / did not leave a working app');
    assert(toRoot.hash === '' && toRoot.pressed === 'false',
      `after #instant -> / the page was ${toRoot.href} with aria-pressed=${toRoot.pressed}`);
    assert(toRoot.starts === 0, `navigating to / started ${toRoot.starts} source(s) without the shortcut`);
    const afterRoot = await browser.press(300);
    assert(afterRoot.during.peak > 0.3, `the horn did not work after #instant -> / (peak ${afterRoot.during.peak.toFixed(4)})`);
    console.log('  / after a shortcut: no stray blast, horn works');

    console.log('--- 7. shortcut while offline ---');
    // Warm the worker, then go offline and COLD load the shortcut URL.
    await browser.navigate(`${base}/`, { wait: 1200 });
    await browser.evaluate('window.__airhorn.stop({ immediate: true })');
    await browser.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await browser.navigate('about:blank', { wait: 50 });
    await browser.navigate(`${base}/#instant`);
    const offline = await browser.waitFor((s) => s.booted && s.peak > 0.3,
      { label: 'the offline #instant blast', timeout: 9000 });
    assert(offline.onLine === false, 'offline emulation did not take effect');
    assert(offline.booted && offline.controlled,
      `the shortcut URL offline did not come from the worker (booted=${offline.booted}, controlled=${offline.controlled})`);
    assert(offline.hash === '#instant', `the offline shortcut URL became ${offline.href}`);
    assert(offline.starts === 1 && offline.peak > 0.3,
      `the offline shortcut did not blast (starts ${offline.starts}, peak ${offline.peak.toFixed(4)})`);
    assert(offline.fallback === false,
      'the offline blast used the synthesised fallback: the sample should be precached');
    assert(offline.errors.length === 0, `the offline shortcut logged ${JSON.stringify(offline.errors)}`);
    console.log(`  offline #instant: worker-served, real sample, peak=${offline.peak.toFixed(3)}`);
    await browser.evaluate('window.__airhorn.stop({ immediate: true })');

    console.log('--- 8. unknown hash while offline ---');
    await browser.navigate('about:blank', { wait: 50 });
    await browser.navigate(`${base}/#nonsense`);
    const offlineUnknown = await browser.waitFor((s) => s.booted, { label: 'offline /#nonsense to boot', timeout: 9000 });
    await browser.sleep(700);
    const offlineUnknownSettled = await browser.snapshot();
    Object.assign(offlineUnknown, offlineUnknownSettled);
    assert(offlineUnknown.booted && offlineUnknown.starts === 0 && offlineUnknown.pressed === 'false',
      `offline /#nonsense did not settle at rest (booted=${offlineUnknown.booted}, starts=${offlineUnknown.starts}, aria-pressed=${offlineUnknown.pressed})`);
    const offlinePress = await browser.press(300);
    assert(offlinePress.during.peak > 0.3, `the horn did not work offline after an unknown hash (peak ${offlinePress.during.peak.toFixed(4)})`);
    console.log('  offline unknown hash: at rest, horn still works');
    await browser.setOffline(false);
  } finally {
    await browser.close();
  }
}

async function checkBlockedAutoplay(base) {
  console.log('--- 9. the same deep link in an ordinary tab (autoplay blocked) ---');
  const browser = await launch({ autoplay: false, label: 'blocked' });
  try {
    await browser.navigate('about:blank', { wait: 50 });
    await browser.navigate(`${base}/#instant`);
    const blocked = await browser.waitFor((s) => s.booted, { label: 'the blocked /#instant to boot', timeout: 9000 });
    // Give it as long as a blast would take to be observable, so "silent" is
    // measured rather than assumed.
    await browser.sleep(1200);
    Object.assign(blocked, await browser.snapshot());

    const audible = blocked.peak > 0.3 && blocked.ctxState === 'running';
    // The launch disabled autoplay, so audible playback means the environment
    // ignored it - that is a loud failure, not a reason to skip the contract
    // (the old else-branch read green while asserting nothing; airhorn-tuuq S6).
    assert(!audible,
      `/#instant was given no autoplay permission but audio ran anyway (ctx ${blocked.ctxState}, peak ${blocked.peak.toFixed(4)}) - the test environment, not the app, is broken`);
    // The one thing that must never happen: the page says it is playing while
    // the graph is suspended and nothing can be heard.
    assert(blocked.pressed === 'false' && blocked.horning === false,
      `/#instant in a tab without audio activation claims to be playing: aria-pressed=${blocked.pressed}, .horning=${blocked.horning}, ctx=${blocked.ctxState}, peak=${blocked.peak.toFixed(4)}`);
    assert(blocked.playing === false,
      `/#instant in a tab without audio activation reports isPlaying()=true while silent (ctx ${blocked.ctxState})`);
    assert(blocked.starts === 0,
      `/#instant scheduled ${blocked.starts} source(s) into a suspended context: a delayed blast when the context resumes`);
    console.log(`  blocked as expected (ctx ${blocked.ctxState}), and the page did not claim to play`);

    // Silence must not read as broken (airhorn-hlg): the page says what is
    // wrong through its one polite live region, and the horn - a real button -
    // is the focused next action.
    assert(/tap/i.test(blocked.status),
      `a blocked deep link said nothing: #app-status is ${JSON.stringify(blocked.status)}`);
    assert(/horn/.test(blocked.active),
      `the horn is not the focused next action after a blocked deep link (active element class ${JSON.stringify(blocked.active)})`);
    console.log(`  announced ${JSON.stringify(blocked.status)} and focused the horn`);

    // And the first real press must still work - a silent deep link is a page
    // that has not been touched, not a broken one.
    const first = await browser.press(400);
    assert(first.during.peak > 0.3,
      `the first press after a blocked deep link produced no sound (peak ${first.during.peak.toFixed(4)}, ctx ${first.during.ctxState})`);
    assert(first.during.pressed === 'true', 'the first press after a blocked deep link did not light the horn');
    assert(first.after.horning === false, 'the horn stayed lit after release');
    // The hint must not outlive the problem it described.
    assert(!/tap/i.test(first.after.status),
      `the "needs a tap" hint stayed after the horn played: ${JSON.stringify(first.after.status)}`);
    console.log(`  first press played (peak ${first.during.peak.toFixed(3)}, ctx ${first.during.ctxState}) and cleared the hint`);

    // A newer message outranks a stale hint (airhorn-xsu): clearing the hint must
    // not wipe whatever replaced it in the one live region.
    await browser.evaluate(`document.getElementById('app-status').textContent = 'Back online.'; 1`);
    const second = await browser.press(400);
    assert(second.during.peak > 0.3, `the horn did not play after the hint was replaced (peak ${second.during.peak.toFixed(4)})`);
    assert(second.after.status === 'Back online.',
      `a successful start wiped a newer status message: ${JSON.stringify(second.after.status)}`);
  } finally {
    await browser.close();
  }
}

async function run() {
  if (!fs.existsSync(DIST)) {
    throw new Error('dist directory does not exist. Run build first.');
  }
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await checkManifest();
    await checkPromptAndShareable(base);
    await checkBlockedAutoplay(base);
    console.log('\nSHORTCUT VERIFICATION PASSED');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((error) => {
  console.error('SHORTCUT VERIFICATION FAILED:', error.message);
  process.exitCode = 1;
});
