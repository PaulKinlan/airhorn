// airhorn-g0qr.13: the refusal-message bound must fire whether or not the refusal
// carries a code. Drives the REAL predicate the browser suite uses
// (tests/support/webmcp-refusals.mjs), browser-free.

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
