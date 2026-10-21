/*
 * tests/docs-recipe.test.mjs — the documented Deno recipes are run as written
 * (airhorn-x86p, airhorn-o1l1)
 *
 * README.md tells an operator how to serve dist/, and DEPLOY.md tells them how to
 * stamp a deployment. Both print a `deno run ... server.ts` command, and its flags
 * are the ONLY thing standing between them and a silently wrong server: server.ts
 * reads PORT and the build stamps through permission-guarded env reads and
 * resolves the commit through `git rev-parse`. Drop --allow-env and PORT is
 * ignored (the listener stays on 8000, or dies AddrInUse when 8000 is taken);
 * drop --allow-run=git and an UNSTAMPED /health says "unknown". That is exactly
 * how README.md:47 was wrong once (airhorn-eh08), and prose cannot notice when
 * server.ts grows one more permission-gated read.
 *
 * So this suite does not compare flags against a list — it runs each documented
 * command, verbatim (through bash, because DEPLOY.md's stamps are command
 * substitutions), and asserts what the docs promise:
 *
 *   1. the listener is where PORT sent it (PORT granted, and nothing else the
 *      startup path needs is missing — a missing grant fails the run);
 *   2. /health reports the checkout's sha and package.json's version;
 *   3. the app itself still serves from dist/;
 *   4. the read and env grants are SCOPED — this server listens on a public port,
 *      so "read the whole filesystem" is not a reasonable default (airhorn-njjq);
 *   5. the two stories stay distinct (airhorn-o1l1): a recipe that STAMPS
 *      GIT_COMMIT must not grant process execution at all, and the recipe that
 *      resolves the sha by running git must not stamp it. Point 2 then proves the
 *      claim rather than restating it — the stamped recipe reports a real sha
 *      while holding no --allow-run, so the value can only have come from the
 *      stamp; the git recipe reports a real sha with no stamp in sight.
 *
 * PORT is forced to 0 rather than to the port the docs name: an ephemeral port is
 * the only way to run this on a machine where 8000 (or 9000) is already in use,
 * and asserting "the listener is NOT on the default 8000" is the same statement
 * without the machine-state dependency. Everything else — the flags and the env
 * assignments the docs show — is what the docs say.
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

// Every `deno run ... server.ts` line inside a fenced block, with backslash
// continuations joined. Shell VAR=value prefixes are kept: they are part of what
// the docs tell you to type (DEPLOY.md's are command substitutions).
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
  return lines.filter((line) => /\bdeno run\b/.test(line) && /\bserver\.ts\b/.test(line));
}

const DOCS = ['README.md', 'DEPLOY.md'].map((name) => ({
  name,
  recipes: documentedRecipes(fs.readFileSync(path.join(root, name), 'utf8')),
}));

// See the header: an ephemeral listener port, whatever port the docs name.
const forceEphemeralPort = (recipe) => (/\bPORT=\d+\b/.test(recipe)
  ? recipe.replace(/\bPORT=\d+\b/g, 'PORT=0')
  : `PORT=0 ${recipe}`);

// Start the documented command; resolve once the server prints its own listening
// line. Every wait is bounded so a wedged server fails the case, not the gate.
function runRecipe(recipe, readyTimeoutMs = 30000) {
  const command = forceEphemeralPort(recipe);
  const env = { ...process.env };
  for (const key of ['APP_VERSION', 'GIT_COMMIT', 'COMMIT_SHA', 'BUILD_TIMESTAMP']) delete env[key];

  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let ready = false;
    const timer = setTimeout(() => {
      reject(new Error(`the documented command did not report a port in ${readyTimeoutMs}ms\n` +
        `command: ${command}\nstdout: ${stdout}\nstderr: ${stderr}`));
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
        command,
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
        `command: ${command}\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });
}

test('each doc prints the recipes this suite runs', () => {
  for (const doc of DOCS) {
    assert.ok(doc.recipes.length >= 1,
      `${doc.name} must document a 'deno run ... server.ts' recipe, found ${JSON.stringify(doc.recipes)}`);
  }
  const readme = DOCS.find((d) => d.name === 'README.md').recipes;
  assert.ok(readme.length >= 2, `README.md should show the default-port and the PORT= recipe, found ${JSON.stringify(readme)}`);
  assert.ok(readme.some((r) => /\bPORT=/.test(r)), `no PORT= recipe in ${JSON.stringify(readme)}`);
});

// One case per documented line: a failure names the line an operator would copy.
for (const doc of DOCS) {
  for (const recipe of doc.recipes) {
    test(`${doc.name} runs as written: ${recipe.replace(/\s+/g, ' ').slice(0, 88)}…`, async (t) => {
      if (!findExe('deno')) return t.skip('deno is not installed on this machine; the docs document the deno server');
      try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
      } catch {
        return t.skip('git is not installed on this machine; the documented commit fallback needs it');
      }

      const grants = (prefix) => recipe.split(/\s+/).filter((tok) => tok === prefix || tok.startsWith(prefix + '='));
      const stampsCommit = /\bGIT_COMMIT=|\bCOMMIT_SHA=/.test(recipe);

      // Scoped grants: the server listens on a public port, so the docs must not
      // hand out whole-filesystem read or the whole environment (airhorn-njjq).
      for (const flag of ['--allow-read', '--allow-env']) {
        const granted = grants(flag);
        assert.ok(granted.length > 0, `the documented command must grant ${flag}: ${recipe}`);
        for (const grant of granted) {
          assert.ok(grant.includes('='),
            `the documented command grants ${flag} unscoped (${grant}); scope it to what server.ts uses, ` +
            `or change this test deliberately: ${recipe}`);
        }
      }

      // The two deployment stories, kept distinct (airhorn-o1l1).
      if (stampsCommit) {
        assert.equal(grants('--allow-run').length, 0,
          `a recipe that stamps GIT_COMMIT needs no process execution: drop --allow-run from it ` +
          `(README.md promises the stamped deployment grants none), or change this test deliberately: ${recipe}`);
      } else {
        assert.ok(grants('--allow-run').length > 0,
          `a recipe that does not stamp the sha must grant --allow-run=git, or /health reports "unknown": ${recipe}`);
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
          `/health must report this checkout's sha; "unknown" means the documented flags are missing the grant ` +
          `that supplies it (--allow-run=git, or the GIT_COMMIT stamp): ${recipe}`);
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
}
