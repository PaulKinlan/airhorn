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
 * Browser-free and sub-second on purpose: it is named on every module row, so
 * it must never be the reason a row gets slow.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AirHorn } from '../src/airhorn.js';
import { BlastBadge } from '../src/badge.js';
import { bindHornInput } from '../src/input.js';
import { bindInstaller } from '../src/install.js';
import { bindLaunch } from '../src/launch.js';
import { bindStatus } from '../src/status.js';
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

test('each concern module exports the entry point main.js calls', () => {
  assert.equal(typeof bindStatus, 'function', 'src/status.js must export bindStatus');
  assert.equal(typeof bindHornInput, 'function', 'src/input.js must export bindHornInput');
  assert.equal(typeof bindInstaller, 'function', 'src/install.js must export bindInstaller');
  assert.equal(typeof bindLaunch, 'function', 'src/launch.js must export bindLaunch');
  assert.equal(typeof BlastBadge, 'function', 'src/badge.js must export BlastBadge');
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
