import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quiescenceProbe, waitForQuiescence, lateErrorMutant } from './support/quiescence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Simple static server for dist
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

async function run() {
  const distDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(distDir)) {
    throw new Error('dist directory does not exist. Run build first.');
  }

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

  let chrome = null;
  try {
    const chromeBin = process.env.CHROME_BIN ||
      (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
      fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' :
      fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : 'google-chrome');

    chrome = spawn(chromeBin, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=0',
      '--user-data-dir=/tmp/chrome-test-profile-' + Date.now(),
      'about:blank'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let wsUrl = null;
    const stderrLines = [];

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Chrome start timeout: ' + stderrLines.join('\n'))), 10000);
      chrome.stderr.on('data', (data) => {
        const text = data.toString();
        stderrLines.push(text);
        const match = text.match(/ws:\/\/[^\s]+/);
        if (match) {
          wsUrl = match[0];
          clearTimeout(timeout);
          resolve();
        }
      });
      chrome.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    console.log(`Chrome started, wsUrl: ${wsUrl}`);

    const chromePort = new URL(wsUrl).port;
    const targetsRes = await fetch(`http://127.0.0.1:${chromePort}/json/list`);
    const targets = await targetsRes.json();
    const pageTarget = targets.find(t => t.type === 'page');
    const pageWsUrl = pageTarget.webSocketDebuggerUrl;
    console.log(`Chrome page target wsUrl: ${pageWsUrl}`);

    // Connect via WebSocket to Page target
    const ws = new WebSocket(pageWsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    const pending = new Map();
    const consoleMessages = [];

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.consoleAPICalled') {
        consoleMessages.push(msg.params);
      } else if (msg.method === 'Log.entryAdded') {
        if (msg.params.entry.level === 'error') {
          consoleMessages.push({ type: 'error', text: msg.params.entry.text });
        }
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params.exceptionDetails;
        const text = details?.exception?.description || details?.text || 'Uncaught exception';
        consoleMessages.push({
          type: 'error',
          text,
          exceptionDetails: details
        });
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };

    function send(method, params = {}) {
      const id = msgId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    // Enable domains
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('DOM.enable');
    await send('Accessibility.enable');

    // Track in-page errors and unhandled rejections
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__pageErrors = [];
        window.addEventListener('error', (e) => {
          window.__pageErrors.push({
            type: 'error',
            message: e.message || (e.error ? e.error.message : String(e)),
            filename: e.filename,
            lineno: e.lineno,
            stack: e.error ? e.error.stack : null
          });
        });
        window.addEventListener('unhandledrejection', (e) => {
          window.__pageErrors.push({
            type: 'unhandledrejection',
            message: e.reason?.message || String(e.reason),
            stack: e.reason?.stack || null
          });
        });
        ${quiescenceProbe}
      `
    });

    console.log('Navigating to test page...');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    
    // Wait for document to be ready and styles/CSS fully applied
    for (let i = 0; i < 50; i++) {
      const ready = await send('Runtime.evaluate', {
        expression: `document.readyState === 'complete' && !!document.querySelector('.horn') && window.getComputedStyle(document.body).backgroundColor === 'rgb(33, 150, 243)'`,
        returnByValue: true
      });
      if (ready.result.value) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // Evaluate checks
    const evalResult = await send('Runtime.evaluate', {
      expression: `(async () => {
        const horn = document.querySelector('.horn');
        const installer = document.getElementById('installer');
        const installerButton = installer ? installer.querySelector('button') : null;
        const styles = window.getComputedStyle(horn);
        const installerStyles = installer ? window.getComputedStyle(installer) : null;
        const isAvailable = installer.classList.contains('available');
        
        // Test hidden state without .available
        installer.style.transition = 'none';
        installer.classList.remove('available');
        void installer.offsetHeight;
        const csInst = window.getComputedStyle(installer);
        const hiddenVisibility = csInst.visibility;
        const hiddenPointerEvents = csInst.pointerEvents;
        installer.style.transition = '';
        if (isAvailable) {
          installer.classList.add('available');
        }

        return {
          hornTagName: horn ? horn.tagName : null,
          hornType: horn ? horn.type : null,
          hornAriaLabel: horn ? horn.getAttribute('aria-label') : null,
          hornAriaPressed: horn ? horn.getAttribute('aria-pressed') : null,
          hornRole: horn ? horn.getAttribute('role') : null,
          hornTabIndex: horn ? horn.getAttribute('tabindex') : null,
          hornCursor: styles.cursor,
          installerIsAvailable: isAvailable,
          installerVisibility: installerStyles ? installerStyles.visibility : null,
          installerPointerEvents: installerStyles ? installerStyles.pointerEvents : null,
          hiddenVisibility,
          hiddenPointerEvents,
          installerButtonTagName: installerButton ? installerButton.tagName : null,
          installerButtonType: installerButton ? installerButton.type : null,
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    console.log('DOM Evaluation Result:', evalResult.result.value);
    const r = evalResult.result.value;

    if (r.hornTagName !== 'BUTTON') {
      throw new Error(`Expected hornTagName to be BUTTON, got ${r.hornTagName}`);
    }
    if (r.hornType !== 'button') {
      throw new Error(`Expected hornType to be button, got ${r.hornType}`);
    }
    if (r.hornAriaLabel !== 'Air horn') {
      throw new Error(`Expected hornAriaLabel to be 'Air horn', got ${r.hornAriaLabel}`);
    }
    if (r.hornAriaPressed !== 'false') {
      throw new Error(`Expected hornAriaPressed to be 'false', got ${r.hornAriaPressed}`);
    }
    if (r.hornRole !== null) {
      throw new Error(`Expected redundant role attribute to be omitted, got ${r.hornRole}`);
    }
    if (r.hornTabIndex !== null) {
      throw new Error(`Expected redundant tabindex attribute to be omitted, got ${r.hornTabIndex}`);
    }
    if (r.hiddenVisibility !== 'hidden') {
      throw new Error(`Expected hiddenVisibility to be 'hidden', got ${r.hiddenVisibility}`);
    }
    if (r.hiddenPointerEvents !== 'none') {
      throw new Error(`Expected hiddenPointerEvents to be 'none', got ${r.hiddenPointerEvents}`);
    }

    // Test Accessibility Tree for the button
    const axTree = await send('Accessibility.getFullAXTree');
    const hornNode = axTree.nodes.find(n => n.name?.value === 'Air horn');
    console.log('Accessibility Node found:', {
      role: hornNode?.role?.value,
      name: hornNode?.name?.value,
      pressed: hornNode?.properties?.find(p => p.name === 'pressed')?.value?.value
    });

    if (!hornNode) {
      throw new Error('Accessibility node with name "Air horn" not found in AX tree');
    }
    if (hornNode.role?.value !== 'button') {
      throw new Error(`Expected AX role 'button', got ${hornNode.role?.value}`);
    }

    // Test keyboard focus (Tab key)
    console.log('Testing Tab key navigation...');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });

    const activeEl = await send('Runtime.evaluate', {
      expression: 'document.activeElement.className',
      returnByValue: true
    });
    console.log('Active element after Tab:', activeEl.result.value);
    if (!activeEl.result.value.includes('horn')) {
      throw new Error(`Expected activeElement to be .horn, got ${activeEl.result.value}`);
    }

    // Test Space key trigger
    console.log('Testing Space key press...');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space' });
    const duringSpace = await send('Runtime.evaluate', {
      expression: `({
        horning: document.querySelector('.horn').classList.contains('horning'),
        pressed: document.querySelector('.horn').getAttribute('aria-pressed')
      })`,
      returnByValue: true
    });
    console.log('State during Space keydown:', duringSpace.result.value);
    if (!duringSpace.result.value.horning || duringSpace.result.value.pressed !== 'true') {
      throw new Error('Horn did not enter horning state on Space keydown');
    }

    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space' });
    const afterSpace = await send('Runtime.evaluate', {
      expression: `({
        horning: document.querySelector('.horn').classList.contains('horning'),
        pressed: document.querySelector('.horn').getAttribute('aria-pressed')
      })`,
      returnByValue: true
    });
    console.log('State after Space keyup:', afterSpace.result.value);
    if (afterSpace.result.value.horning || afterSpace.result.value.pressed !== 'false') {
      throw new Error('Horn did not exit horning state on Space keyup');
    }

    // Test Enter key trigger
    console.log('Testing Enter key press...');
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
    const duringEnter = await send('Runtime.evaluate', {
      expression: `({
        horning: document.querySelector('.horn').classList.contains('horning'),
        pressed: document.querySelector('.horn').getAttribute('aria-pressed')
      })`,
      returnByValue: true
    });
    console.log('State during Enter keydown:', duringEnter.result.value);
    if (!duringEnter.result.value.horning || duringEnter.result.value.pressed !== 'true') {
      throw new Error('Horn did not enter horning state on Enter keydown');
    }

    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
    const afterEnter = await send('Runtime.evaluate', {
      expression: `({
        horning: document.querySelector('.horn').classList.contains('horning'),
        pressed: document.querySelector('.horn').getAttribute('aria-pressed')
      })`,
      returnByValue: true
    });
    console.log('State after Enter keyup:', afterEnter.result.value);
    if (afterEnter.result.value.horning || afterEnter.result.value.pressed !== 'false') {
      throw new Error('Horn did not exit horning state on Enter keyup');
    }

    // Test synthetic click (AT activation)
    console.log('Testing AT synthetic click...');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const clickResult = await send('Runtime.evaluate', {
      expression: `(() => {
        document.querySelector('.horn').click();
        return {
          horning: document.querySelector('.horn').classList.contains('horning'),
          pressed: document.querySelector('.horn').getAttribute('aria-pressed')
        };
      })()`,
      returnByValue: true
    });
    console.log('State on synthetic click:', clickResult.result.value);
    if (!clickResult.result.value.horning || clickResult.result.value.pressed !== 'true') {
      throw new Error('Horn did not enter horning state on synthetic click');
    }

    // Take screenshot evidence
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('/tmp/airhorn-a11y-verified.png', Buffer.from(screenshot.data, 'base64'));
    console.log('Screenshot saved to /tmp/airhorn-a11y-verified.png');

    // Wait for observed quiescence instead of sleeping for a guessed duration.
    // TEST_LATE_ERROR_MS injects a mutant: an async throw that lands after the
    // last interaction, through the same timer the app would use. The wait has to
    // see the pending timer, let it fire, and then the error check below fails.
    const lateErrorMs = Number(process.env.TEST_LATE_ERROR_MS || 0);
    if (lateErrorMs > 0) {
      console.log(`Injecting late error mutant: throw ${lateErrorMs}ms after the last interaction`);
      await send('Runtime.evaluate', { expression: lateErrorMutant(lateErrorMs) });
    }

    const settled = await waitForQuiescence(send, {
      // The blast from the synthetic click is still ringing out; wait for the
      // page's own state to finish rather than for a constant.
      quietExpression: `!document.querySelector('.horn.horning')`
    });
    console.log(
      `Page quiescent after ${settled.waitedMs}ms: ${settled.pending.scheduled} async task(s) ` +
      `scheduled, ${settled.pending.completed} completed, ${settled.samples} samples`
    );

    // Check for in-page unhandled exceptions or rejections
    const inPageErrors = await send('Runtime.evaluate', {
      expression: 'window.__pageErrors || []',
      returnByValue: true
    });
    if (inPageErrors.result.value && inPageErrors.result.value.length > 0) {
      throw new Error(`In-page errors detected: ${JSON.stringify(inPageErrors.result.value)}`);
    }

    // Check for any console errors or uncaught exceptions recorded via CDP
    console.log('Console messages recorded:', consoleMessages);
    const errors = consoleMessages.filter(m => m.type === 'error');
    if (errors.length > 0) {
      throw new Error(`Console errors or uncaught exceptions detected: ${JSON.stringify(errors)}`);
    }

    console.log('ALL VERIFICATION CHECKS PASSED!');
  } finally {
    if (chrome) {
      chrome.kill('SIGTERM');
    }
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
