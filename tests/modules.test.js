/*
 * tests/modules.test.js — the split's structural contract (airhorn-1l04).
 *
 * src/main.js used to be the whole app, so every suite had to be named on its
 * gate row and the cheapest possible edit paid the widest gate. The concerns are
 * now separate modules and src/main.js is a composition root. That shape is what
 * makes the gate row narrow, so it is pinned here instead of in a comment:
 *
 *   - every relative import resolves, and the module graph is acyclic;
 *   - src/main.js imports the concern modules and nothing else, calls each
 *     binder, and contains no behaviour of its own;
 *   - each concern module exports the entry point main.js calls;
 *   - src/airhorn.js still exposes the surface src/webmcp.js and the suites
 *     drive through window.__airhorn.
 *
 * There is deliberately no "the entry points exist" case: a module that stops
 * exporting the binder main.js imports fails AT IMPORT, naming the file, before
 * any test body runs - so such an assertion could never be the thing that failed
 * (airhorn-auoa). What is worth asserting is that main.js CALLS them with the
 * right arguments, which the wiring test below does.
 *
 * Browser-free and sub-second on purpose: it is named on every module row, so
 * it must never be the reason a row gets slow.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AirHorn } from '../src/airhorn.js';
import { trackEvent } from '../src/analytics.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (file) => fs.readFileSync(path.join(SRC, file), 'utf8');
const srcFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));

// Relative imports only: a bare specifier is a dependency, not a module edge in
// this graph. `import ... from './x.js'` is the only form the app uses.
const importsOf = (text) =>
  [...text.matchAll(/^\s*import\s+[^;]*?from\s*'(\.[^']+)'[^;]*;?/gm)].map((m) => m[1]);

test('every relative import resolves and the module graph is acyclic', () => {
  const graph = new Map();
  for (const file of srcFiles) {
    const deps = importsOf(read(file)).map((spec) => {
      const target = path.join(SRC, spec);
      assert.ok(fs.existsSync(target), `${file} imports ${spec}, which is not in src/`);
      return path.basename(target);
    });
    graph.set(file, deps);
  }

  const state = new Map(); // 0 = visiting, 1 = done
  const cycles = [];
  const visit = (file, stack) => {
    if (state.get(file) === 1) return;
    if (state.get(file) === 0) {
      cycles.push([...stack, file].join(' -> '));
      return;
    }
    state.set(file, 0);
    for (const dep of graph.get(file) || []) visit(dep, [...stack, file]);
    state.set(file, 1);
  };
  for (const file of srcFiles) visit(file, []);
  assert.deepEqual(cycles, [], `the module graph must stay acyclic: ${cycles.join(', ')}`);
});

test('src/main.js is a composition root: the concern modules, nothing else', () => {
  const text = read('main.js');
  assert.deepEqual(
    importsOf(text).sort(),
    ['./airhorn.js', './input.js', './install.js', './launch.js', './status.js', './webmcp.js'],
    'main.js must import exactly the concern modules (add a module = update this list, its map row '
      + 'and .fleet/coverage-contract.json in the same change)',
  );

  for (const call of ['bindStatus()', 'bindHornInput({', 'bindInstaller(', 'bindLaunch({', 'registerHornTools(']) {
    assert.ok(text.includes(call), `main.js must wire the app by calling ${call}`);
  }

  // Behaviour that belongs in a concern module. Each pattern is code (a call or
  // an event), not a word, so the prose above cannot trip it.
  const behaviour = [
    "addEventListener('pointerdown'",
    "addEventListener('keydown'",
    "addEventListener('beforeinstallprompt'",
    "addEventListener('hashchange'",
    "addEventListener('offline'",
    'setAppBadge',
    'localStorage',
    'launchQueue',
    'new Horn(',
    'navigator.locks',
    'class ',
  ];
  const found = behaviour.filter((snippet) => text.includes(snippet));
  assert.deepEqual(found, [],
    `main.js must stay wiring only - move this behaviour into its concern module: ${found.join(', ')}`);
});

test('main.js passes the app\'s real targets and callbacks, not just the binder names (airhorn-1l04)', async () => {
  // The narrowed src/main.js row deliberately does not select the keyboard or
  // shortcuts suites, because the behaviour lives in the concern modules now.
  // What it DOES still own is the wiring, and a row that pinned only the binder
  // NAMES let a main-only edit change the arguments and stay green: rewriting
  // `start: (options) => airhorn.start(options)` to
  // `airhorn.start({ loop: false })` passes every name check while Space/Enter
  // stop looping (reviewed P1, airhorn-1l04). So this test executes the real
  // main.js against recording stubs and asserts the WIRING ITSELF: which element
  // each binder is given, that the input callbacks forward their own options
  // untouched (identity, so any substitution fails), that the launch callback is
  // the one-shot the cold-launch dedupe depends on, and the registration order
  // the old single constructor relied on.
  //
  // It runs in-process: main.js is copied once with its imports pointed at stub
  // modules, so there is no child process and the suite stays sub-second.
  const wire = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airhorn-wiring-'));
  const stubDir = path.join(tmp, 'stubs');
  fs.mkdirSync(stubDir);
  const stubs = {
    'airhorn.js': `export class AirHorn {
      constructor(element) { this.element = element; globalThis.__wire.push(['construct', element, this]); }
      start(options) { globalThis.__wire.push(['start', options]); }
      stop(options) { globalThis.__wire.push(['stop', options]); }
      acknowledgeSharedBadge() { globalThis.__wire.push(['acknowledgeSharedBadge']); }
    }`,
    'status.js': "export function bindStatus() { globalThis.__wire.push(['bindStatus']); }",
    'input.js': "export function bindHornInput(handles) { globalThis.__wire.push(['bindHornInput', handles]); }",
    'install.js': "export function bindInstaller(root) { globalThis.__wire.push(['bindInstaller', root]); }",
    'launch.js': "export function bindLaunch(handles) { globalThis.__wire.push(['bindLaunch', handles]); }",
    'webmcp.js': "export function registerHornTools(airhorn) { globalThis.__wire.push(['registerHornTools', airhorn]); return Promise.resolve(); }",
  };
  for (const [name, source] of Object.entries(stubs)) fs.writeFileSync(path.join(stubDir, name), source);

  // Rewrite only the module specifiers; the wiring text under test is untouched.
  const mainSource = read('main.js').replace(/from '(\.\/[A-Za-z0-9-]+\.js)'/g, "from './stubs/$1'");
  const mainFile = path.join(tmp, 'main.js');
  fs.writeFileSync(mainFile, mainSource);

  const hornElement = { id: 'airhorn' };
  const installerElement = { id: 'installer' };
  const listeners = [];
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  globalThis.__wire = wire;
  globalThis.window = {
    addEventListener(type, handler) { listeners.push([type, handler]); },
    __airhornBooted() { wire.push(['booted']); },
  };
  globalThis.document = {
    getElementById(id) {
      if (id === 'airhorn') return hornElement;
      if (id === 'installer') return installerElement;
      return null;
    },
  };

  try {
    await import(pathToFileURL(mainFile).href);

    // Status is bound at module scope, before load, so an offline boot speaks
    // once; nothing else has run yet.
    assert.deepEqual(wire.map((w) => w[0]), ['bindStatus'],
      `only the connection notice may bind before load, got ${JSON.stringify(wire.map((w) => w[0]))}`);
    assert.equal(globalThis.window.__airhorn, undefined, 'window.__airhorn must not exist before load');

    const load = listeners.find(([type]) => type === 'load');
    assert.ok(load, 'main.js must bind a load handler');
    load[1]();

    // Registration order is the old single constructor's order, and the boot
    // marker lands between the installer and WebMCP for airhorn-21k.
    assert.deepEqual(wire.map((w) => w[0]),
      ['bindStatus', 'construct', 'bindHornInput', 'bindInstaller', 'booted', 'registerHornTools', 'bindLaunch'],
      `main.js wiring order changed: ${JSON.stringify(wire.map((w) => w[0]))}`);

    const byName = (name) => wire.find((w) => w[0] === name);

    // Booting WIRES input; it must not sound the horn itself. This is the other
    // half of the same hole: an argument check alone would still let a main-only
    // edit add a `airhorn.start()` to the load handler, and the horn suite that
    // would hear it is deliberately not on this row.
    assert.equal(wire.filter((w) => w[0] === 'start' || w[0] === 'stop').length, 0,
      'main.js must not start or stop the horn while booting - it only wires the input that does');

    // Targets are the real elements, by identity - not a selector re-lookup.
    const horn = byName('construct')[2];
    assert.equal(byName('construct')[1], hornElement, 'the horn must be built on the #airhorn element');
    assert.equal(byName('bindHornInput')[1].target, hornElement,
      'input must be bound to the horn element itself (airhorn.element)');
    assert.equal(horn.element, hornElement, 'the horn instance must expose the element it was built on');
    assert.equal(byName('bindInstaller')[1], installerElement, 'the installer must be bound to #installer');
    assert.equal(globalThis.window.__airhorn, horn, 'window.__airhorn must be the horn instance');
    assert.equal(byName('registerHornTools')[1], horn,
      'WebMCP must be registered against the same horn instance');

    // FORWARDING: the input hold passes { loop: true } and the release passes
    // nothing; main.js must hand those straight through. Identity catches every
    // substitution, which is what the review found the row could not see.
    const held = { loop: true };
    byName('bindHornInput')[1].start(held);
    assert.equal(wire.filter((w) => w[0] === 'start').at(-1)[1], held,
      'the input start callback must forward its options untouched - a hardcoded { loop: false } breaks the keyboard/pointer hold');
    const released = { reason: 'pointerup' };
    byName('bindHornInput')[1].stop(released);
    assert.equal(wire.filter((w) => w[0] === 'stop').at(-1)[1], released,
      'the input stop callback must forward its options untouched');

    // The launch path is the opposite contract: a deep link is a ONE-SHOT blast,
    // and its badge acknowledge must reach the horn.
    byName('bindLaunch')[1].start();
    assert.deepEqual(wire.filter((w) => w[0] === 'start').at(-1)[1], { loop: false },
      'a launch must start a non-looping blast ({ loop: false })');
    const acknowledges = wire.filter((w) => w[0] === 'acknowledgeSharedBadge').length;
    byName('bindLaunch')[1].acknowledgeBadge();
    assert.equal(wire.filter((w) => w[0] === 'acknowledgeSharedBadge').length, acknowledges + 1,
      'the launch badge acknowledge must call the horn\'s acknowledgeSharedBadge');
  } finally {
    globalThis.window = savedWindow;
    globalThis.document = savedDocument;
    delete globalThis.__wire;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('src/airhorn.js keeps the surface window.__airhorn exposes', () => {
  // src/webmcp.js and the browser suites drive the app through this object; a
  // member moving or vanishing during a refactor is a silent app-API break.
  for (const method of ['start', 'stop', 'isPlaying', 'isLooping', 'hasAudioContext', 'acknowledgeSharedBadge']) {
    assert.equal(typeof AirHorn.prototype[method], 'function', `window.__airhorn.${method} must stay callable`);
  }
  for (const accessor of ['usingFallback', 'element']) {
    const descriptor = Object.getOwnPropertyDescriptor(AirHorn.prototype, accessor);
    assert.equal(typeof descriptor?.get, 'function', `window.__airhorn.${accessor} must stay readable`);
  }
});

test('trackEvent is silent without gtag and forwards when analytics is loaded', () => {
  assert.equal(typeof globalThis.gtag, 'undefined', 'this test needs gtag absent to start with');
  assert.doesNotThrow(() => trackEvent('probe', { event_category: 'test' }),
    'a page without the analytics snippet must not throw');

  const calls = [];
  globalThis.gtag = (...args) => calls.push(args);
  try {
    trackEvent('horn_play', { event_category: 'horn' });
  } finally {
    delete globalThis.gtag;
  }
  assert.deepEqual(calls, [['event', 'horn_play', { event_category: 'horn' }]]);
});
