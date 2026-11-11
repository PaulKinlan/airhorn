import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { offlineAssetVerdict, OFFLINE_REFUSAL_SENTENCE } from './support/offline-asset-verdict.mjs';

/*
 * Both directions of the offline-asset pin, browser-free (airhorn-g0qr.2).
 *
 * The browser suite (tests/sw-offline.test.mjs) drives the real worker; this file pins the decision
 * it asks about, so the ACCEPT and REJECT sides are both required rather than implied. Before this,
 * the suite's own assertion was `body !== GARBAGE`, which every REJECT case below satisfies.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const online = { status: 200, body: 'self.__precacheManifest = [{ revision: "abc" }];' };

test('an offline asset answer is accepted only as the real bundle or the intended refusal (airhorn-g0qr.2)', () => {
  // ACCEPT: the two legitimate outcomes, each carrying its own evidence.
  assert.deepEqual(
    offlineAssetVerdict({ online, offline: { status: 200, body: online.body } }),
    { ok: true, how: 'real' },
    'the verified asset, byte-identical to the online bundle, must be accepted as the real one');
  assert.deepEqual(
    offlineAssetVerdict({ online, offline: { status: 503, body: OFFLINE_REFUSAL_SENTENCE } }),
    { ok: true, how: 'refusal' },
    'a 503 carrying the worker\'s own refusal sentence must be accepted as the intended refusal');

  // REJECT: every shape the old `body !== GARBAGE` assertion let through, each named as itself.
  const rejected = {
    'empty-body': { status: 200, body: '' },
    'bare-503-without-the-refusal-sentence': { status: 503, body: '' },
    'not-the-real-bundle': { status: 200, body: 'wrong but non-empty' },
    'no-response': { status: 0 },
    'unexpected-status-404': { status: 404, body: 'not found' },
  };
  for (const [why, offline] of Object.entries(rejected)) {
    const verdict = offlineAssetVerdict({ online, offline });
    assert.equal(verdict.ok, false, `${why} must be REJECTED, got ${JSON.stringify(verdict)}`);
    assert.equal(verdict.why, why, `the rejection must be named "${why}", got ${JSON.stringify(verdict)}`);
  }

  // A body that is present but truncated is not the real bundle either - the "non-empty" trap.
  const truncated = offlineAssetVerdict({ online, offline: { status: 200, body: online.body.slice(0, 10) } });
  assert.equal(truncated.ok, false);
  assert.equal(truncated.why, 'not-the-real-bundle');

  // And a 503 whose body says something else is not the worker's refusal on purpose.
  const wrongSentence = offlineAssetVerdict({ online, offline: { status: 503, body: 'Service Unavailable' } });
  assert.equal(wrongSentence.ok, false);
  assert.equal(wrongSentence.why, 'bare-503-without-the-refusal-sentence');
});

test('the refusal sentence the pin accepts is the one the worker actually ships (airhorn-g0qr.2)', () => {
  // A drift pin, and stated as one: the behavioural evidence is the browser suite driving the real
  // worker. What this catches is the constant and the worker disagreeing, which would turn every
  // legitimate refusal into a named failure with a confusing reason.
  const worker = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
  assert.ok(worker.includes(OFFLINE_REFUSAL_SENTENCE),
    `public/sw.js no longer authors the refusal sentence this pin accepts: ${JSON.stringify(OFFLINE_REFUSAL_SENTENCE)}`);
});
