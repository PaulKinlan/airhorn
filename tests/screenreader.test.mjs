/*
 * tests/screenreader.test.mjs — what would a screen reader actually perceive? (airhorn-prdm)
 *
 * The other accessibility suite asserts ARIA in the DOM (attributes, axe, the
 * computed contrast of the boundary ring). None of that says what a screen
 * reader is told: an attribute is a claim, the accessibility tree is the fact.
 * So this suite never reads an ARIA attribute for its verdicts - it reads
 * Chrome's own Accessibility.getFullAXTree, the tree the platform hands to
 * assistive technology, and asserts the contract on THAT:
 *
 *   - the horn exposes role/name/description/state, and its state follows the
 *     sound (pressed=false at rest, true while held, false again after release);
 *   - #app-status is a live region (role=status, live=polite, atomic) whose text
 *     is REPLACED: one message at a time, the previous one gone from the tree,
 *     so it is announced once and never accumulates;
 *   - each of the three announcement paths - the offline transition, the tap
 *     hint, and the service-worker update notice - lands in that region exactly
 *     once, in the AX tree as well as at the app's single voice;
 *   - decoration is not exposed: the aria-hidden rings, the hidden fallback
 *     label and the hidden boot banner contribute no nodes at all;
 *   - AX focus order matches the order the Tab key actually walks.
 *
 * Evidence: the AX subtree of the status region (and the nodes carrying each
 * message) is written before and after every announcement, to
 * ${AIRHORN_RESULTS_DIR:-/tmp/airhorn-test-results}/screenreader-<pid>/, so a
 * failure can be read rather than guessed at. The files are per-process: two
 * suites running at once must not overwrite each other's evidence.
 *
 * Two platform stand-ins, both labelled where they are used because headless
 * Chrome cannot produce the real thing: a suspended AudioContext (the tap hint
 * only fires when the browser refuses to start audio until a gesture) and a
 * service-worker update on an existing registration (the platform delivers
 * updatefound; this suite dispatches it on the real registration object and
 * drives a stand-in installing worker through the states the page's own inline
 * handler listens for). The real end-to-end update story, including its
 * announcement counts across tabs, is multitab's job.
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
const EVIDENCE_DIR = path.join(
  process.env.AIRHORN_RESULTS_DIR || '/tmp/airhorn-test-results',
  `screenreader-${process.pid}`
);

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

// --- reading the AX tree -----------------------------------------------------

const roleOf = (node) => (node && node.role && node.role.value) || null;
const nameOf = (node) => (node && node.name && node.name.value) || '';
const propsOf = (node) => Object.fromEntries(
  ((node && node.properties) || []).map((p) => [p.name, p.value && p.value.value])
);
const live = (node) => !node.ignored;

// getFullAXTree's flat `nodes` array is NOT document order (the install button
// comes back before the horn it follows in the DOM), so anything that claims an
// ORDER has to walk childIds from the root. Root roles are excluded from focus
// order: RootWebArea itself reports focusable/focused for the document.
const ROOT_ROLES = ['RootWebArea', 'WebArea', 'rootWebArea'];
const axWalk = (tree) => {
  const byId = new Map(tree.nodes.map((n) => [n.nodeId, n]));
  const root = tree.nodes.find((n) => !n.parentId) || tree.nodes.find((n) => ROOT_ROLES.includes(roleOf(n)));
  assert(root, 'the accessibility tree has no root node - it is not a tree');
  const ordered = [];
  const walk = (node) => {
    if (!node) return;
    ordered.push(node);
    for (const childId of node.childIds || []) walk(byId.get(childId));
  };
  walk(root);
  return ordered;
};

const axFocusables = (tree) => axWalk(tree)
  .filter((n) => live(n) && !ROOT_ROLES.includes(roleOf(n)) && propsOf(n).focusable === true)
  .map((n) => ({ role: roleOf(n), name: nameOf(n) }));

// Nodes carrying exactly this text, anywhere in the tree. This is the check that
// a message appears ONCE: a live region that appended would leave the previous
// message behind and this would count two.
//
// Two roles share a message's text without being a second copy of it: a
// container whose accessible name is computed FROM its text (the status region
// itself, a document), and the InlineTextBox, which is the layout run of the very
// StaticText that holds it. Only the text-bearing node counts, so one message is
// one carrier - anything else means the region really did keep two.
const NON_CARRIER_ROLES = ['status', 'RootWebArea', 'WebArea', 'InlineTextBox'];
const nodesNamed = (tree, text) => tree.nodes.filter((n) => live(n)
  && !NON_CARRIER_ROLES.includes(roleOf(n))
  && nameOf(n) === text);

const statusNode = (tree) => {
  const node = tree.nodes.find((n) => roleOf(n) === 'status');
  assert(node, 'the accessibility tree has no role=status node - nothing an AT would treat as a live region');
  assert(live(node), 'the role=status node is ignored in the accessibility tree, so its messages are never announced');
  return node;
};

// The text the region actually holds, in tree order, following childIds.
const subtreeTexts = (tree, node) => {
  const byId = new Map(tree.nodes.map((n) => [n.nodeId, n]));
  const out = [];
  const walk = (id) => {
    const current = byId.get(id);
    if (!current || current.ignored) return;
    if (roleOf(current) === 'StaticText') out.push(nameOf(current));
    for (const childId of current.childIds || []) walk(childId);
  };
  for (const childId of node.childIds || []) walk(childId);
  return out;
};

// Everything a person reading a failure needs about one node.
const describeNode = (node) => ({
  role: roleOf(node),
  name: nameOf(node),
  description: (node && node.description && node.description.value) || null,
  ignored: !!node.ignored,
  properties: propsOf(node),
  backendDOMNodeId: node.backendDOMNodeId || null,
});

function assertRegionProperty(tree, name, expected, label) {
  const node = statusNode(tree);
  const actual = propsOf(node)[name];
  assert(
    actual === expected,
    `${label}: the live region's ${name} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)} - ` +
    'without it an AT may not treat the message as a single announcement'
  );
}

/*
 * One shared assertion for every announcement: the region holds exactly this
 * message, the message exists exactly once in the tree, and - when there was a
 * previous message - that one is gone. That triple is "announced once, replaced,
 * not appended" stated in the tree's own terms.
 */
function assertAnnouncedOnce(tree, message, { previous = null, label }) {
  const region = statusNode(tree);
  const texts = subtreeTexts(tree, region);
  assert(
    texts.length === 1 && texts[0] === message,
    `${label}: the live region holds ${JSON.stringify(texts)}, expected exactly [${JSON.stringify(message)}] - ` +
    'more than one text node means an AT hears the announcement appended rather than replaced'
  );
  const carriers = nodesNamed(tree, message);
  assert(
    carriers.length === 1,
    `${label}: the accessibility tree carries "${message}" ${carriers.length} time(s), expected exactly once`
  );
  if (previous) {
    const stale = nodesNamed(tree, previous);
    assert(
      stale.length === 0,
      `${label}: the previous message "${previous}" is still in the accessibility tree ${stale.length} time(s) - ` +
      'the region replaced its text, but the old node survived'
    );
  }
  return { region: describeNode(region), texts, carriers: carriers.map(describeNode) };
}

const openBrowsers = new Set();
installSignalExit(() => {
  for (const browser of openBrowsers) browser.browser.killNow();
});

const KEYS = {
  Space: { code: 'Space', vk: 32, text: ' ' },
};

async function launch({ label = 'screenreader' } = {}) {
  const browser = await launchBrowser({ label, timeoutMs: 15000 });
  const ws = new WebSocket(browser.pageWsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let id = 1;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
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
  await send('DOM.enable');
  await send('Accessibility.enable');
  // The AX tree reports `focused`, and focus styles exist, only in a focused
  // document - a headless page is not one (see tests/keyboard.test.mjs).
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // Whether headless Chrome offers install is machine state, and an install
  // button appearing mid-suite would change the AX tree under the assertions.
  // Real offers are swallowed so the tree is the same on every box; the suite
  // makes its own offer where the control is under test.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      addEventListener('beforeinstallprompt', (event) => {
        if (event.__stub) return;
        window.__realOffers = (window.__realOffers || 0) + 1;
        event.stopImmediatePropagation();
      }, true);
    `,
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const axTree = () => send('Accessibility.getFullAXTree');

  const waitFor = async (predicate, { timeout = 8000, interval = 50, label = 'condition' } = {}) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await predicate();
      if (last) return last;
      await sleep(interval);
    }
    throw new Error(`${label} was not reached within ${timeout}ms`);
  };

  // Backend node ids let an assertion name a DOM element's absence from the tree
  // exactly, instead of guessing from names.
  const backendIdFor = async (selector) => {
    const { root } = await send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) return null;
    const { node } = await send('DOM.describeNode', { nodeId });
    return node.backendNodeId;
  };

  const handle = { browser, get consoleErrors() { return consoleErrors; } };
  openBrowsers.add(handle);
  const close = async () => {
    openBrowsers.delete(handle);
    try { ws.close(); } catch {}
    await browser.close();
  };

  return { send, evaluate, axTree, sleep, waitFor, backendIdFor, close, handle };
}

// Write the evidence a human can read after a failure: the status region's
// subtree plus every node carrying the message under test.
function writeEvidence(caseName, when, tree, message) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const region = tree.nodes.find((n) => roleOf(n) === 'status');
  const record = {
    case: caseName,
    when,
    capturedAt: new Date().toISOString(),
    region: region ? describeNode(region) : null,
    regionTexts: region ? subtreeTexts(tree, region) : null,
    message,
    carriers: message ? nodesNamed(tree, message).map(describeNode) : [],
    namedNodes: tree.nodes.filter((n) => live(n) && nameOf(n)).map((n) => ({ role: roleOf(n), name: nameOf(n) })),
  };
  const file = path.join(EVIDENCE_DIR, `${caseName}-${when}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

async function run() {
  if (!fs.existsSync(DIST)) throw new Error('dist directory does not exist. Run build first.');
  const server = await startServer();
  const port = server.address().port;
  let app = null;
  try {
    app = await launch();
    const { send, evaluate, axTree, sleep, waitFor, backendIdFor, handle } = app;

    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitFor(() => evaluate('!!window.__airhorn'), { label: 'the app to boot', timeout: 15000 });
    await sleep(300);
    // The one voice, wrapped so an announcement can be counted as well as seen.
    await evaluate(`(() => {
      const voice = window.__airhornAnnounce;
      window.__srLog = [];
      window.__airhornAnnounce = (message) => { window.__srLog.push(message); return voice(message); };
      return typeof window.__airhornAnnounce === 'function';
    })()`);
    const announcementLog = () => evaluate('window.__srLog');
    const countAnnounced = async (message) => (await announcementLog()).filter((m) => m === message).length;
    console.log(`evidence: ${EVIDENCE_DIR}`);

    // ---------------------------------------------------------------- case 1
    console.log('--- 1. at rest: the horn is a button with a name, a description and a state ---');
    const rest = await axTree();
    writeEvidence('rest', 'before', rest);
    const hornNode = rest.nodes.find((n) => roleOf(n) === 'button' && nameOf(n) === 'Air horn');
    assert(hornNode, 'the accessibility tree has no button named "Air horn" - a screen reader cannot find the horn');
    assert(live(hornNode), 'the horn button is ignored in the accessibility tree');
    const hornProps = propsOf(hornNode);
    assert(hornProps.focusable === true, `the horn is not exposed as focusable in AX (${JSON.stringify(hornProps)})`);
    assert(
      hornProps.pressed === 'false',
      `the horn exposes pressed=${JSON.stringify(hornProps.pressed)} at rest, expected "false" - the state an AT announces must match the sound`
    );
    const description = nameOf({ name: { value: (hornNode.description && hornNode.description.value) || '' } });
    assert(
      description === 'Press and hold to sound the air horn. Release to stop.',
      `the horn's AX description is ${JSON.stringify(description)} - a screen reader user would not know it is a hold control`
    );
    assert(nodesNamed(rest, 'Air horn').length === 1,
      `"Air horn" appears as ${nodesNamed(rest, 'Air horn').length} accessible nodes - the hidden fallback label leaked into the tree`);
    console.log(`  horn: ${roleOf(hornNode)} "${nameOf(hornNode)}", pressed=${hornProps.pressed}, described`);

    // --- the live region's own shape, before anything is announced
    const emptyRegion = statusNode(rest);
    assert(subtreeTexts(rest, emptyRegion).length === 0,
      `the live region holds text at rest: ${JSON.stringify(subtreeTexts(rest, emptyRegion))}`);
    assertRegionProperty(rest, 'live', 'polite', 'at rest');
    assertRegionProperty(rest, 'atomic', true, 'at rest');

    // --- decoration is not exposed
    for (const selector of ['.inner', '.center', '.horn-label']) {
      const backendId = await backendIdFor(selector);
      assert(backendId, `could not resolve ${selector} in the DOM - the decoration assertion would prove nothing`);
      const exposed = rest.nodes.filter((n) => n.backendDOMNodeId === backendId && live(n));
      assert(exposed.length === 0, `${selector} is decorative but is exposed in AX as ${JSON.stringify(exposed.map(describeNode))}`);
    }
    const retryBackendId = await backendIdFor('#boot-retry');
    const exposedRetry = retryBackendId ? rest.nodes.filter((n) => n.backendDOMNodeId === retryBackendId && live(n)) : [];
    assert(exposedRetry.length === 0, 'the hidden boot-failure button is exposed in the AX tree');
    assert(
      !rest.nodes.some((n) => live(n) && /couldn.t start/.test(nameOf(n))),
      'the boot-failure banner text is exposed while the banner is hidden'
    );
    console.log('  decoration (rings, fallback label, hidden banner) contributes no accessible nodes');

    // ---------------------------------------------------------------- case 2
    console.log('--- 2. AX focus order matches the order Tab really walks ---');
    // Deterministic, machine-independent: make the offer this suite's own stand-in
    // so the tree always has two controls to order.
    await evaluate(`window.dispatchEvent(Object.assign(new Event('beforeinstallprompt'), {
      __stub: true,
      prompt() {},
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    }))`);
    await sleep(150);
    const offered = await axTree();
    const axOrder = axFocusables(offered);
    writeEvidence('focus-order', 'before', offered);
    assert(axOrder.length >= 2, `the AX tree exposes ${axOrder.length} focusable node(s) - the order check needs the horn and the install offer`);
    // A cold sequential start: focus is on <body> and nothing has been focused yet.
    await evaluate('document.activeElement && document.activeElement.blur && document.activeElement.blur()');
    const walked = [];
    for (let i = 0; i < axOrder.length + 1; i++) {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await sleep(100);
      if ((await evaluate('document.activeElement === document.body')) === true) break;
      const afterTab = await axTree();
      // The RootWebArea reports focused for the document itself; the stop is the
      // one focused *element*.
      const focusedNodes = afterTab.nodes.filter((n) => live(n)
        && propsOf(n).focused === true
        && !ROOT_ROLES.includes(roleOf(n)));
      assert(
        focusedNodes.length === 1,
        `after Tab stop ${i + 1} the AX tree marks ${focusedNodes.length} element(s) focused, expected exactly 1: ` +
        JSON.stringify(focusedNodes.map(describeNode))
      );
      walked.push({ role: roleOf(focusedNodes[0]), name: nameOf(focusedNodes[0]) });
    }
    assert(
      JSON.stringify(walked) === JSON.stringify(axOrder),
      `AX focus order ${JSON.stringify(axOrder)} does not match the order Tab walks ${JSON.stringify(walked)} - ` +
      'a screen reader moves through the page in a different order than the keyboard does'
    );
    console.log(`  AX order == Tab order: ${axOrder.map((n) => n.name).join(' -> ')}`);

    // ---------------------------------------------------------------- case 3
    console.log('--- 3. the horn state an AT announces follows the sound ---');
    await evaluate(`document.querySelector('.horn').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ' });
    const heldTree = await waitFor(async () => {
      const tree = await axTree();
      const node = tree.nodes.find((n) => roleOf(n) === 'button' && nameOf(n) === 'Air horn');
      return propsOf(node).pressed === 'true' ? tree : null;
    }, { label: 'the held horn to expose pressed=true', timeout: 3000 });
    writeEvidence('horn-held', 'during', heldTree);
    const heldNode = heldTree.nodes.find((n) => roleOf(n) === 'button' && nameOf(n) === 'Air horn');
    assert(propsOf(heldNode).focused === true, 'the held horn is not the focused node in AX');
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    const releasedTree = await waitFor(async () => {
      const tree = await axTree();
      const node = tree.nodes.find((n) => roleOf(n) === 'button' && nameOf(n) === 'Air horn');
      return propsOf(node).pressed === 'false' ? tree : null;
    }, { label: 'the released horn to expose pressed=false', timeout: 3000 });
    writeEvidence('horn-released', 'after', releasedTree);
    console.log('  pressed: false at rest -> true while held -> false after release, in the AX tree');
    await sleep(300);

    // ---------------------------------------------------------------- case 4
    console.log('--- 4. the live region REPLACES its message (one announcement, not a growing log) ---');
    const first = 'Screen-reader audit: first announcement';
    const second = 'Screen-reader audit: second announcement';
    const beforeFirst = await axTree();
    writeEvidence('region-first', 'before', beforeFirst);
    await evaluate(`window.__airhornAnnounce(${JSON.stringify(first)})`);
    await sleep(100);
    const afterFirst = await axTree();
    writeEvidence('region-first', 'after', afterFirst, first);
    const firstEvidence = assertAnnouncedOnce(afterFirst, first, { label: 'first announcement' });
    await evaluate(`window.__airhornAnnounce(${JSON.stringify(second)})`);
    await sleep(100);
    const afterSecond = await axTree();
    writeEvidence('region-second', 'after', afterSecond, second);
    assertAnnouncedOnce(afterSecond, second, { previous: first, label: 'second announcement' });
    await evaluate(`window.__airhornAnnounce('')`);
    await sleep(100);
    const afterClear = await axTree();
    writeEvidence('region-cleared', 'after', afterClear);
    assert(subtreeTexts(afterClear, statusNode(afterClear)).length === 0,
      'clearing the region left text in the AX tree');
    assert(nodesNamed(afterClear, second).length === 0, 'clearing the region left the message in the AX tree');
    console.log(`  "${first}" -> "${second}": the first is gone, the second is the region's only text (${firstEvidence.texts.length} node)`);

    // ---------------------------------------------------------------- case 5
    console.log('--- 5. the offline transition announces once, in AX and at the single voice ---');
    const offlineCopy = 'No connection - the Air Horner still works from the copy on your device.';
    const onlineCopy = 'Back online.';
    const logBefore = (await announcementLog()).length;
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await waitFor(() => evaluate(`/No connection/.test(document.getElementById('app-status').textContent)`), {
      label: 'the offline announcement', timeout: 5000,
    });
    await sleep(150);
    const offlineTree = await axTree();
    writeEvidence('offline', 'after', offlineTree, offlineCopy);
    assertAnnouncedOnce(offlineTree, offlineCopy, { label: 'offline transition' });
    const offlineAnnouncements = (await announcementLog()).slice(logBefore);
    assert(
      offlineAnnouncements.length === 1 && offlineAnnouncements[0] === offlineCopy,
      `one offline transition produced ${offlineAnnouncements.length} announcement(s): ${JSON.stringify(offlineAnnouncements)}`
    );
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await waitFor(() => evaluate(`document.getElementById('app-status').textContent === 'Back online.'`), {
      label: 'the back-online announcement', timeout: 5000,
    });
    await sleep(150);
    const onlineTree = await axTree();
    writeEvidence('online', 'after', onlineTree, onlineCopy);
    assertAnnouncedOnce(onlineTree, onlineCopy, { previous: offlineCopy, label: 'back-online transition' });
    const onlineAnnouncements = (await announcementLog()).slice(logBefore);
    assert(
      onlineAnnouncements.length === 2,
      `offline -> online produced ${onlineAnnouncements.length} announcement(s), expected exactly 2 (one each): ${JSON.stringify(onlineAnnouncements)}`
    );
    console.log('  offline and back online: one announcement each, each replacing the last');

    // ---------------------------------------------------------------- case 6
    console.log('--- 6. the tap hint announces once and hands focus to the control that fixes it ---');
    // Stand-in for the browser's own state: a context that has not had a gesture
    // yet. That IS the condition the app branches on (state === 'suspended'), and
    // headless Chrome starts audio happily, so the real one cannot be produced.
    await evaluate(`(() => {
      window.__origAudioState = Object.getOwnPropertyDescriptor(AudioContext.prototype, 'state');
      Object.defineProperty(AudioContext.prototype, 'state', { configurable: true, get: () => 'suspended' });
    })()`);
    const hintCopy = 'The horn needs a tap to make a sound.';
    const hintLogBefore = (await announcementLog()).length;
    // The hint exists only for a horn that produced NO sound, so start() checks
    // isPlaying(): if the previous case's blast is still ringing out (its source
    // can land just after the key release), start() reports the old voice as
    // playing and the app rightly announces nothing. Wait for real silence, or
    // this case races the audio pipeline.
    await waitFor(() => evaluate('window.__airhorn.isPlaying() === false'), {
      label: 'the previous blast to finish before the tap-hint case', timeout: 5000,
    });
    const started = await evaluate(`window.__airhorn.start({ loop: false }).then((ok) => ok)`);
    assert(started === false, `the suspended-context start reported ${JSON.stringify(started)}, expected false - the hint path was not entered`);
    const hintDeadline = Date.now() + 3000;
    let hintState = null;
    while (Date.now() < hintDeadline) {
      hintState = await evaluate(`({
        status: document.getElementById('app-status').textContent,
        log: window.__srLog.slice(),
        playing: window.__airhorn.isPlaying(),
        hasAudio: window.__airhorn.hasAudioContext(),
        pressed: document.querySelector('.horn').getAttribute('aria-pressed'),
      })`);
      if (hintState.status === hintCopy) break;
      await sleep(50);
    }
    assert(hintState && hintState.status === hintCopy,
      `the tap hint never reached the live region; observed ${JSON.stringify(hintState)}`);
    await sleep(150);
    const hintTree = await axTree();
    writeEvidence('tap-hint', 'after', hintTree, hintCopy);
    assertAnnouncedOnce(hintTree, hintCopy, { previous: onlineCopy, label: 'tap hint' });
    const hintAnnouncements = (await announcementLog()).slice(hintLogBefore);
    assert(
      hintAnnouncements.length === 1 && hintAnnouncements[0] === hintCopy,
      `the tap hint was announced ${hintAnnouncements.length} time(s): ${JSON.stringify(hintAnnouncements)}`
    );
    const hintHorn = hintTree.nodes.find((n) => roleOf(n) === 'button' && nameOf(n) === 'Air horn');
    assert(propsOf(hintHorn).pressed === 'false', 'the silent start left the horn exposed as pressed - AT would announce a horn nobody can hear');
    assert(propsOf(hintHorn).focused === true, 'the tap hint did not leave AX focus on the horn, the control the hint tells the user to press');
    await evaluate(`(() => {
      delete AudioContext.prototype.state;
      if (window.__origAudioState) Object.defineProperty(AudioContext.prototype, 'state', window.__origAudioState);
    })()`);
    console.log('  hint announced once; horn not pressed; AX focus on the horn');

    // ---------------------------------------------------------------- case 7
    console.log('--- 7. the update notice: two distinct messages, each announced once ---');
    // Stand-in for the platform's half of an update: the real registration object
    // gets the updatefound event and a stand-in installing worker, so the page's
    // own inline handler (the code under audit) runs unchanged.
    await waitFor(() => evaluate('!!navigator.serviceWorker.controller'), {
      label: 'the page to be controlled by its service worker', timeout: 10000,
    });
    const updateLogBefore = (await announcementLog()).length;
    await evaluate(`(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const listeners = {};
      const worker = {
        state: 'installing',
        posted: [],
        postMessage(message) { this.posted.push(message); },
        addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
      };
      Object.defineProperty(registration, 'installing', { configurable: true, get: () => worker });
      window.__srWorker = worker;
      window.__srDispatch = (type) => { for (const handler of listeners[type] || []) handler(); };
      registration.dispatchEvent(new Event('updatefound'));
    })()`);
    const installingCopy = 'Updating the Air Horner to a new version...';
    const readyCopy = 'A new version is ready - reloading...';
    await waitFor(() => evaluate(`document.getElementById('app-status').textContent === ${JSON.stringify(installingCopy)}`), {
      label: 'the installing-phase update notice', timeout: 3000,
    });
    const installingTree = await axTree();
    writeEvidence('update-installing', 'after', installingTree, installingCopy);
    assertAnnouncedOnce(installingTree, installingCopy, { previous: hintCopy, label: 'update (installing)' });
    await evaluate(`(() => { window.__srWorker.state = 'installed'; window.__srDispatch('statechange'); })()`);
    await waitFor(() => evaluate(`document.getElementById('app-status').textContent === ${JSON.stringify(readyCopy)}`), {
      label: 'the ready-phase update notice', timeout: 3000,
    });
    await sleep(150);
    const readyTree = await axTree();
    writeEvidence('update-ready', 'after', readyTree, readyCopy);
    assertAnnouncedOnce(readyTree, readyCopy, { previous: installingCopy, label: 'update (ready)' });
    assert(
      !readyTree.nodes.some((n) => live(n) && /could not update/i.test(nameOf(n))),
      'a successful update exposed the lost-upgrade copy to an AT - the false failure announcement'
    );
    const updateAnnouncements = (await announcementLog()).slice(updateLogBefore);
    assert(
      updateAnnouncements.length === 2,
      `one update produced ${updateAnnouncements.length} announcement(s), expected exactly 2 (installing, then ready): ${JSON.stringify(updateAnnouncements)}`
    );
    assert(
      updateAnnouncements[0] === installingCopy && updateAnnouncements[1] === readyCopy,
      `the update announcements are in the wrong order: ${JSON.stringify(updateAnnouncements)}`
    );
    assert((await evaluate('window.__srWorker.posted')).includes('skipWaiting'),
      'the update handler never asked the new worker to skipWaiting - the page would announce an update it then never takes');
    console.log('  installing then ready, one each, in that order; no failure copy');

    const pageErrors = await evaluate('window.__pageErrors || null');
    if (pageErrors && pageErrors.length) throw new Error(`page errors during the audit: ${JSON.stringify(pageErrors)}`);
    assert(handle.consoleErrors.length === 0, `console errors during the audit: ${JSON.stringify(handle.consoleErrors)}`);

    console.log('ALL SCREEN-READER AUDIT CHECKS PASSED');
  } finally {
    if (app) await app.close();
    server.close();
  }
}

run().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
