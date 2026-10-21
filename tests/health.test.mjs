/*
 * tests/health.test.mjs — GET /health tells the truth about the running build (airhorn-uexx)
 *
 * server.ts is the production origin (DEPLOY.md): a Deno static server over
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
 *   4. resolution happens ONCE: a second GET is byte-identical to the first
 *      (no git call, no clock read per request — the cheap-under-load promise);
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
function startServer(overrides = {}, readyTimeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(deno, ['run', '--no-prompt', '--allow-net', '--allow-read', '--allow-env', '--allow-run=git', serverTs], {
      cwd: root,
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
      // server.ts's own listening line is the port contract (PORT=0 -> ephemeral).
      const match = stdout.match(/serving dist\/ on \S+:(\d+)/);
      if (!match) return;
      ready = true;
      clearTimeout(timer);
      const port = Number(match[1]);
      const url = `http://127.0.0.1:${port}`;
      resolve({
        url,
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
    assert.ok(Math.abs(Date.now() - ts) < 5 * 60 * 1000,
      `buildTimestamp falls back to server start time, got ${body.buildTimestamp}`);

    // Resolved ONCE at startup: the second answer is byte-identical — no git
    // call, no clock read, no re-serialization per request.
    const again = await srv.fetch('/health');
    assert.equal(await again.text(), JSON.stringify(body), 'a repeated GET must be byte-identical');

    assert.deepEqual(Object.keys(body).sort(), ['buildTimestamp', 'commit', 'status', 'version'],
      'no extra fields: the endpoint carries no secrets');
  } finally {
    await srv.kill();
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
    const head = await srv.fetch('/health', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(await head.text(), '');

    const post = await srv.fetch('/health', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.match(post.headers.get('allow') || '', /GET/);

    const home = await srv.fetch('/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type') || '', /text\/html/,
      'the static app must still serve with the /health route in front of it');
  } finally {
    await srv.kill();
  }
});
