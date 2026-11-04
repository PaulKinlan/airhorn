import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLostUpgradeNotice, lostUpgradeVerdicts, LOST_UPGRADE_COPY } from './support/lost-upgrade-copy.mjs';
import { guardedCallProblem } from '../tools/guarded-call.mjs';

const notice = 'The app could not update - you are still on the previous version.';
const SPEC = { callee: 'assertLostUpgradeNotice', from: './support/lost-upgrade-copy.mjs' };

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

test('the enforcer records that it ran and what it decided (airhorn-6829)', () => {
  const before = lostUpgradeVerdicts().length;
  assertLostUpgradeNotice(notice);
  assert.throws(() => assertLostUpgradeNotice('nothing to see here'));
  const verdicts = lostUpgradeVerdicts().slice(before);
  assert.deepEqual(verdicts.map((v) => [v.ran, v.ok]),
    [[true, true], [true, false]],
    'a call that passes and a call that throws must both be recorded as having run');
  assert.equal(verdicts[1].missing, 'The app could not update');
});

// The fixtures below are the answer to review findings airhorn-rrme and airhorn-nqje. Two rounds of
// text pins were satisfied by text: a commented-out call, a block-commented call, and a stringified
// call all counted. The pin is now a question about the syntax tree, so the hostile worlds below are
// exactly the worlds a text rule cannot separate from the real thing.

test('the shipped delegation shape is GREEN (and so is a harness-wrapped bare statement)', () => {
  const shipped = [
    "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';",
    '',
    'async function testBootWatchdog() {',
    '  const lost = await readLost();',
    '  await shot("lost-upgrade-announced");',
    '  assertLostUpgradeNotice(lost.text);',
    '  if (/new version is ready/i.test(lost.text)) throw new Error("nope");',
    '}',
  ].join('\n');
  assert.equal(guardedCallProblem(shipped, SPEC), null);

  const insideHarness = [
    "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';",
    "test('lost upgrade', async () => {",
    '  assertLostUpgradeNotice("The app could not update - previous version.");',
    '});',
  ].join('\n');
  assert.equal(guardedCallProblem(insideHarness, SPEC), null,
    'a test() callback is not a swallow: the harness is what reports the failure');
});

test('hostile world (i): the call DELETED is RED', () => {
  const source = [
    "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';",
    'async function testBootWatchdog() {',
    '  const lost = await readLost();',
    '}',
  ].join('\n');
  assert.match(guardedCallProblem(source, SPEC) ?? '', /never calls assertLostUpgradeNotice/);
});

test('hostile world (ii): the call COMMENTED OUT is RED (a comment is not in the tree)', () => {
  for (const source of [
    [
      "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';",
      'async function testBootWatchdog() {',
      '  // assertLostUpgradeNotice(lost.text);',
      '}',
    ].join('\n'),
    [
      "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';",
      'async function testBootWatchdog() {',
      '  /*',
      '   * assertLostUpgradeNotice(lost.text);',
      '   */',
      '}',
    ].join('\n'),
    [
      "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';",
      'async function testBootWatchdog() {',
      "  const note = 'assertLostUpgradeNotice(lost.text);';",
      '}',
    ].join('\n'),
  ]) {
    assert.match(guardedCallProblem(source, SPEC) ?? '', /never calls assertLostUpgradeNotice/,
      `a commented-out or stringified call must not satisfy the pin: ${JSON.stringify(source)}`);
  }
});

test('hostile world (iii): the throw SWALLOWED is RED - try/catch, .catch(), .finally()', () => {
  const head = "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';\nasync function run() {\n";
  for (const [label, body, expected] of [
    ['try/catch that discards', '  try { assertLostUpgradeNotice(lost.text); } catch {}', /try\/catch/],
    ['try/catch with a named binding', '  try { assertLostUpgradeNotice(lost.text); } catch (e) { void e; }', /try\/catch/],
    ['try/catch/finally', '  try { assertLostUpgradeNotice(lost.text); } catch (e) { void e; } finally { report(); }', /try\/catch/],
    ['promise .catch arrow with a block', '  work().catch(() => { assertLostUpgradeNotice(lost.text); });', /\.catch\(\)/],
    ['promise .catch arrow with an expression', '  work().catch(() => assertLostUpgradeNotice(lost.text));', /\.catch\(\)/],
    ['promise .finally', '  work().finally(() => { assertLostUpgradeNotice(lost.text); });', /\.finally\(\)/],
  ]) {
    const problem = guardedCallProblem(`${head}${body}\n}`, SPEC);
    assert.match(problem ?? '', expected, `${label} must be RED, got ${JSON.stringify(problem)}`);
  }

  // try/finally is the shipped shape (the browser is closed in a finally): it cannot
  // discard the throw, so it must stay GREEN or the pin reds the real file.
  const tryFinally = `${head}  try { assertLostUpgradeNotice(lost.text); } finally { await browser.close(); }\n}`;
  assert.equal(guardedCallProblem(tryFinally, SPEC), null,
    'try/finally propagates the throw and the shipped case is wrapped in one');
});

test('hostile world (iv): the call REPLACED by something that returns is RED', () => {
  // A local lookalike shadows the import: it can return instead of throwing, and a call-shaped pin
  // cannot tell the difference. The pin resolves the callee to the shipped binding, so this is RED.
  const lookalike = [
    "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';",
    'function assertLostUpgradeNotice(text) { return text; }',
    'async function run() {',
    '  assertLostUpgradeNotice(lost.text);',
    '}',
  ].join('\n');
  assert.match(guardedCallProblem(lookalike, SPEC) ?? '', /declares its own assertLostUpgradeNotice/);

  // The same shape via a variable, and a replacement that is simply a different callee.
  const viaVariable = [
    "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';",
    'const assertLostUpgradeNotice = (text) => text;',
    'async function run() {',
    '  assertLostUpgradeNotice(lost.text);',
    '}',
  ].join('\n');
  assert.match(guardedCallProblem(viaVariable, SPEC) ?? '', /declares its own assertLostUpgradeNotice/);

  const noImport = [
    'function assertLostUpgradeNotice(text) { return text; }',
    'async function run() {',
    '  assertLostUpgradeNotice(lost.text);',
    '}',
  ].join('\n');
  assert.match(guardedCallProblem(noImport, SPEC) ?? '', /must import assertLostUpgradeNotice/);
});

test('a conditional, looped or returned call is RED - each can discard the failure', () => {
  const head = "import { assertLostUpgradeNotice } from './support/lost-upgrade-copy.mjs';\nasync function run() {\n";
  for (const [label, body] of [
    ['if (false) { ... }', '  if (false) { assertLostUpgradeNotice(lost.text); }'],
    ['a ternary', '  const ok = lost ? assertLostUpgradeNotice(lost.text) : true;'],
    ['&& short-circuit', '  lost && assertLostUpgradeNotice(lost.text);'],
    ['a for loop', '  for (const one of list) assertLostUpgradeNotice(one.text);'],
    ['a return', '  return assertLostUpgradeNotice(lost.text);'],
    ['an await', '  await assertLostUpgradeNotice(lost.text);'],
    ['a bare call in a .map() callback', '  list.map((one) => assertLostUpgradeNotice(one.text));'],
  ]) {
    const problem = guardedCallProblem(`${head}${body}\n}`, SPEC);
    assert.ok(problem, `${label} must be RED, got GREEN`);
  }
});
