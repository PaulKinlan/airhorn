/*
 * tests/health.test.mjs — GET /health tells the truth about the running build (airhorn-uexx)
 *
 * server.ts is the production origin (docs/runbooks/DEPLOY.md): a Deno static server over
 * dist/. Its /health endpoint reports status, version, commit sha and build
 * timestamp, and the contract this suite pins is the one an operator leans on:
 *
 *   1. the JSON shape and content-type are exactly what the docs promise, and
 *      version + commit are non-empty (never silently blank);
 *   2. run-time resolution is REAL: the commit equals this checkout's
 *      `git rev-parse --short HEAD`, and the timestamp is fresh — proof the
 *      fallbacks work without any build-time injection;
 *   3. build-time injection wins: APP_VERSION / GIT_COMMIT / BUILD_TIMESTAMP
 *      are echoed verbatim, so CI can stamp a deploy without editing code;
 *   4. resolution happens ONCE: the body is fixed at startup, so it survives a
 *      second GET byte-identically AND still reports the old sha after the
 *      checkout's HEAD moves under the running server (a per-request
 *      `git rev-parse` would report the new one) — the cheap-under-load promise;
 *   5. the route did not break the server it sits on: HEAD/POST behave, and
 *      the static app still serves.
 *
 * Every case drives the real server — `deno run server.ts` on an ephemeral
 * port (PORT=0, parsed from the server's own listening line) — so this is the
 * dev/prod path itself, not a reimplementation. Skips loudly when deno is not
 * installed (gate-smoke still parses server.ts on those machines).
 *
 * Run with: npm test (the fast gate builds dist/ first)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const serverTs = path.join(root, 'server.ts');

const distDir = path.join(root, 'dist');
if (!fs.existsSync(distDir)) {
  throw new Error('dist directory does not exist. Run build first.');
}

const findDeno = () => {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'deno');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
};

const deno = findDeno();
const shortSha = () => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

// The child gets a scrubbed env: no inherited APP_VERSION/GIT_COMMIT/BUILD_TIMESTAMP
// from an outer build, so a case's result never depends on the machine's ambient state.
function childEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of ['APP_VERSION', 'GIT_COMMIT', 'COMMIT_SHA', 'BUILD_TIMESTAMP']) delete env[key];
  return { ...env, PORT: '0', ...overrides };
}

// Start the real server; resolve { url, wait, kill } once it prints its port.
// Every wait is bounded so a wedged server fails the case instead of the gate.
// `where` runs a *copy* of server.ts in another directory: it resolves its
// commit from import.meta.dirname, so the copy reports that directory's git.
function startServer(overrides = {}, readyTimeoutMs = 30000, where = {}) {
  return new Promise((resolve, reject) => {
    // The spawn/listening bracket (airhorn-g0qr.6): server.ts fixes BUILD_TIMESTAMP at
    // module load, which is after this line and before the listening line, so a fresh
    // fallback timestamp must land inside [spawnedAt, listeningAt]. The bracket is what
    // makes "fresh" falsifiable - a fixed window was not (see the assertion below).
    const spawnedAt = Date.now();
    const child = spawn(deno, ['run', '--no-prompt', '--allow-net', '--allow-read', '--allow-env', '--allow-run=git', where.serverFile ?? serverTs], {
      cwd: where.cwd ?? root,
      env: childEnv(overrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let ready = false;
    const timer = setTimeout(() => {
      reject(new Error(`server did not report a port in ${readyTimeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`));
      child.kill('SIGKILL');
    }, readyTimeoutMs);
    const onData = (chunk) => {
      stdout += chunk;
      if (ready) return;
      // server.ts's own listening line is the port contract (PORT=0 -> ephemeral) AND the
      // address contract (airhorn-bs19): it prints the interface it actually bound, so a test
      // can read the bind back instead of trusting the flag it passed.
      const match = stdout.match(/serving dist\/ on (?:[a-z]+:\/\/)?([^:\s]+):(\d+)/);
      if (!match) return;
      ready = true;
      clearTimeout(timer);
      const host = match[1];
      const port = Number(match[2]);
      const url = `http://127.0.0.1:${port}`;
      resolve({
        url,
        host,
        spawnedAt,
        listeningAt: Date.now(),
        fetch: (p, init) => fetch(url + p, { ...init, signal: AbortSignal.timeout(5000) }),
        kill: async () => {
          child.kill('SIGTERM');
          const exited = new Promise((done) => child.once('exit', done));
          const force = new Promise((done) => setTimeout(() => { child.kill('SIGKILL'); done(); }, 2000));
          await Promise.race([exited, force]);
        },
      });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code) => {
      if (ready) return;
      clearTimeout(timer);
      reject(new Error(`server exited before listening (code ${code})\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

test('GET /health on the real deno server: shape, truth, cheapness', async (t) => {
  if (!deno) return t.skip('deno is not installed on this machine; /health is served by server.ts');
  const srv = await startServer();
  try {
    const res = await srv.fetch('/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    const body = await res.json();

    assert.equal(body.status, 'ok');
    assert.equal(typeof body.version, 'string');
    assert.ok(body.version.length > 0, 'version must be non-empty');
    assert.equal(body.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
      'version falls back to package.json');

    assert.equal(typeof body.commit, 'string');
    assert.ok(body.commit.length > 0, 'commit must be non-empty');
    assert.equal(body.commit, shortSha(), 'commit falls back to this checkout\'s short sha');

    assert.equal(typeof body.buildTimestamp, 'string');
    const ts = Date.parse(body.buildTimestamp);
    assert.ok(Number.isFinite(ts), `buildTimestamp must be ISO-8601, got ${JSON.stringify(body.buildTimestamp)}`);
    // Bracket, not a fixed window (airhorn-g0qr.6). The old read was
    // `Math.abs(Date.now() - ts) < 5 * 60 * 1000`, which accepted ANY timestamp within
    // five minutes of the read - a hardcoded stamp offset by 60s at startup passed, and
    // it never said the stamp was the SERVER's start rather than a build-time constant.
    // The honest claim is that a non-injected stamp is this child's start: server.ts
    // resolves it at module load, i.e. after `spawnedAt` and before the listening line,
    // so the whole 5-minute window collapses to the two facts observed here.
    assert.ok(ts >= srv.spawnedAt,
      `buildTimestamp must not predate the server start (started ${new Date(srv.spawnedAt).toISOString()}, stamp ${body.buildTimestamp})`);
    assert.ok(ts <= srv.listeningAt,
      `buildTimestamp must not postdate the server listening (listening ${new Date(srv.listeningAt).toISOString()}, stamp ${body.buildTimestamp})`);
    // The bracket is only evidence while it is narrow: a 5-minute-wide bracket would be
    // the old assertion wearing a new shape, so the width itself is asserted.
    assert.ok(srv.listeningAt - srv.spawnedAt < 60 * 1000,
      `the start bracket must be under a minute to prove freshness, was ${srv.listeningAt - srv.spawnedAt}ms`);

    // A repeated GET is byte-identical. That alone is NOT proof of "resolved
    // once" — a per-request `git rev-parse` would also return the same sha. The
    // case below moves the checkout under a running server, where a per-request
    // resolution and a startup snapshot must disagree; this is just the cheap
    // shape check.
    const again = await srv.fetch('/health');
    assert.equal(await again.text(), JSON.stringify(body), 'a repeated GET must be byte-identical');

    assert.deepEqual(Object.keys(body).sort(), ['buildTimestamp', 'commit', 'status', 'version'],
      'no extra fields: the endpoint carries no secrets');
  } finally {
    await srv.kill();
  }
});

test('resolution happens once: /health holds its snapshot while the checkout moves', async (t) => {
  if (!deno) return t.skip('deno is not installed on this machine; /health is served by server.ts');
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    return t.skip('git is not installed on this machine; the commit fallback needs it too');
  }

  // A throwaway root with its own .git and a copy of server.ts, so this case can
  // rewrite HEAD between two requests. A snapshot taken at startup keeps saying
  // the old sha; a per-request `git rev-parse` would report the new one.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'airhorn-health-once-'));
  const scratchServer = path.join(scratch, 'server.ts');
  const git = (...args) => execFileSync('git', [
    '-c', 'user.email=health-test@example.invalid',
    '-c', 'user.name=health test',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], { cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const headSha = () => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: scratch, encoding: 'utf8' }).trim();

  try {
    fs.copyFileSync(serverTs, scratchServer);
    // A version this case can recognise: proof the copy is what is running, not
    // the repo checkout that happens to be sitting beside it.
    fs.writeFileSync(path.join(scratch, 'package.json'), JSON.stringify({ version: '0.0.0-scratch-root' }));
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'first');
    const before = headSha();

    const srv = await startServer({}, 30000, { cwd: scratch, serverFile: scratchServer });
    try {
      const first = await srv.fetch('/health');
      assert.equal(first.status, 200);
      const firstText = await first.text();
      const body = JSON.parse(firstText);
      assert.equal(body.version, '0.0.0-scratch-root', 'the copy in the throwaway root is what served this');
      assert.equal(body.commit, before, 'commit comes from the git in that root');

      // Move the checkout under the running server.
      git('commit', '-q', '--allow-empty', '-m', 'second');
      const after = headSha();
      assert.notEqual(after, before,
        'instrument check: the checkout must really have moved, or this case proves nothing');

      const second = await srv.fetch('/health');
      const secondText = await second.text();
      assert.equal(secondText, firstText, 'the served body is fixed at startup, not re-derived per request');
      assert.equal(JSON.parse(secondText).commit, before,
        `a per-request resolution would now report ${after}; /health must still report ${before}`);
    } finally {
      await srv.kill();
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('build-time env overrides are echoed verbatim', async (t) => {
  if (!deno) return t.skip('deno is not installed on this machine; /health is served by server.ts');
  const srv = await startServer({
    APP_VERSION: '9.9.9-health-test',
    GIT_COMMIT: 'cafe1234567',
    BUILD_TIMESTAMP: '2026-10-21T00:00:00.000Z',
  });
  try {
    const res = await srv.fetch('/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      status: 'ok',
      version: '9.9.9-health-test',
      commit: 'cafe1234567',
      buildTimestamp: '2026-10-21T00:00:00.000Z',
    });
  } finally {
    await srv.kill();
  }
});

test('HEAD answers like GET (empty body), other methods get 405, and the app still serves', async (t) => {
  if (!deno) return t.skip('deno is not installed on this machine; /health is served by server.ts');
  const srv = await startServer();
  try {
    const get = await srv.fetch('/health');
    const getBody = await get.text();
    const head = await srv.fetch('/health', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(await head.text(), '');
    // RFC 9110 9.3.2: HEAD sends the same header fields as GET. The bug this
    // pins (airhorn-ld31) was invisible here because only status, type and an
    // empty body were asserted: the server declared content-length: 0, claiming
    // an empty entity for an endpoint whose body is the entire point.
    assert.equal(head.headers.get('content-length'), String(new TextEncoder().encode(getBody).byteLength),
      'HEAD /health must declare the content-length GET would send, not 0');
    assert.equal(head.headers.get('content-length'), get.headers.get('content-length'),
      'HEAD and GET must agree on content-length');

    const post = await srv.fetch('/health', { method: 'POST' });
    assert.equal(post.status, 405);
    // RFC 9110 15.5.6: a 405 MUST carry Allow listing every supported method.
    // Assert the exact method SET, order-insensitive: a substring regex accepts
    // GET_MUTATED and never notices a missing HEAD (airhorn-g0qr.7).
    const allowMethods = (post.headers.get('allow') || '')
      .split(',').map((m) => m.trim().toUpperCase()).filter(Boolean).sort();
    assert.deepEqual(allowMethods, ['GET', 'HEAD'],
      '405 Allow must list exactly the methods /health supports: GET and HEAD');

    const home = await srv.fetch('/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type') || '', /text\/html/,
      'the static app must still serve with the /health route in front of it');
  } finally {
    await srv.kill();
  }
});

/* airhorn-bs19: the self-host origin shipped dist/ with none of the response headers the
 * Pages origin gets from public/_headers (airhorn-kv7m). The fix is a constant in server.ts,
 * so the pin that matters is PARITY: every header public/_headers declares must come back on
 * the wire from this server, with the same value, on both a static file and /health. Parsing
 * the file rather than restating its values means the CSP (airhorn-xnd1) could not land in
 * _headers and be forgotten here - it did land, and this test is what made server.ts carry it
 * (the absence assertion that used to sit below flipped with the same commit, exactly as
 * tests/pages-config.test.js's kv7m one did). */
test('the self-host origin sends exactly the policy headers public/_headers declares', async (t) => {
  if (!deno) return t.skip('deno is not installed on this machine; the headers are served by server.ts');
  const { parsePagesHeaders } = await import('../tools/lib/static-server.mjs');
  const declared = parsePagesHeaders(fs.readFileSync(path.join(root, 'public/_headers'), 'utf8'));
  assert.ok(Object.keys(declared).length >= 5,
    `public/_headers must still declare the policy set this test compares against, got ${JSON.stringify(declared)}`);

  const srv = await startServer();
  try {
    // '/' is a STATIC FILE through serveDir; '/health' is the JSON route. Both must carry the
    // policy, because the header gap was in the static path while /health had its own map.
    for (const [label, target] of [['the static app', '/'], ['/health', '/health']]) {
      const res = await srv.fetch(target);
      assert.equal(res.status, 200, `${label} must still answer 200`);
      for (const [name, value] of Object.entries(declared)) {
        assert.equal(res.headers.get(name), value,
          `${label} must send ${name}: ${value} exactly as public/_headers does (airhorn-bs19)`);
      }
    }

    // A 404 from the static path is still a response from this server: the policy must not
    // depend on the file existing (a self-hoster's error page is as sniffable as the app).
    const missing = await srv.fetch('/definitely-not-here');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('x-content-type-options'), 'nosniff',
      '404s from this server must carry the policy too, not just successful files');
  } finally {
    await srv.kill();
  }
});

/* airhorn-bs19: the listener used to bind every interface by accident (Deno.serve with no
 * hostname), so a self-hosted preview was reachable from the LAN without anyone asking.
 * Loopback is the default; HOST is the explicit opt-in, and this reads the bound address back
 * out of the server's own listening line rather than trusting the flag that was passed. */
test('the listener binds loopback by default, and HOST is the only way to widen it', async (t) => {
  if (!deno) return t.skip('deno is not installed on this machine; the listener is server.ts');
  const byDefault = await startServer();
  try {
    assert.equal(byDefault.host, '127.0.0.1',
      'server.ts must bind loopback by default: an unconfigured preview is not a public listener');
  } finally {
    await byDefault.kill();
  }

  const widened = await startServer({ HOST: '0.0.0.0' });
  try {
    assert.equal(widened.host, '0.0.0.0',
      'HOST must be the documented opt-in for a deployment that is reached from outside the box');
    const res = await widened.fetch('/health');
    assert.equal(res.status, 200, 'a widened listener must still serve /health');
  } finally {
    await widened.kill();
  }
});
