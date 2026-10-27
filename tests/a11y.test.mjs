import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quiescenceProbe, waitForQuiescence, lateErrorMutant } from './support/quiescence.mjs';
import { launchBrowser } from './support/browser.mjs';
import { awaitSocketOpen } from './cdp-command-bound.mjs';

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

  let browser = null;
  try {
    browser = await launchBrowser({ label: 'a11y', timeoutMs: 15000 });

    console.log(`Chrome started, wsUrl: ${browser.browserWsUrl}`);
    const pageWsUrl = browser.pageWsUrl;
    console.log(`Chrome page target wsUrl: ${pageWsUrl}`);

    // Connect via WebSocket to Page target
    const ws = new WebSocket(pageWsUrl);
    // Bounded (airhorn-eabw): an unbounded onopen await parks the suite if the
    // socket never opens; this also rejects on error/close so the refusal is named.
    await awaitSocketOpen(ws, { url: pageWsUrl });

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
    
    // Wait for the built page to be running with its stylesheet applied. This
    // used to fall through silently after 5s, so a slow load (other lanes'
    // browsers share this VM) left the suite asserting against an unstyled page -
    // where there is no boundary ring at all, and the old guard still passed.
    // The condition avoids colours so it does not depend on the colour scheme:
    // `border-radius: 50%` on the horn only comes from the stylesheet.
    let pageReady = false;
    for (let i = 0; i < 150; i++) {
      const ready = await send('Runtime.evaluate', {
        expression: `document.readyState === 'complete' && (() => {
          const horn = document.querySelector('.horn');
          return !!horn && window.getComputedStyle(horn).borderRadius !== '0px';
        })()`,
        returnByValue: true
      });
      if (ready.result.value) { pageReady = true; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    if (!pageReady) {
      throw new Error(
        'Page never became ready: no complete page with the stylesheet applied within 15s ' +
        '(unstyled page cannot prove anything about the horn boundary ring)'
      );
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
          hornOutlineColor: styles.outlineColor,
          hornOutlineWidth: styles.outlineWidth,
          hornOutlineStyle: styles.outlineStyle,
          bodyBackground: window.getComputedStyle(document.body).backgroundColor,
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

    // WCAG 1.4.11 Non-text Contrast: the horn's boundary ring must clear 3:1
    // against the page background (red on blue alone is 1.18:1). Shared function
    // used for both the clean pass and negative controls (airhorn-8e5).
    const checkHornBoundaryContrast = ({ hornOutlineStyle, hornOutlineWidth, hornOutlineColor, bodyBackground }) => {
      // Width alone proves nothing: Chrome reports the outline's INITIAL values when
      // nothing is painted, so a removed ring still measures 3px ("medium") and its
      // colour reads as currentColor, which happens to clear 3:1 on this background
      // (airhorn-29y). Assert the outline is actually painted, with a visible colour.
      if (!hornOutlineStyle || hornOutlineStyle === 'none' || hornOutlineStyle === 'hidden') {
        throw new Error(
          `Expected the horn boundary ring to be painted, got outline-style '${hornOutlineStyle}' ` +
          `(width '${hornOutlineWidth}' is the initial value, not a drawn ring)`
        );
      }
      if (parseFloat(hornOutlineWidth) < 1) {
        throw new Error(`Expected horn outline width >= 1px, got ${hornOutlineWidth}`);
      }
      // An opaque `rgb(r, g, b)` carries no alpha: its last component is the blue
      // channel, so reading it as alpha falsely rejected a valid black ring
      // (airhorn-gg8 - black on this page is 6.72:1, which the contrast check above
      // already accepts). Only a 4-component rgba(), or a slash-separated alpha in
      // the modern notation, actually expresses transparency.
      const alphaOf = (color) => {
        const text = String(color).trim();
        const comma = /^rgba?\(([^)]*)\)$/i.exec(text);
        // Space-separated modern notation also matches the `rgb(...)` shape, so only
        // treat it as the legacy form when it really is comma-separated.
        if (comma && comma[1].includes(',')) {
          const parts = comma[1].split(',').map((v) => parseFloat(v));
          return parts.length === 4 && Number.isFinite(parts[3]) ? parts[3] : 1;
        }
        const slash = /\(\s*[^)]*\/\s*([\d.]+)(%?)\s*\)$/.exec(text);
        if (slash) {
          const value = parseFloat(slash[1]);
          return slash[2] === '%' ? value / 100 : value;
        }
        return 1; // unknown notation: never invent transparency
      };
      if (alphaOf(hornOutlineColor) === 0) {
        throw new Error(
          `Expected a visible horn boundary ring, got a fully transparent outline colour ${hornOutlineColor}`
        );
      }
      const relLum = (rgb) => {
        const [cr, cg, cb] = rgb.match(/[\d.]+/g).map(Number).map((v) => {
          const s = v / 255;
          return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
      };
      const outlineLum = relLum(hornOutlineColor);
      const pageLum = relLum(bodyBackground);
      const boundaryRatio = (Math.max(outlineLum, pageLum) + 0.05) / (Math.min(outlineLum, pageLum) + 0.05);
      if (boundaryRatio < 3) {
        throw new Error(`Expected horn boundary contrast >= 3:1, got ${boundaryRatio.toFixed(2)}:1 (${hornOutlineColor} on ${bodyBackground})`);
      }
      return boundaryRatio;
    };
    const boundaryRatio = checkHornBoundaryContrast(r);
    console.log(`Horn boundary contrast: ${r.hornOutlineColor} on ${r.bodyBackground} = ${boundaryRatio.toFixed(2)}:1`);

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

    // Verify #horn-help provides the accessible description via aria-describedby
    const expectedDesc = 'Press and hold to sound the air horn. Release to stop.';
    if (hornNode.description?.value !== expectedDesc) {
      throw new Error(`Expected horn AX description "${expectedDesc}", got "${hornNode.description?.value}"`);
    }
    const describedbyProp = hornNode.properties?.find(p => p.name === 'describedby')?.value?.value;
    if (describedbyProp !== 'horn-help') {
      throw new Error(`Expected horn AX describedby property to be "horn-help", got "${describedbyProp}"`);
    }

    const helpNode = axTree.nodes.find(n => n.name?.value?.includes(expectedDesc));
    if (!helpNode || helpNode.ignored) {
      throw new Error('#horn-help text must be present and not ignored in the AX tree');
    }

    // Verify .visually-hidden content is visually clipped with negligible rendered footprint
    const hiddenBounds = await send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.getElementById('horn-help');
        const rect = el.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      })()`,
      returnByValue: true
    });
    if (hiddenBounds.result.value.width > 1 || hiddenBounds.result.value.height > 1) {
      throw new Error(`Expected .visually-hidden footprint <= 1px, got ${JSON.stringify(hiddenBounds.result.value)}`);
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
    const interactionStart = Date.now();
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

    // Test install outcome feedback through the one polite voice (airhorn-fld):
    // the old code wrote it to #install-status, an element that does not exist,
    // so accepting or dismissing the prompt was silent. The button is also
    // structurally disabled until the prompt is offered - no exposed-but-inert
    // control, even with CSS blocked.
    console.log('Testing install outcome feedback (airhorn-fld)...');
    // The structural guard ships in the document itself: with CSS blocked the
    // exposed button must already be inert. Assert the attribute on the BUILT
    // shell - a late DOM read would race the real beforeinstallprompt, which
    // enables the button.
    const builtShell = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    if (!/<button type='button' class='button' disabled>Install<\/button>/.test(builtShell)) {
      throw new Error('installer button does not ship structurally disabled in dist/index.html');
    }
    const installFeedback = await send('Runtime.evaluate', {
      expression: `(async () => {
        const installer = document.getElementById('installer');
        const button = installer.querySelector('button');
        const status = document.getElementById('app-status');
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        status.textContent = '';

        let promptCalls = 0;
        const fire = (outcome) => window.dispatchEvent(Object.assign(
          new Event('beforeinstallprompt'),
          { prompt: () => { promptCalls += 1; },
            userChoice: Promise.resolve({ outcome }) }));

        fire('accepted');
        const enabledOnPrompt = button.disabled === false && installer.classList.contains('available');

        button.click();
        let said = '';
        for (let i = 0; i < 40 && !said; i++) { await sleep(50); said = status.textContent || ''; }
        const acceptedAnnounce = said;
        const disabledAfterChoice = button.disabled === true;
        const availableRemoved = !installer.classList.contains('available');

        status.textContent = '';
        fire('dismissed');
        const reenabledOnSecondPrompt = button.disabled === false;
        button.click();
        said = '';
        for (let i = 0; i < 40 && !said; i++) { await sleep(50); said = status.textContent || ''; }
        return { enabledOnPrompt, promptCalls, acceptedAnnounce, disabledAfterChoice,
                 availableRemoved, reenabledOnSecondPrompt, dismissedAnnounce: said };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    const ifr = installFeedback.result.value;
    if (!ifr.enabledOnPrompt) throw new Error('install button not enabled when beforeinstallprompt fired');
    if (ifr.promptCalls !== 2) throw new Error(`expected one prompt() call per click (2), got ${ifr.promptCalls}`);
    if (ifr.acceptedAnnounce !== 'App installed') {
      throw new Error(`accepted install was silent or wrong: ${JSON.stringify(ifr.acceptedAnnounce)}`);
    }
    if (!ifr.disabledAfterChoice || !ifr.availableRemoved) {
      throw new Error(`installer not retired after the choice: ${JSON.stringify(ifr)}`);
    }
    if (!ifr.reenabledOnSecondPrompt) throw new Error('a new install offer did not re-enable the button');
    if (ifr.dismissedAnnounce !== 'Installation cancelled') {
      throw new Error(`dismissed install was silent or wrong: ${JSON.stringify(ifr.dismissedAnnounce)}`);
    }
    console.log('Install outcome feedback verified:', JSON.stringify(ifr));

    // Test installer focus restoration (WCAG 2.4.3): focus must move to .horn, not drop to <body>
    console.log('Testing installer focus restoration when hidden...');
    const focusTestResult = await send('Runtime.evaluate', {
      expression: `(() => {
        const installer = document.getElementById('installer');
        const installBtn = installer.querySelector('button');
        const horn = document.querySelector('.horn');

        // Simulate install prompt available and focused - via the real
        // beforeinstallprompt path, which is what ENABLES the button
        // (airhorn-fld); the button is disabled at parse and a bare
        // classList.add would leave it unfocusable.
        window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), {
          prompt() {},
          userChoice: Promise.resolve({ outcome: 'accepted' }),
        }));
        installBtn.focus();
        const initialFocused = document.activeElement === installBtn;

        // Trigger appinstalled event (which calls #restoreFocus() and removes .available)
        window.dispatchEvent(new Event('appinstalled'));

        const postActiveElement = document.activeElement;
        const focusedHorn = postActiveElement === horn;
        const droppedToBody = postActiveElement === document.body;

        return {
          initialFocused,
          focusedHorn,
          droppedToBody,
          activeElementTag: postActiveElement ? postActiveElement.tagName : null,
          activeElementClass: postActiveElement ? postActiveElement.className : null,
        };
      })()`,
      returnByValue: true
    });

    console.log('Installer focus test result:', focusTestResult.result.value);
    const ftr = focusTestResult.result.value;
    if (!ftr.initialFocused) {
      throw new Error('Could not focus install button');
    }
    if (ftr.droppedToBody) {
      throw new Error('Focus dropped to <body> when install button was hidden');
    }
    if (!ftr.focusedHorn) {
      throw new Error(`Expected focus on .horn after install button was hidden, got: ${ftr.activeElementTag}.${ftr.activeElementClass}`);
    }

    // WCAG 2.2 AA Audit and Falsifiable Negative Controls (airhorn-2hl, airhorn-8e5, airhorn-557)
    console.log('Running WCAG 2.2 AA audit and falsifiability verification...');
    const axePath = path.join(__dirname, 'support/axe.min.js');
    if (!fs.existsSync(axePath)) {
      throw new Error(`axe-core bundle missing at ${axePath}`);
    }
    const axeSource = fs.readFileSync(axePath, 'utf8');
    await send('Runtime.evaluate', { expression: axeSource });

    // Shared target size predicate expression (WCAG 2.2 SC 2.5.8 Level AA, >= 24x24 CSS px)
    const findUndersizedTargetsExpr = `(() => {
      const interactive = Array.from(document.querySelectorAll('button, [role="button"], a[href]')).filter(el => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return !el.disabled && !el.closest('[hidden]') && style.display !== 'none' && style.visibility !== 'hidden' && (rect.width > 0 || rect.height > 0);
      });
      return interactive.filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width < 24 || rect.height < 24;
      }).map(el => ({
        id: el.id,
        selector: el.id ? '#' + el.id : (el.className ? '.' + el.className.split(' ').join('.') : el.tagName),
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height
      }));
    })()`;

    // Shared live region announcement assertion (WCAG SC 4.1.3 Level AA)
    const assertLiveRegionAnnouncement = (axTree, expectedText) => {
      const statusRoleNode = axTree.nodes.find(n => n.role?.value === 'status');
      if (!statusRoleNode) {
        throw new Error('Element with role="status" not found in AXTree');
      }
      if (statusRoleNode.ignored) {
        throw new Error('Element with role="status" is ignored in AXTree');
      }
      const liveProp = statusRoleNode.properties?.find(p => p.name === 'live')?.value?.value;
      if (liveProp !== 'polite') {
        throw new Error(`Expected live="polite", got "${liveProp}"`);
      }
      const textNode = axTree.nodes.find(n => n.name?.value === expectedText);
      if (!textNode) {
        throw new Error(`Text "${expectedText}" not found in AXTree`);
      }
      if (textNode.ignored) {
        throw new Error(`Text "${expectedText}" is ignored in AXTree`);
      }
      return { statusRoleNode, textNode };
    };

    // 1. Audit clean build with axe-core (WCAG 2.0 / 2.1 / 2.2 AA)
    const cleanAxe = await send('Runtime.evaluate', {
      expression: `(async () => {
        const results = await axe.run(document, {
          runOnly: {
            type: 'tag',
            values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
          }
        });
        return results.violations;
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (cleanAxe.result.value.length > 0) {
      throw new Error(`Clean build failed WCAG audit: ${JSON.stringify(cleanAxe.result.value)}`);
    }
    console.log('Clean build axe-core violations: 0');

    // 2. Manual check: Target Size Minimum (WCAG 2.2 SC 2.5.8 Level AA, >= 24x24 CSS px)
    const cleanUndersized = await send('Runtime.evaluate', {
      expression: findUndersizedTargetsExpr,
      returnByValue: true
    });
    if (cleanUndersized.result.value.length > 0) {
      throw new Error(`Undersized targets found on clean build: ${JSON.stringify(cleanUndersized.result.value)}`);
    }
    console.log(`Clean build target size: 0 undersized targets (< 24x24px) found`);

    // 3. Status Messages (WCAG 2.1/2.2 SC 4.1.3 Level AA): verify live region actually announces in AXTree
    const liveAnnounceText = 'Accessibility status announcement verified';
    await send('Runtime.evaluate', {
      expression: `window.__airhornAnnounce(${JSON.stringify(liveAnnounceText)})`
    });
    const axTreeLive = await send('Accessibility.getFullAXTree');
    const liveVerified = assertLiveRegionAnnouncement(axTreeLive, liveAnnounceText);
    console.log(`Polite live region announcement verified in AXTree: "${liveVerified.textNode.name.value}" (nodeId: ${liveVerified.textNode.nodeId})`);
    // Clear live region
    await send('Runtime.evaluate', { expression: `window.__airhornAnnounce('')` });

    // 4. Falsifiable Negative Controls: inject known defects and assert exact rule IDs and shared assertions catch them
    console.log('Testing falsifiability negative controls...');

    // Control 1: Missing accessible name -> caught by axe rule 'button-name'
    await send('Runtime.evaluate', {
      expression: `(() => {
        const horn = document.querySelector('.horn');
        horn.removeAttribute('aria-label');
        const label = horn.querySelector('.horn-label');
        if (label) {
          label.dataset.origDisplay = label.style.display;
          label.style.display = 'none';
        }
      })()`
    });
    const neg1 = await send('Runtime.evaluate', {
      expression: `(async () => {
        const r = await axe.run(document, { runOnly: ['button-name'] });
        return r.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }));
      })()`,
      awaitPromise: true,
      returnByValue: true
    });
    await send('Runtime.evaluate', {
      expression: `(() => {
        const horn = document.querySelector('.horn');
        horn.setAttribute('aria-label', 'Air horn');
        const label = horn.querySelector('.horn-label');
        if (label) label.style.display = label.dataset.origDisplay || '';
      })()`
    });
    const caughtButtonName = neg1.result.value.find(v => v.id === 'button-name' && v.nodes.some(targets => targets.some(t => t.includes('.horn'))));
    if (!caughtButtonName) {
      throw new Error(`Falsification FAILED: Missing accessible name was not caught by rule 'button-name': ${JSON.stringify(neg1.result.value)}`);
    }
    console.log(`  [PASS] Defect 1 (missing accessible name) caught by rule: ${caughtButtonName.id}`);

    // Control 2: Low-contrast boundary ring (1.2:1) -> caught by shared checkHornBoundaryContrast (airhorn-8e5)
    await send('Runtime.evaluate', { expression: `document.querySelector('.horn').style.outlineColor = 'rgb(244, 67, 54)'` });
    const neg2Styles = await send('Runtime.evaluate', {
      expression: `(() => {
        const horn = document.querySelector('.horn');
        const cs = window.getComputedStyle(horn);
        return {
          hornOutlineColor: cs.outlineColor,
          hornOutlineWidth: cs.outlineWidth,
          hornOutlineStyle: cs.outlineStyle,
          bodyBackground: window.getComputedStyle(document.body).backgroundColor
        };
      })()`,
      returnByValue: true
    });
    await send('Runtime.evaluate', { expression: `document.querySelector('.horn').style.outlineColor = ''` });
    let neg2Threw = false;
    let neg2Error = '';
    try {
      checkHornBoundaryContrast(neg2Styles.result.value);
    } catch (e) {
      neg2Threw = true;
      neg2Error = e.message;
    }
    if (!neg2Threw || !neg2Error.includes('Expected horn boundary contrast >= 3:1')) {
      throw new Error(`Falsification FAILED: Low-contrast boundary ring was not rejected by checkHornBoundaryContrast: ${neg2Error}`);
    }
    console.log(`  [PASS] Defect 2 (1.2:1 boundary ring) caught by shared checkHornBoundaryContrast: "${neg2Error}"`);

    // Control 2b: Missing outline entirely (outline-style: none) -> caught by shared checkHornBoundaryContrast (airhorn-8e5)
    await send('Runtime.evaluate', { expression: `document.querySelector('.horn').style.outlineStyle = 'none'` });
    const neg2bStyles = await send('Runtime.evaluate', {
      expression: `(() => {
        const horn = document.querySelector('.horn');
        const cs = window.getComputedStyle(horn);
        return {
          hornOutlineColor: cs.outlineColor,
          hornOutlineWidth: cs.outlineWidth,
          hornOutlineStyle: cs.outlineStyle,
          bodyBackground: window.getComputedStyle(document.body).backgroundColor
        };
      })()`,
      returnByValue: true
    });
    await send('Runtime.evaluate', { expression: `document.querySelector('.horn').style.outlineStyle = ''` });
    let neg2bThrew = false;
    try {
      checkHornBoundaryContrast(neg2bStyles.result.value);
    } catch (e) {
      neg2bThrew = true;
    }
    if (!neg2bThrew) {
      throw new Error('Falsification FAILED: Removed outline was not rejected by checkHornBoundaryContrast');
    }
    console.log(`  [PASS] Defect 2b (removed boundary ring) caught by shared checkHornBoundaryContrast assertion`);

    // Control 3: Undersized 20x20px interactive target -> caught by shared findUndersizedTargetsExpr (airhorn-557)
    await send('Runtime.evaluate', {
      expression: `(() => {
        const btn = document.createElement('button');
        btn.id = 'falsify-tiny-control';
        btn.textContent = 'x';
        btn.style.cssText = 'position:fixed;top:0;left:0;width:20px;height:20px;padding:0;margin:0;border:none;';
        document.body.appendChild(btn);
      })()`
    });
    const neg3Undersized = await send('Runtime.evaluate', {
      expression: findUndersizedTargetsExpr,
      returnByValue: true
    });
    await send('Runtime.evaluate', { expression: `document.getElementById('falsify-tiny-control')?.remove()` });
    const caughtTiny = neg3Undersized.result.value.find(t => t.id === 'falsify-tiny-control');
    if (!caughtTiny || caughtTiny.width !== 20 || caughtTiny.height !== 20) {
      throw new Error(`Falsification FAILED: Undersized 20x20px target was not caught by shared findUndersizedTargets: ${JSON.stringify(neg3Undersized.result.value)}`);
    }
    console.log(`  [PASS] Defect 3 (20x20px interactive target) caught by shared findUndersizedTargets: ${caughtTiny.selector} (${caughtTiny.width}x${caughtTiny.height}px)`);

    // Control 4: Status message marked aria-hidden='true' -> caught by shared assertLiveRegionAnnouncement (airhorn-557)
    await send('Runtime.evaluate', {
      expression: `(() => {
        const status = document.getElementById('app-status');
        status.setAttribute('aria-hidden', 'true');
        window.__airhornAnnounce('Hidden status defect');
      })()`
    });
    const axTreeNeg4 = await send('Accessibility.getFullAXTree');
    await send('Runtime.evaluate', {
      expression: `(() => {
        const status = document.getElementById('app-status');
        status.removeAttribute('aria-hidden');
        window.__airhornAnnounce('');
      })()`
    });
    let neg4Threw = false;
    let neg4Error = '';
    try {
      assertLiveRegionAnnouncement(axTreeNeg4, 'Hidden status defect');
    } catch (e) {
      neg4Threw = true;
      neg4Error = e.message;
    }
    if (!neg4Threw) {
      throw new Error(`Falsification FAILED: Status message marked aria-hidden was not rejected by assertLiveRegionAnnouncement`);
    }
    console.log(`  [PASS] Defect 4 (aria-hidden status message) caught by shared assertLiveRegionAnnouncement: "${neg4Error}"`);
    console.log('All falsification negative controls verified!');

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
      quietExpression: `!document.querySelector('.horn.horning')`,
      // That state clears on the audio source's 'ended' event, which cannot fire
      // when a machine's headless audio never progresses. Pending work is still
      // observable, so bound the overall wait and the state-only wait separately:
      // a stuck pipeline then fails in seconds, naming the cause, instead of
      // wedging for 20s and reporting that unspecified work is still pending.
      timeoutMs: 15000,
      stateTimeoutMs: 4000,
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
