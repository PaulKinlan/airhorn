// Pin for airhorn-mj2m: 9ba115c (airhorn-6jsu) turned beads auto-backup OFF in the tracked
// .beads/config.yaml, and nothing went red if it flipped back. The honest assertion is over
// the PARSED value. Two instrument notes, both measured: (1) `bd config get` answers from
// the LIVE database's config home - in a worktree that is the canonical checkout's copy, so
// editing this repo's tracked file does not move it (measured: flipped here, still answered
// false); it cannot pin the tracked content. (2) No YAML library is installed, so this file
// carries a small structural parser for the two-level subset this config uses - indentation
// aware, so a flip, a re-nest, or a removal all break it; a text grep would not (the audit's
// decorative-pin defect class).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Two-level subset parser: returns a map of 'section.key' -> boolean|string for
// uncommented lines. Throws on a shape it does not understand rather than guessing.
const parseTwoLevel = (text) => {
  const out = new Map();
  let section = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const m = raw.trim().match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*(?:#.*)?$/);
    if (!m) throw new Error(`unparsed config line: ${JSON.stringify(raw)}`);
    const [, key, value] = m;
    if (indent === 0) {
      section = value === '' ? key : null;
      if (value !== '') out.set(key, value);
    } else if (section) {
      out.set(`${section}.${key}`, value);
    }
  }
  return out;
};

test('beads auto-backup is disabled in the tracked config, parsed structurally', () => {
  const text = fs.readFileSync(path.join(root, '.beads', 'config.yaml'), 'utf8');
  const parsed = parseTwoLevel(text);
  assert.equal(parsed.get('backup.enabled'), 'false',
    `backup.enabled parsed as ${JSON.stringify(parsed.get('backup.enabled'))} - auto-backup was re-enabled, moved, or the parse no longer understands the file`);
});
