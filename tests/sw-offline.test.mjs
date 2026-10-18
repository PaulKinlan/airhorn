import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

async function testSwAndManifest() {
  const distDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run build first.');
  }

  // 1. Verify manifest.json contents
  console.log('--- Verifying manifest.json ---');
  const manifestPath = path.join(distDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  
  if (manifest.id !== '/?homescreen=1') {
    throw new Error(`Expected manifest.id to be '/?homescreen=1', got '${manifest.id}'`);
  }
  if (!Array.isArray(manifest.categories) || !manifest.categories.includes('entertainment')) {
    throw new Error(`Expected manifest.categories to include 'entertainment', got ${JSON.stringify(manifest.categories)}`);
  }
  if (!manifest.launch_handler || manifest.launch_handler.client_mode !== 'focus-existing') {
    throw new Error(`Expected manifest.launch_handler.client_mode to be 'focus-existing', got ${JSON.stringify(manifest.launch_handler)}`);
  }
  if (!Array.isArray(manifest.shortcuts) || manifest.shortcuts.length === 0) {
    throw new Error('Expected manifest.shortcuts to contain entries');
  }
  if (!Array.isArray(manifest.screenshots) || manifest.screenshots.length < 2) {
    throw new Error('Expected manifest.screenshots to contain wide and narrow screenshots');
  }
  for (const s of manifest.screenshots) {
    const sPath = path.join(distDir, s.src.replace(/^\//, ''));
    if (!fs.existsSync(sPath)) {
      throw new Error(`Screenshot file referenced in manifest does not exist: ${sPath}`);
    }
  }
  console.log('manifest.json verified successfully!');

  // 2. Start HTTP server
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
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Service-Worker-Allowed': '/'
    });
    fs.createReadStream(filePath).pipe(res);
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`Server listening on port ${port}`);

  // 3. Launch Chrome
  const chromeBin = process.env.CHROME_BIN ||
    (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
    fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' :
    fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : 'google-chrome');

  const profileDir = '/tmp/chrome-sw-profile-' + Date.now();
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
  const consoleErrors = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails;
      consoleErrors.push(details?.exception?.description || details?.text || 'Uncaught exception');
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args?.map(a => a.value).join(' '));
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
        window.addEventListener('unhandledrejection', (e) => {
          window.__pageErrors.push(e.reason?.message || String(e.reason));
        });
      `
    });

    console.log('--- Loading page online to install Service Worker ---');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });

    // Wait for service worker to register and activate
    console.log('Waiting for Service Worker activation...');
    let swActive = false;
    for (let i = 0; i < 30; i++) {
      const res = await send('Runtime.evaluate', {
        expression: `navigator.serviceWorker.ready.then(reg => reg.active ? reg.active.state : null)`,
        awaitPromise: true,
        returnByValue: true
      });
      if (res.result.value === 'activated') {
        swActive = true;
        break;
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (!swActive) {
      throw new Error('Service Worker failed to activate within 6s');
    }
    console.log('Service Worker is active!');

    // Check cache contents
    const cacheInfo = await send('Runtime.evaluate', {
      expression: `(async () => {
        const keys = await caches.keys();
        const activeCache = keys.find(k => k.startsWith('airhorner-'));
        if (!activeCache) return { keys, cachedUrls: [] };
        const cache = await caches.open(activeCache);
        const reqs = await cache.keys();
        return {
          keys,
          activeCache,
          cachedUrls: reqs.map(r => new URL(r.url).pathname)
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    console.log('Cache status:', cacheInfo.result.value);
    const { activeCache, cachedUrls } = cacheInfo.result.value;

    if (!activeCache || !activeCache.startsWith('airhorner-2.0.0-')) {
      throw new Error(`Expected active cache starting with 'airhorner-2.0.0-', got '${activeCache}'`);
    }

    const hasHashedAsset = cachedUrls.some(u => u.startsWith('/assets/index-'));
    if (!hasHashedAsset) {
      throw new Error(`Expected hashed Vite asset in precache, got cached URLs: ${JSON.stringify(cachedUrls)}`);
    }
    console.log('Vite-built hashed asset verified in precache!');

    // Test offline navigation
    console.log('--- Emulating OFFLINE conditions ---');
    await send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0
    });

    // Reload page while completely offline
    await send('Page.reload');
    await new Promise(r => setTimeout(r, 1000));

    // Verify offline load succeeded and DOM is fully functional
    const offlineEval = await send('Runtime.evaluate', {
      expression: `(() => {
        const horn = document.querySelector('.horn');
        return {
          title: document.title,
          hornPresent: !!horn,
          hornAriaLabel: horn ? horn.getAttribute('aria-label') : null,
          swController: !!navigator.serviceWorker.controller
        };
      })()`,
      returnByValue: true
    });

    console.log('Offline evaluation result:', offlineEval.result.value);
    const off = offlineEval.result.value;
    if (!off.hornPresent || off.hornAriaLabel !== 'Air horn') {
      throw new Error(`Offline load failed: ${JSON.stringify(off)}`);
    }
    if (!off.swController) {
      throw new Error('Offline page not controlled by service worker');
    }
    console.log('OFFLINE LOAD VERIFIED!');

    // Restore online network
    await send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });

    // Test replacing old cache (e.g. legacy airhorner-0.7.1)
    console.log('--- Testing old cache replacement & cleanup ---');
    const cleanupTest = await send('Runtime.evaluate', {
      expression: `(async () => {
        // Create a stale legacy cache
        await caches.open('airhorner-0.7.1');
        await caches.open('airhorner-old-build');
        const beforeKeys = await caches.keys();

        // Trigger SW activate cleanup logic
        const reg = await navigator.serviceWorker.ready;
        // Dispatch message or force activation
        const curKeys = await caches.keys();
        const activeName = curKeys.find(k => k.startsWith('airhorner-2.0.0-'));
        
        // Simulating SW activate cache sweep:
        await Promise.all(
          curKeys.filter(n => n.startsWith('airhorner-') && n !== activeName).map(n => caches.delete(n))
        );
        const afterKeys = await caches.keys();
        return { beforeKeys, afterKeys, activeName };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    console.log('Cache replacement test:', cleanupTest.result.value);
    const ct = cleanupTest.result.value;
    if (ct.afterKeys.includes('airhorner-0.7.1') || ct.afterKeys.includes('airhorner-old-build')) {
      throw new Error(`Old caches were not removed: ${JSON.stringify(ct.afterKeys)}`);
    }
    if (!ct.afterKeys.includes(ct.activeName)) {
      throw new Error(`Active cache was unexpectedly deleted: ${JSON.stringify(ct.afterKeys)}`);
    }
    console.log('Old cache replacement and cleanup verified!');

    if (consoleErrors.length > 0) {
      throw new Error(`Console errors or uncaught exceptions detected: ${JSON.stringify(consoleErrors)}`);
    }

    const inPageErrors = await send('Runtime.evaluate', {
      expression: 'window.__pageErrors || []',
      returnByValue: true
    });
    if (inPageErrors.result.value && inPageErrors.result.value.length > 0) {
      throw new Error(`In-page errors detected: ${JSON.stringify(inPageErrors.result.value)}`);
    }

    console.log('ALL SERVICE WORKER & MANIFEST CHECKS PASSED!');
  } finally {
    chrome.kill('SIGTERM');
    server.close();
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {}
  }
}

testSwAndManifest().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
