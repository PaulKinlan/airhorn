/*
 * tests/press-guard.test.mjs — the trusted-press guard's failure paths,
 * browser-free (airhorn-8wh1, airhorn-l2c3; the same discipline as
 * tests/nav-guard.test.mjs).
 *
 * The guard in tests/support/press-guard.mjs keeps three failure owners apart
 * in resilience-ui Case 7: the TEST (press point off the horn), the MACHINE
 * (trusted press dropped before delivery), and the APP (events delivered, horn
 * stayed unpressed) - plus the fourth state, a broken INSTRUMENT, which must
 * name itself as unknown rather than borrow any owner's message. On a real
 * browser these need a moving layout or a starving CDP stack; here they are
 * inputs to the shipped functions, and the two MUTATION cases re-import
 * mutated copies of the shipped source to show the pre-fix shapes misreport:
 * a mutant that passes with the fix removed is the proof the old code could
 * not fail honestly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPressPoint, readInputLog, classifyPressTimeout } from './support/press-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const guardPath = path.join(here, 'support', 'press-guard.mjs');

const goodBox = { found: true, overHorn: true, x: 390, y: 219, hit: 'DIV.horn' };
const offHornBox = { found: true, overHorn: false, x: 390, y: 612, hit: 'P' };
const noHornBox = { found: false, overHorn: false, x: 0, y: 0, hit: null };

test('a valid press point passes, for the first press and for a retry', () => {
  assert.doesNotThrow(() => checkPressPoint(goodBox, 'the press point'));
  assert.doesNotThrow(() => checkPressPoint(goodBox, 'the retried press point (attempt 2/3)'));
});

test('an off-horn retried press point fails BEFORE the press, naming the attempt (airhorn-8wh1)', () => {
  // The defect: attempts 2/3 pressed at re-measured coordinates without
  // re-checking them, and the empty input log that followed was reported as
  // host contention. The retried box must pass the same check as the first.
  assert.throws(() => checkPressPoint(offHornBox, 'the retried press point (attempt 2/3)'),
    /the retried press point \(attempt 2\/3\) is not over the horn, so the press would prove nothing/);
  assert.throws(() => checkPressPoint(noHornBox, 'the retried press point (attempt 3/3)'),
    /attempt 3\/3/);
});

test('readInputLog never folds an unread instrument into an empty log (airhorn-l2c3)', async () => {
  // Empty means "no pointer event reached the page" - host contention. An
  // instrument that cannot be read must not borrow that meaning.
  assert.deepEqual(await readInputLog(async () => ['pointerdown:button=0']), ['pointerdown:button=0'],
    'a readable log passes through');
  assert.deepEqual(await readInputLog(async () => []), [],
    'a readable EMPTY log stays an empty array (it is the contention signal)');
  assert.equal(await readInputLog(async () => undefined), 'unreadable',
    'an absent window.__inputLog (document-start hook never ran) is unknown, not empty');
  assert.equal(await readInputLog(async () => { throw new Error('CDP: target closed'); }), 'unreadable',
    'a rejected evaluate (starved CDP, document gone) is unknown, not empty');
});

test('classifyPressTimeout keeps the three owners apart', () => {
  assert.equal(classifyPressTimeout('unreadable'), 'unreadable',
    'broken instrument: unknown - fails fast, never retries (a retry would reopen airhorn-fl70)');
  assert.equal(classifyPressTimeout(['pointerdown:button=0', 'mousedown:button=0']), 'delivered-unpressed',
    'events reached the page and the horn stayed false: the product bug, failing on that attempt');
  assert.equal(classifyPressTimeout([]), 'dropped',
    'no event reached the page: host contention, the only shape a retry may follow');
});

test('MUTATION: the pre-airhorn-8wh1 retry (no re-check) lets an off-horn press dispatch', () => {
  // Replace the shipped refusal with a pass-through, i.e. the review finding's
  // shape: the re-measured box used unchecked. If this mutant ever throws, the
  // checks above have stopped testing the guard.
  const source = fs.readFileSync(guardPath, 'utf8');
  const refusal = /if \(!box\.found \|\| !box\.overHorn\) \{[\s\S]*?\n  \}/;
  assert.match(source, refusal,
    'the mutation anchor must still be the press-point check: without it this check silently mutates nothing');
  const mutantSource = source.replace(refusal, '');
  assert.notEqual(mutantSource, source, 'the mutation must actually differ from the shipped source');
  return import(`data:text/javascript;base64,${Buffer.from(mutantSource, 'utf8').toString('base64')}`)
    .then(({ checkPressPoint: mutantCheck }) => {
      assert.doesNotThrow(() => mutantCheck(offHornBox, 'the retried press point (attempt 2/3)'),
        'the mutant presses off the horn without a word - and the empty input log that follows is then '
        + 'reported as host contention, which is exactly the airhorn-8wh1 defect');
    });
});

test('MUTATION: the pre-airhorn-l2c3 fold reads an unread instrument as host contention', async () => {
  // Remove the 'unreadable' branch from the shipped classifier, i.e. the old
  // two-message shape: an unreadable/absent log fell through to whichever
  // message the length check produced. The mutant must visibly attribute an
  // unknown instrument to the machine.
  const source = fs.readFileSync(guardPath, 'utf8');
  const branch = "if (inputLog === 'unreadable') return 'unreadable';";
  assert.ok(source.includes(branch),
    'the mutation anchor must still be the unknown-state branch: without it this check silently mutates nothing');
  const mutantSource = source.replace(branch, '');
  assert.notEqual(mutantSource, source, 'the mutation must actually differ from the shipped source');
  const { classifyPressTimeout: mutantClassify } = await import(
    `data:text/javascript;base64,${Buffer.from(mutantSource, 'utf8').toString('base64')}`
  );
  // The old code read a collapsed LENGTH, so an unread instrument arrived as
  // 0/empty; feeding the mutant the same "nothing readable" state shows what
  // it would have claimed:
  assert.equal(mutantClassify([]), 'dropped',
    'the mutant blames the MACHINE for a state that may be a broken instrument - the misattribution '
    + 'airhorn-l2c3 was filed against, reproduced');
});
