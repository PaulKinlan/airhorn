/*
 * The evidence map in docs/webmcp-tools.md promises: "Every claim above, and the code or test that pins it. Test names
 * are the node --test case names." That promise is only worth anything if each cited name EXISTS as a case: after a
 * rename, a reader greps the documented name, finds nothing, and cannot tell a stale doc from a missing test
 * (airhorn-5t0y - our own map cited two cases that airhorn-9sbz had renamed).
 *
 * This is a DOC-DRIFT pin, not a behaviour pin, and the distinction is deliberate (ADR 0001): the fact it establishes
 * is about what the documentation SAYS, which no runtime observation can check. It infers nothing about the tool from
 * prose - the behaviour claims are pinned by the suites themselves.
 *
 * KEYED ON THE DOC, not on a list in this file. The set of names checked is extracted from the document's own table,
 * so renaming a row's citation fails here instead of quietly updating the thing that is supposed to police it. If this
 * file kept its own list, the list would drift with the doc and the pin would agree with the drift.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'docs/webmcp-tools.md';

const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

/** Every suite source in the tree, as {file: text}. */
function suites() {
  const dirs = ['tests', 'test'];
  const found = {};
  for (const dir of dirs) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(mjs|js)$/.test(entry.name)) continue;
      const rel = path.posix.join(dir, entry.name);
      found[rel] = fs.readFileSync(path.join(full, entry.name), 'utf8');
    }
  }
  return found;
}

/**
 * The evidence-map rows. Keyed on the table's own header line so this cannot silently audit a different table.
 */
function evidenceRows() {
  const lines = read(DOC).split('\n');
  const at = lines.findIndex((line) => line.trim() === '| claim | evidence |');
  assert.notEqual(at, -1, `${DOC} must still carry the "| claim | evidence |" table - this pin reads that table's rows`);
  const rows = [];
  for (let i = at + 2; i < lines.length; i += 1) {   // at+1 is the |---| separator
    if (!lines[i].startsWith('| ')) break;
    rows.push({ index: i + 1, text: lines[i] });
  }
  assert.ok(rows.length >= 10, `the evidence map should have its rows, found ${rows.length} - did the table move?`);
  return rows;
}

const isCaseName = (span) => span.includes(' ') && !span.includes('/') && !span.includes(':');

/** Case names cited in a row, and the suite files that row names. */
function citations(rowText) {
  const spans = [...rowText.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  return {
    cases: spans.filter(isCaseName),
    suites: spans.filter((span) => /^(tests|test)\/[\w./-]+\.(mjs|js)$/.test(span)),
  };
}

const declares = (source, caseName) => source.includes(`test('${caseName}'`) || source.includes(`test("${caseName}"`);

test('every case name the evidence map cites exists as a real node --test case (airhorn-5t0y)', () => {
  const all = suites();
  const missing = [];
  for (const row of evidenceRows()) {
    for (const caseName of citations(row.text).cases) {
      if (!Object.values(all).some((source) => declares(source, caseName))) {
        missing.push(`${DOC}:${row.index} cites ${JSON.stringify(caseName)}, which no suite declares`);
      }
    }
  }
  assert.deepEqual(missing, [],
    'the evidence map cites case names that do not exist - a citation to a case that is not there reads as coverage');
});

test('where a row names its suite, the cited cases come from THAT suite, not merely from somewhere', () => {
  const all = suites();
  const wrong = [];
  for (const row of evidenceRows()) {
    const { cases, suites: named } = citations(row.text);
    if (named.length === 0) continue;                     // row-level citation; covered by the test above
    for (const caseName of cases) {
      const inNamed = named.some((file) => all[file] && declares(all[file], caseName));
      if (!inNamed) wrong.push(`${DOC}:${row.index} cites ${JSON.stringify(caseName)} but ${named.join(', ')} does not declare it`);
    }
  }
  assert.deepEqual(wrong, [], 'a row that names its suite must cite that suite\'s cases - otherwise the citation is unfollowable');
});

test('the map still has rows, and at least the two rows that have drifted before are cited with a suite', () => {
  const rows = evidenceRows();
  assert.ok(rows.length >= 10, 'the evidence map must still be the evidence map');
  // Not a list of case names (that would drift): a list of CLAIMS, which are prose and are meant to be stable.
  const withSuite = rows.filter((row) => citations(row.text).suites.length > 0);
  assert.ok(withSuite.length >= 2, `at least two rows must name the suite they cite, found ${withSuite.length} - `
    + 'a case name with no file on its row is a search, not a citation');
});
