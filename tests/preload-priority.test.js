// Pin for airhorn-uzdf (factory audit, modern-web): the /sounds/airhorn.mp3
// preload must DECLARE its true relative priority instead of inheriting the
// UA default fetch/XHR tier. No blast can happen before the bundle hydrates
// and the user presses, so the 40KB sound is genuinely low - it must not race
// the critical CSS/JS for bandwidth on a slow connection. A preload that
// inherits the default fails this test; so does one that claims a priority
// the sound does not have.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('the airhorn.mp3 preload declares fetchpriority="low"', () => {
  const tag = html.match(/<link\b[^>]*href=['"]\/sounds\/airhorn\.mp3['"][^>]*>/);
  assert.ok(tag, 'index.html preloads /sounds/airhorn.mp3');
  const priority = tag[0].match(/fetchpriority=['"]([^'"]*)['"]/);
  assert.ok(priority,
    'the airhorn.mp3 preload declares no fetchpriority - it inherits the UA default and races the critical path (airhorn-uzdf)');
  assert.equal(priority[1], 'low',
    `the airhorn.mp3 preload claims fetchpriority '${priority[1]}' - the sound cannot be needed before hydration plus a press, so its true priority is low`);
});
