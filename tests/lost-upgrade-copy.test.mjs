import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLostUpgradeNotice, LOST_UPGRADE_COPY } from './support/lost-upgrade-copy.mjs';
import { liveCode, stripComments } from './support/strip-comments.mjs';

const notice = 'The app could not update - you are still on the previous version.';
const call = 'assertLostUpgradeNotice(lost.text)';

test('the actual lost-upgrade notice passes the enforcer', () => {
  assert.doesNotThrow(() => assertLostUpgradeNotice(notice));
  assert.deepEqual(LOST_UPGRADE_COPY, ['The app could not update', 'previous version']);
});

test('a non-enforcing announcement fails with the missing copy named (airhorn-rrme)', () => {
  // Previously a suite could merely mention the copy in a comment and gate-map stayed green.
  // This checks the shipped enforcer's actual throw, not a token in the browser suite's source.
  for (const [message, missing] of [
    ['The app could not update', 'previous version'],
    ['You are still on the previous version.', 'The app could not update'],
    ['', 'The app could not update'],
  ]) {
    assert.throws(() => assertLostUpgradeNotice(message),
      (error) => error instanceof Error && error.message.includes(`missing "${missing}"`),
      `a notice missing ${missing} must throw rather than merely mention it`);
  }
});

// The fixtures below are the answer to the review finding airhorn-nqje: gate-map used to pin the
// suite's DELEGATION with `suite.includes('assertLostUpgradeNotice(lost.text);')`, which a commented-out
// call satisfied. The pin now searches liveCode(suite), so the four shapes below are the four ways text
// can look like a call without being one.

test('a line-commented call does not survive liveCode (airhorn-nqje)', () => {
  const source = `// ${call};\nconst unrelated = 1;`;
  assert.equal(liveCode(source).includes(call), false,
    'a // comment must not be able to satisfy the delegation pin');
  assert.equal(stripComments(source).includes(call), false);
});

test('a block-commented call does not survive liveCode, one line or many (airhorn-nqje)', () => {
  for (const source of [
    `/* ${call}; */\nconst unrelated = 1;`,
    `/*\n * ${call};\n */\nconst unrelated = 1;`,
    `const a = 1; /* ${call}; */ const b = 2;`,
  ]) {
    assert.equal(liveCode(source).includes(call), false,
      `a /* */ comment must not be able to satisfy the delegation pin: ${JSON.stringify(source)}`);
    assert.equal(stripComments(source).includes(call), false);
  }
});

test('a call inside a string literal is not code (airhorn-nqje)', () => {
  // Two facts, and the second is why the scanner has to be quote-aware rather than a regex sweep:
  // the literal's own contents are not executable, and a "//" or "/*" INSIDE a literal is not a
  // comment start, so the live call after it must still be found.
  const hidden = `const lookalike = '${call};';`;
  assert.equal(liveCode(hidden).includes(call), false,
    'a string literal must not be able to satisfy the delegation pin');
  assert.equal(stripComments(hidden).includes(call), true,
    'stripComments leaves strings alone by design - only liveCode may be used for a pin');

  const afterString = `const url = 'https://example.test/a/*not-a-comment*/'; ${call};`;
  assert.equal(liveCode(afterString).includes(call), true,
    'a // or /* inside a string literal must not swallow the rest of the line');
  assert.ok(stripComments(afterString).includes("'https://example.test/a/*not-a-comment*/'"),
    'stripComments must not damage a literal that contains comment-looking text');

  const template = `const msg = \`${call};\`;`;
  assert.equal(liveCode(template).includes(call), false,
    'a template literal must not be able to satisfy the delegation pin either');
});

test('real code survives liveCode: the call, and division and regexes around it (airhorn-nqje)', () => {
  assert.equal(liveCode(`  ${call};`).trim(), `${call};`,
    'an uncommented call is exactly what the delegation pin looks for');
  // A "/" after an expression is division, after an operator a regex: neither may blank real code.
  for (const source of [
    `const ratio = a / b; ${call};`,
    `const re = /["'\\/]/; ${call};`,
    `if (!re.test(text)) throw new Error('x'); ${call};`,
  ]) {
    assert.equal(liveCode(source).includes(call), true,
      `liveCode must not treat code around a slash as a comment: ${JSON.stringify(source)}`);
  }
});

test('liveCode keeps every byte offset and line break, so a hit quotes the real file', () => {
  const source = `// a\n/* b */\nconst s = 'c';\n  ${call};\n`;
  const live = liveCode(source);
  assert.equal(live.length, source.length, 'offsets must map onto the original file');
  assert.equal(live.split('\n').length, source.split('\n').length, 'line numbers must map too');
  const index = live.indexOf(call);
  assert.ok(index > 0);
  assert.equal(source.slice(index, index + call.length), call,
    'an index into liveCode is an index into the source');
});
