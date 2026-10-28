/*
 * tests/bounds.test.mjs — tests/support/bounds.mjs behaves on both branches
 * (airhorn-dwbl)
 *
 * The suites that spawn the real server and wait on real children must fail on a
 * wrong payload, never on a client-side TimeoutError from a starved host. This
 * file pins the mechanics with a scripted fetch and an injected steal reading,
 * so both branches are driven on ANY machine (docs/speed.md independence): no
 * /proc reads, no server, no child processes.
 *
 * Run with: npm test (the fast gate builds dist/ first)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { hostStealOnce, stretchMs, fetchUntil } from './support/bounds.mjs';

const timeoutErr = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
const refusedErr = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });

// A scripted fetch: rejects with each error in `failures` (one per attempt),
// then resolves `answer`, counting every call.
const scriptedFetch = (failures, answer) => {
  let calls = 0;
  const impl = async () => {
    const n = ++calls;
    if (n <= failures.length) throw failures[n - 1];
    return typeof answer === 'function' ? answer() : answer;
  };
  return { impl, calls: () => calls };
};

test('stretchMs is the w1wh formula: exact on a healthy or unknown host, stretched and capped otherwise', () => {
  assert.equal(stretchMs(5000, 0), 5000, 'a healthy host keeps its bounds exactly');
  assert.equal(stretchMs(30000, null), 30000, 'an unknown reading must not invent a bound');
  assert.equal(stretchMs(5000, 0.5), 10000, '1/(1-steal) at 0.5 is 2x');
  assert.equal(stretchMs(5000, 0.96), 40000, 'the stretch is capped at 8x');
});

test('hostStealOnce returns a number or null and caches the reading', () => {
  const first = hostStealOnce();
  assert.ok(first === null || (typeof first === 'number' && first >= 0 && first <= 1),
    `the reading must be null or a 0..1 fraction, got ${JSON.stringify(first)}`);
  assert.equal(hostStealOnce(), first, 'the reading is cached: the probe windows cost ~1s, steal moves over minutes');
});

test('fetchUntil returns the FIRST response untouched: a wrong payload fails fast, on attempt 1', async () => {
  const { impl, calls } = scriptedFetch([], new Response('{"status":"broken"}', { status: 200 }));
  const res = await fetchUntil('http://127.0.0.1:1/health', {}, { baseMs: 5000, steal: 0, fetch: impl });
  assert.equal(await res.text(), '{"status":"broken"}', 'the response is judged by the caller, never retried away');
  assert.equal(calls(), 1, `a response is an answer: got ${calls()} attempt(s)`);
});

test('fetchUntil retries a transport timeout until a slow-but-correct server answers', async () => {
  const { impl, calls } = scriptedFetch([timeoutErr(), timeoutErr()],
    new Response('{"status":"ok"}', { status: 200 }));
  const res = await fetchUntil('http://127.0.0.1:1/health', {}, { baseMs: 5000, steal: 0, fetch: impl, retryGapMs: 1 });
  assert.equal(res.status, 200);
  assert.equal(calls(), 3, `the timeout is retried until an answer arrives: got ${calls()} attempt(s)`);
});

test('fetchUntil retries connection-refused shapes too, then answers', async () => {
  const { impl, calls } = scriptedFetch([refusedErr()],
    new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  const res = await fetchUntil('http://127.0.0.1:1/', {}, { baseMs: 5000, steal: 0, fetch: impl, retryGapMs: 1 });
  assert.equal(res.status, 200);
  assert.equal(calls(), 2);
});

test('fetchUntil gives up at the (stretched) deadline with a diagnostic, not a bare TimeoutError', async () => {
  let calls = 0;
  const alwaysTimeout = async () => { calls += 1; throw timeoutErr(); };
  const t0 = Date.now();
  await assert.rejects(
    () => fetchUntil('http://127.0.0.1:1/health', {}, { baseMs: 50, steal: 0, fetch: alwaysTimeout, retryGapMs: 5 }),
    (err) => {
      assert.match(err.message, /no response from http:\/\/127\.0\.0\.1:1\/health within 50ms/);
      assert.match(err.message, /base 50ms, steal 0/);
      assert.match(err.message, /after \d+ attempt\(s\)/);
      assert.match(err.message, /aborted due to timeout/, 'the last transport error is carried for diagnosis');
      return true;
    });
  const spent = Date.now() - t0;
  assert.ok(spent >= 50, `must wait at least the bound before giving up (spent ${spent}ms)`);
  assert.ok(spent < 2000, `an expired bound must not hang the suite (spent ${spent}ms)`);
  assert.ok(calls >= 1, `the fetch was attempted at least once (${calls} call(s))`);
});

test('fetchUntil stretches its deadline with steal: a forced slow-but-correct server passes', async () => {
  // The acceptance case from the bead, forced: the server answers CORRECTLY but
  // only after 250ms — far past a 100ms base bound, well inside the 800ms the
  // 0.96 reading stretches it to. This is exactly the TimeoutError shape that
  // failed a green suite on the starved gate, and here it passes instead.
  let calls = 0;
  const t0 = Date.now();
  const slowButCorrect = async () => {
    calls += 1;
    if (Date.now() - t0 < 250) throw timeoutErr();
    return new Response('{"status":"ok"}', { status: 200 });
  };
  const res = await fetchUntil('http://127.0.0.1:1/health', {}, { baseMs: 100, steal: 0.96, fetch: slowButCorrect, retryGapMs: 20 });
  assert.equal(res.status, 200, 'a slow-but-correct server passes on the stretched deadline');
  assert.ok(Date.now() - t0 >= 250, 'the server really was slow, or this proves nothing');
  assert.ok(calls >= 2, 'the answer came from a retry, not the first attempt');
});

test('fetchUntil fails fast on a non-transport error: a caller bug is not a slow host', async () => {
  const { impl, calls } = scriptedFetch([], new Response('{}', { status: 200 }));
  const badUrl = async () => { throw new TypeError('Failed to parse URL'); };
  await assert.rejects(() => fetchUntil('http://127.0.0.1:1/health', {}, { baseMs: 5000, steal: 0, fetch: badUrl }),
    /Failed to parse URL/);
  assert.equal(calls(), 0, 'the scripted fetch is never reached; the caller bug throws on attempt 1');
});
