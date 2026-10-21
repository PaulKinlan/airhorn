/*
 * tests/docs-recipe.test.mjs — the documented Deno recipe is run as written (airhorn-x86p)
 *
 * README.md tells an operator how to serve dist/: a `deno run ... server.ts` line
 * whose flags are the ONLY thing standing between them and a silently wrong
 * server. server.ts reads PORT and the build stamps through permission-guarded
 * env reads and resolves the commit through `git rev-parse`. Drop --allow-env
 * and PORT is ignored (the listener stays on 8000, or dies AddrInUse when 8000
 * is taken); drop --allow-run=git and /health says "unknown". That is exactly
 * how README.md:47 was wrong once (airhorn-eh08), and prose cannot notice when
 * server.ts grows one more permission-gated read.
 *
 * So this suite does not parse the flags and compare them with a list — it runs
 * the documented command, verbatim, and asserts what the docs promise:
 *
 *   1. the listener is where PORT sent it (PORT granted, and nothing else the
 *      startup path needs is missing — a missing grant throws at startup);
 *   2. /health reports this checkout's sha (--allow-run=git) and package.json's
 *      version (--allow-read covers package.json);
 *   3. the app itself still serves from dist/ (--allow-read covers dist/);
 *   4. the read and env grants are SCOPED — this server listens on a public
 *      port, so "read the whole filesystem" is not a reasonable default
 *      (airhorn-njjq).
 *
 * PORT is forced to 0 rather than to the port the docs name: an ephemeral port
 * is the only way to run this on a machine where 8000 (or 9000) is already in
 * use, and asserting "the listener is NOT on the default 8000" is the same
 * statement without the machine-state dependency. Everything else — the flags,
 * the env assignments the docs show — is what README.md says.
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
const readmePath = path.join(root, 'README.md');

const distDir = path.join(root, 'dist');
if (!fs.existsSync(distDir)) {
  throw new Error('dist directory does not exist. Run build first.');
}

const findExe = (name) => {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
};

// The recipe: every `deno run ... server.ts` line inside a fenced block in
// README.md, with backslash continuations joined. Shell VAR=value prefixes are
// kept (they are part of what the docs tell you to type).
function documentedRecipes(text) {
  const lines = [];
  let fenced = false;
  let buffer = '';
  for (const raw of text.split('\n')) {
    if (/^\s*```/.test(raw)) { fenced = !fenced; buffer = ''; continue; }
    if (!fenced) continue;
    const token = raw.trim();
    buffer = buffer ? `${buffer} ${token}` : token;
    if (buffer.endsWith('\\')) { buffer = buffer.slice(0, -1).trimEnd(); continue; }
    lines.push(buffer);
    buffer = '';
  }
  return lines
    .filter((line) => /^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*deno run\b/.test(line) && /\bserver\.ts\b/.test(line));
}

// `FOO=bar deno run <flags> server.ts` -> { env, argv }
function splitRecipe(recipe) {
  const tokens = recipe.split(/\s+/);
  const env = {};
  let i = 0;
  for (; i < tokens.length; i++) {
    const m = tokens[i].match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) break;
    env[m[1]] = m[2];
  }
  return { env, argv: tokens.slice(i) };
}

// Start the documented command; resolve once the server prints its own listening
// line. Every wait is bounded so a wedged server fails the case, not the gate.
function runRecipe(recipe, readyTimeoutMs = 30000) {
  const { env: docEnv, argv } = splitRecipe(recipe);
  const env = { ...process.env };
  for (const key of ['APP_VERSION', 'GIT_COMMIT', 'COMMIT_SHA', 'BUILD_TIMESTAMP']) delete env[key];
  Object.assign(env, docEnv);
  // Ephemeral port, whatever port the docs name: see the header comment.
  env.PORT = '0';

  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let ready = false;
    const timer = setTimeout(() => {
      reject(new Error(`the documented command did not report a port in ${readyTimeoutMs}ms\n` +
        `command: ${recipe}\nstdout: ${stdout}\nstderr: ${stderr}`));
      child.kill('SIGKILL');
    }, readyTimeoutMs);
    const onData = (chunk) => {
      stdout += chunk;
      if (ready) return;
      const match = stdout.match(/serving dist\/ on \S+:(\d+)/);
      if (!match) return;
      ready = true;
      clearTimeout(timer);
      const port = Number(match[1]);
      const url = `http://127.0.0.1:${port}`;
      resolve({
        port,
        command: recipe,
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
      reject(new Error(`the documented command exited before listening (code ${code})\n` +
        `command: ${recipe}\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

const recipes = documentedRecipes(fs.readFileSync(readmePath, 'utf8'));

test('README documents at least the default-port and the PORT= recipe', () => {
  assert.ok(recipes.length >= 2, `expected README to document a served recipe and a PORT= one, found ${JSON.stringify(recipes)}`);
  assert.ok(recipes.some((r) => /\bPORT=/.test(r)), `no PORT= recipe in ${JSON.stringify(recipes)}`);
});

// One case per documented line: a failure names the line an operator would copy.
for (const recipe of recipes) {
  test(`the documented recipe runs as written: ${recipe.replace(/\s+/g, ' ').slice(0, 96)}…`, async (t) => {
    const deno = findExe('deno');
    if (!deno) return t.skip('deno is not installed on this machine; README documents the deno server');
    let git = null;
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      git = true;
    } catch {
      return t.skip('git is not installed on this machine; the documented commit fallback needs it');
    }

    // Scoped grants: the server listens on a public port, so the docs must not
    // hand out whole-filesystem read or the whole environment (airhorn-njjq).
    for (const flag of ['--allow-read', '--allow-env']) {
      const granted = recipe.split(/\s+/).filter((tok) => tok === flag || tok.startsWith(flag + '='));
      assert.ok(granted.length > 0, `the documented command must grant ${flag}: ${recipe}`);
      for (const grant of granted) {
        assert.ok(grant.includes('='),
          `the documented command grants ${flag} unscoped (${grant}); scope it to what server.ts uses, ` +
          `or change this test deliberately: ${recipe}`);
      }
    }

    const srv = await runRecipe(recipe);
    try {
      // 1. PORT was read: the listener is not on the default port.
      assert.notEqual(srv.port, 8000,
        `PORT was ignored (the listener is on 8000); the documented flags must include --allow-env: ${recipe}`);

      // 2 + 3. The promises /health and the app make.
      const health = await srv.fetch('/health');
      assert.equal(health.status, 200);
      assert.equal(health.headers.get('content-type'), 'application/json; charset=utf-8');
      const body = await health.json();
      const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
      assert.equal(body.commit, sha,
        `/health must report this checkout's sha; "unknown" means the documented flags omit --allow-run=git: ${recipe}`);
      assert.equal(body.version, version,
        `/health must report package.json's version; "unknown" means the documented read scope misses it: ${recipe}`);

      const home = await srv.fetch('/');
      assert.equal(home.status, 200,
        `the documented read scope must cover dist/; got ${home.status} for /: ${recipe}`);
      assert.match(home.headers.get('content-type') || '', /text\/html/);
    } finally {
      await srv.kill();
    }
  });
}
