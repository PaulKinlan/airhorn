import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLostUpgradeNotice, LOST_UPGRADE_COPY } from './support/lost-upgrade-copy.mjs';

const notice = 'The app could not update - you are still on the previous version.';

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
