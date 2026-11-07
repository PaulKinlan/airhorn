/*
 * The evidence map in docs/webmcp-tools.md promises: "Every claim above, and the code or test that pins it. Test names
 * are the node --test case names." That promise is only worth anything if the names are the CURRENT names: after a
 * rename, a reader greps the documented name, finds nothing, and cannot tell a stale doc from a missing test
 * (airhorn-5t0y - our own evidence map named two cases that airhorn-9sbz had renamed).
 *
 * So this is a DOC-DRIFT pin, not a behaviour pin. It reads the doc and the suite as text on purpose: the fact it
 * establishes is about what the documentation says, which no runtime observation can check. It does NOT infer anything
 * about the tool from prose - the behaviour claims are pinned by the suites themselves (ADR 0001).
 *
 * Deliberately narrow: the two rows that have actually drifted, both directions. A general "every backticked phrase
 * must be a case name" rule would fail on the rows that legitimately cite code identifiers, and a rule that is switched
 * off for half the table is not a rule.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

// claim (for the failure message) -> case name the evidence map must cite, and the suite that must really have it
const PINNED = [
  ['start timeout abandons AND silences', 'a start that never settles times out on its own timer and is silenced', 'tests/webmcp-fuzz.test.mjs'],
  ['input validated, payload never echoed', 'a hostile megabyte payload is refused without processing or echoing it', 'tests/webmcp-fuzz.test.mjs'],
];

test('the evidence map cites the case names that exist today (airhorn-5t0y)', () => {
  const doc = read('docs', 'webmcp-tools.md');
  for (const [claim, caseName] of PINNED) {
    assert.ok(doc.includes(caseName),
      `docs/webmcp-tools.md must cite the CURRENT case name for "${claim}": ${JSON.stringify(caseName)}. `
      + 'If the case was renamed, the evidence map has to move with it or a reader greps a name that does not exist');
  }
});

test('every cited case name is a real node --test case in the suite it names (airhorn-5t0y)', () => {
  for (const [claim, caseName, suite] of PINNED) {
    const source = read(suite);
    assert.ok(source.includes(`test('${caseName}'`) || source.includes(`test("${caseName}"`),
      `${suite} must actually declare the case name the evidence map cites for "${claim}": ${JSON.stringify(caseName)}. `
      + 'A citation to a case that does not exist is worse than no citation: it reads as coverage');
  }
});

test('the evidence map still names the suite ON THE SAME ROW as the case, so the citation can be followed', () => {
  const rows = read('docs', 'webmcp-tools.md').split('\n').filter((line) => line.startsWith('| '));
  for (const [claim, caseName, suite] of PINNED) {
    // Per ROW, not per file (airhorn-5t0y): a file-wide search passes while one row has lost its citation and the
    // other still carries one, which is exactly the drift a reader hits.
    const row = rows.find((line) => line.includes(caseName));
    assert.ok(row, `the evidence map must have a row citing ${JSON.stringify(caseName)} for "${claim}"`);
    assert.ok(row.includes(suite), `the row citing ${JSON.stringify(caseName)} must also name ${suite} - a case name `
      + `with no file on its own row is a search, not a citation. Row was: ${row}`);
  }
});
