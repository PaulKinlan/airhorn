// airhorn-g0qr.13: the refusal-message bound must fire whether or not the refusal
// carries a code. Drives the REAL predicate the browser suite uses
// (tests/support/webmcp-refusals.mjs), browser-free.

import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { refusalMessageViolations, REFUSAL_MESSAGE_MAX } from './support/webmcp-refusals.mjs';

test('a code-less refusal with an over-long message violates the bound (g0qr.13)', () => {
  const huge = { error: 'X'.repeat(REFUSAL_MESSAGE_MAX + 1) }; // no code
  const violations = refusalMessageViolations('megabyte-no-code', huge);
  assert.equal(violations.length, 1, 'a code-less refusal must NOT exempt the length bound');
  assert.match(violations[0], /-character error message/);
});

test('a coded refusal with an over-long message still violates the bound', () => {
  const violations = refusalMessageViolations('coded-huge', { code: 'invalid_input', error: 'X'.repeat(REFUSAL_MESSAGE_MAX + 1) });
  assert.equal(violations.length, 1);
});

test('a coded refusal with no usable message violates the blank rule (code-gated, unchanged)', () => {
  assert.equal(refusalMessageViolations('blank', { code: 'invalid_input', error: '   ' }).length, 1);
  assert.equal(refusalMessageViolations('absent', { code: 'invalid_input' }).length, 1);
});

test('well-formed refusals pass: coded+short, code-less+short, no error at all', () => {
  assert.deepEqual(refusalMessageViolations('ok1', { code: 'invalid_input', error: 'nope' }), []);
  assert.deepEqual(refusalMessageViolations('ok2', { error: 'short but code-less' }), []);
  assert.deepEqual(refusalMessageViolations('ok3', {}), []);
});

// The call-site pin (coord's requirement: the pin must not pass while the suite ignores
// the predicate). Text-level, and honest about what that proves: the suite invokes the
// shared predicate and does not carry the old inline gated form. It does NOT prove the
// loop's wiring beyond that - the browser suite itself remains the behavioural proof.
test('the browser suite drives the shared predicate (call-site pin)', () => {
  const suite = fs.readFileSync(new URL('./webmcp-browser.test.mjs', import.meta.url), 'utf8');
  assert.match(suite, /refusalMessageViolations\(entry\.label, entry\.result\)/,
    'the hostile-input loop must call the shared predicate');
  assert.doesNotMatch(suite, /entry\.result\.code && entry\.result\.error\.length/,
    'the old code-gated inline bound must not return');
});
