import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = '/tmp/airhorn-boot-watchdog';

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

// Drives the built app (dist/) in headless Chrome over raw CDP and verifies
// the boot surfaces from airhorn-quk:
//   1. healthy boot never shows the boot-failure banner (no false positive);
//   2. a blocked module bundle (filter/proxy) reveals the banner + retry;
//   3. a corrupt module body (cache poisoning) reveals the banner;
//   4. with scripting disabled the <noscript> notice is visible.
// Screenshots land in /tmp/airhorn-boot-watchdog/ as evidence.
async function testBootWatchdog() {
  const distDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run build first.');
  }
  fs.rmSync(EVIDENCE_DIR, { recursive: true, force: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  const server = http.createServer((req, res) => {
    const reqUrl = req.url.split('?')[0];
    // The page registers /sw.js unconditionally; serve a no-op stub so the
    // registration succeeds without caching or intercepting anything. The
    // cases below must hit the network (or CDP interception), not a cache.
    if (reqUrl === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('// boot-watchdog suite: no-op service worker stub\n');
      return;
    }
    let filePath = path.join(distDir, reqUrl === '/' ? 'index.html' : reqUrl);
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

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const chromeBin = process.env.CHROME_BIN ||
    (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
    fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' :
    fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : 'google-chrome');

  const profileDir = '/tmp/chrome-boot-watchdog-profile-' + Date.now();
  const chrome = spawn(chromeBin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let wsUrl = null;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome timeout')), 10000);
    chrome.stderr.on('data', (d) => {
      const match = d.toString().match(/ws:\/\/[^\s]+/);
      if (match) {
        wsUrl = match[0];
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  const chromePort = new URL(wsUrl).port;
  const targetsRes = await fetch(`http://127.0.0.1:${chromePort}/json/list`);
  const targets = await targetsRes.json();
  const pageWsUrl = targets.find(t => t.type === 'page').webSocketDebuggerUrl;

  const ws = new WebSocket(pageWsUrl);
  await new Promise(r => ws.onopen = r);

  let msgId = 1;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Fetch.requestPaused') {
      const { requestId } = msg.params;
      const body = Buffer.from('this is not javascript %%').toString('base64');
      ws.send(JSON.stringify({
        id: msgId++,
        method: 'Fetch.fulfillRequest',
        params: {
          requestId,
          responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }],
          body,
        },
      }));
      return;
    }
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
    const res = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (res.exceptionDetails) {
      throw new Error(`evaluate failed: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`);
    }
    return res.result.value;
  };

  // Poll a page expression until truthy. Evaluation errors (context not yet
  // ready mid-navigation) are retried, not fatal.
  const waitUntil = async (expression, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (await evaluate(expression)) return;
      } catch {}
      if (Date.now() > deadline) {
        let last = null;
        try { last = await evaluate(expression); } catch {}
        throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label} (last value: ${last})`);
      }
      await new Promise(r => setTimeout(r, 100));
    }
  };

  const shot = async (name) => {
    const res = await send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(EVIDENCE_DIR, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    console.log(`  evidence: ${file}`);
  };

  try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Network.enable');

    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__pageErrors = [];
        window.addEventListener('error', (e) => {
          window.__pageErrors.push(e.message || (e.error ? e.error.message : String(e)));
        });
      `
    });

    // --- Case 1: healthy boot must stay silent --------------------------------
    console.log('--- Case 1: healthy boot, banner must stay hidden');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitUntil('typeof window.__airhorn !== "undefined"', 8000, 'app to boot');
    // Painted invisibility is the assertion, not the hidden attribute: the
    // card's own display value once beat the UA [hidden] rule (caught by the
    // noscript screenshot), so check layout and computed display.
    const bannerHiddenExpr = `(() => {
      const el = document.getElementById('boot-failure');
      return el.hidden === true && el.getClientRects().length === 0
        && getComputedStyle(el).display === 'none';
    })()`;
    if ((await evaluate(bannerHiddenExpr)) !== true) {
      throw new Error('Boot-failure banner visible on a healthy boot');
    }
    // The watchdog arms on load + 2s grace; wait past the grace and re-check.
    await new Promise(r => setTimeout(r, 3500));
    if ((await evaluate(bannerHiddenExpr)) !== true) {
      throw new Error('Boot-failure banner appeared after the grace period on a healthy boot');
    }
    if ((await evaluate(`window.__pageErrors.length`)) !== 0) {
      throw new Error(`Unexpected page errors on healthy boot: ${JSON.stringify(await evaluate('window.__pageErrors'))}`);
    }
    console.log('  healthy boot: no banner, no errors');

    // --- Case 2: blocked module bundle ----------------------------------------
    console.log('--- Case 2: module bundle blocked (filter/proxy)');
    await send('Network.setBlockedURLs', { urls: ['*assets/*.js', '*src/main.js*'] });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitUntil(`!document.getElementById('boot-failure').hidden`, 10000, 'blocked-bundle banner to appear');
    const blocked = await evaluate(`(() => {
      const banner = document.getElementById('boot-failure');
      const retry = document.getElementById('boot-retry');
      return {
        role: banner.getAttribute('role'),
        text: banner.textContent.trim(),
        retryPresent: !!retry && !retry.disabled,
        hornPresent: !!document.querySelector('.horn'),
        booted: typeof window.__airhorn !== 'undefined',
        noscriptVisible: (() => {
          const el = document.querySelector('noscript .boot-alert');
          return !!el && el.getClientRects().length > 0;
        })(),
      };
    })()`);
    if (blocked.role !== 'alert') throw new Error(`banner role: ${JSON.stringify(blocked.role)}`);
    if (!/silent/i.test(blocked.text)) throw new Error(`banner text does not explain the failure: ${JSON.stringify(blocked.text)}`);
    if (!blocked.retryPresent) throw new Error('retry button missing or disabled');
    if (!blocked.hornPresent) throw new Error('horn missing from the blocked page');
    if (blocked.booted) throw new Error('window.__airhorn exists although the bundle was blocked');
    if (blocked.noscriptVisible) throw new Error('noscript notice visible while JavaScript runs');
    await shot('blocked-bundle');
    console.log('  blocked bundle: banner + retry shown, horn present, app not booted');
    await send('Network.setBlockedURLs', { urls: [] });

    // --- Case 3: corrupt module body (cache poisoning equivalent) -------------
    console.log('--- Case 3: module bundle served corrupt');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*assets/*.js', requestStage: 'Request' }] });
    // Every paused request is fulfilled with a corrupt body by the
    // Fetch.requestPaused branch in onmessage above.
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitUntil(`!document.getElementById('boot-failure').hidden`, 10000, 'corrupt-bundle banner to appear');
    const corrupt = await evaluate(`(() => ({
      booted: typeof window.__airhorn !== 'undefined',
      retryPresent: !!document.getElementById('boot-retry') && !document.getElementById('boot-retry').disabled,
    }))()`);
    if (corrupt.booted) throw new Error('window.__airhorn exists although the bundle was corrupt');
    if (!corrupt.retryPresent) throw new Error('retry button missing on corrupt bundle');
    await shot('corrupt-bundle');
    console.log('  corrupt bundle: banner shown, app not booted');
    await send('Fetch.disable');

    // --- Case 4: scripting disabled -> noscript notice -------------------------
    console.log('--- Case 4: JavaScript disabled, noscript notice');
    await send('Emulation.setScriptExecutionDisabled', { value: true });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await new Promise(r => setTimeout(r, 1500));
    const noscript = await evaluate(`(() => {
      const el = document.querySelector('noscript .boot-alert');
      const banner = document.getElementById('boot-failure');
      return {
        present: !!el,
        visible: !!el && el.getClientRects().length > 0,
        text: el ? el.textContent.trim() : null,
        bannerPaintedAway: !banner || (banner.getClientRects().length === 0
          && getComputedStyle(banner).display === 'none'),
      };
    })()`);
    if (!noscript.present) throw new Error('noscript notice missing from the DOM with scripting disabled');
    if (!noscript.visible) throw new Error('noscript notice not visible with scripting disabled');
    if (!/JavaScript/i.test(noscript.text)) throw new Error(`noscript text does not mention JavaScript: ${JSON.stringify(noscript.text)}`);
    if (!noscript.bannerPaintedAway) throw new Error('boot-failure banner painted although it carries hidden and no JS can reveal it');
    await shot('noscript');
    console.log('  noscript: notice visible, explains JavaScript requirement');
    await send('Emulation.setScriptExecutionDisabled', { value: false });

    console.log('ALL BOOT WATCHDOG CHECKS PASSED!');
  } finally {
    chrome.kill('SIGTERM');
    server.close();
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  }
}

testBootWatchdog().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
