/*
 * tests/docs-recipe.test.mjs — the documented Deno recipes are run as written
 * (airhorn-x86p, airhorn-o1l1)
 *
 * README.md tells an operator how to serve dist/, and docs/runbooks/DEPLOY.md tells
 * them how to
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
import { fetchUntil, stretchMs, hostStealOnce } from './support/bounds.mjs';

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

// The runbooks moved under docs/runbooks/ (airhorn-alze); the recipe that is RUN,
// not quoted, is still DEPLOY.md's, so its path is here and its command is executed
// as printed from the repo root, exactly as an operator would.
const DOCS = ['README.md', 'docs/runbooks/DEPLOY.md'].map((name) => ({
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
  // The ready bound states the host's condition (airhorn-dwbl), stretched by the
  // measured steal; a healthy or unknown host keeps it exactly.
  const readyBoundMs = stretchMs(readyTimeoutMs);
  const env = { ...process.env };
  for (const key of ['APP_VERSION', 'GIT_COMMIT', 'COMMIT_SHA', 'BUILD_TIMESTAMP']) delete env[key];

  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let ready = false;
    const timer = setTimeout(() => {
      reject(new Error(`the documented command did not report a port in ${readyBoundMs}ms (base ${readyTimeoutMs}ms, steal ${JSON.stringify(hostStealOnce())})\n` +
        `command: ${command}\nstdout: ${stdout}\nstderr: ${stderr}`));
      child.kill('SIGKILL');
    }, readyBoundMs);
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
        // retry-with-deadline (airhorn-dwbl): a slow-but-correct server eventually
        // answers; any response is returned untouched, so a wrong payload still
        // fails fast. Base 5000ms is this suite's bound on a healthy host.
        fetch: (p, init) => fetchUntil(url + p, init, { baseMs: 5000 }),
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

/*
 * airhorn-fs8s — the recipes are run, so the paths they name must exist.
 *
 * airhorn-alze moved the operator runbooks into docs/runbooks/ and updated the
 * prose and the markdown links, but two fenced recipes kept naming ROLLBACK.md
 * relative to the repo root, so they failed as printed until a reviewer ran them
 * (airhorn-2jwe). A reviewer should not be the first executor of a documented
 * command, so this asserts the cheaper half of that: every repo path a fenced
 * bash block names is really there.
 *
 * The rules, stated exactly, because airhorn-lgx8 found this header promising a
 * convention the code did not implement:
 *   - $repo/<path>, ${repo}/<path>            repo root (by construction)
 *   - ./<path>                                repo root: a documented recipe runs
 *                                             from the repo root, so that is what
 *                                             ./ means when it is executed, and
 *                                             ./x is checked rather than skipped
 *                                             (it used to match nothing at all -
 *                                             the hole airhorn-lgx8 found)
 *   - <name>.md with no slash                 repo root (a bare name means the
 *                                             repo; that is the alze bug's shape)
 *   - <dir>/<name>.md, and any path a reader
 *     command opens                            repo root
 *   - ../<path>                               skipped: it names something outside
 *                                             the repo, which this cannot judge
 * A token the block WRITES before reading it is skipped, not checked: a recipe
 * that generates out/log.txt and then greps it is correct as printed even though
 * out/log.txt is not in the repo (airhorn-lgx8).
 * A block that cds OUT of the repo (~/..., /...) is working in an artifact
 * directory, so only its root-relative tokens are checked: ROLLBACK.md §10(a)
 * reads MANIFEST.tsv inside ~/airhorn-v1-artifact, which is not a repo path.
 */
const REPO_TOKEN = /\$\{?repo\}?\/([^\s"'`;|)&]+)/g;
const DOT_RELATIVE = /(?<![\w/.-])(\.{1,2}\/[\w./-]+\.[a-z0-9]+)/g;
const BARE_MD = /(?<![\w/.-])([\w.-]+\.md)\b/g;
const SLASHED_MD = /(?<![\w/.:-])([\w.-]+(?:\/[\w.-]+)+\.md)\b/g;
const READER_TOKEN = /\b(?:awk|grep|cat|sha256sum|diff|sed|head|tail|test\s+-f|open)\b[^\n]*?([\w./-]+\.[a-z0-9]+)/gi;
// A path-ish token: a directory component, an extension, or a trailing slash.
const looksLikePath = (token) => !!token && (token.includes('/') || /\.[a-z0-9]+$/i.test(token));
// Copy-like commands: their SOURCE is read, their LAST operand is written.
const COPIERS = new Set(['cp', 'mv', 'install', 'rsync', 'ln']);
// Commands where every operand is created or written.
const CREATORS = new Set(['mkdir', 'touch', 'tee']);
// Flags that consume the NEXT token as their value, so `install -m 644 a b` does
// not turn '644' into a source path (airhorn-kuqn).
const VALUE_FLAGS = new Set(['-m', '--mode', '-o', '--owner', '-g', '--group', '-t', '--target-directory', '-S', '--suffix']);

/**
 * The `cp SOURCE... DEST` calls a block makes, as { verb, sources, dest }.
 *
 * One parser for two questions the guard must answer differently (airhorn-kuqn):
 * the DEST is written (so reading it back claims nothing), and every SOURCE is
 * read (so a missing one must be reported - for ANY extension, not just markdown,
 * which is what a markdown-shaped regex could only ever catch).
 */
function copyCalls(block) {
  const calls = [];
  for (const line of block.split('\n')) {
    for (const segment of line.split(/&&|\|\||;|\|/)) {
      const words = segment.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^["'`]|["'`]$/g, ''));
      if (words.length < 2) continue;
      const verb = words[0].split('/').pop();
      if (!COPIERS.has(verb)) continue;
      const operands = [];
      for (let i = 1; i < words.length; i += 1) {
        const w = words[i];
        if (w.startsWith('-')) { if (VALUE_FLAGS.has(w)) i += 1; continue; }
        operands.push(w);
      }
      if (operands.length < 2) continue;
      calls.push({ verb, sources: operands.slice(0, -1), dest: operands[operands.length - 1] });
    }
  }
  return calls;
}
const leavesRepo = (block) => /^\s*(?:cd|pushd)\s+(?:~|\$HOME|\/)/m.test(block);

// Only SHELL fences: a javascript block is source, and its comments talk about the
// docs ("plan in ROLLBACK.md §6") without executing anything - the first version of
// this guard failed on exactly that, which would have been a false positive.
function fencedBlocks(text) {
  const blocks = [];
  let current = null;
  let lang = '';
  for (const line of text.split('\n')) {
    const fence = line.match(/^\s*```(\S*)/);
    if (fence) {
      if (current === null) { current = []; lang = fence[1].toLowerCase(); }
      else {
        if (['', 'bash', 'sh', 'shell', 'console'].includes(lang)) blocks.push(current.join('\n'));
        current = null; lang = '';
      }
      continue;
    }
    if (current !== null) current.push(line);
  }
  return blocks;
}

/**
 * Paths this block WRITES, so reading them back is not a repo claim.
 *
 * Segment-aware on purpose (airhorn-kuqn): `cp SOURCE DEST` writes DEST, so a
 * copier contributes its LAST operand only and the source stays a read claim the
 * guard must be able to report as missing. A first-match regex cannot express
 * that - it captured the source, which excused a missing input AND still flagged
 * a generated destination that a later line read back.
 */
const generatedBy = (block) => {
  const written = new Set();
  const sanitise = (raw) => String(raw).replace(/^["'`]|["'`]$/g, '').replace(/^\.\//, '');
  const add = (raw) => {
    const token = sanitise(raw);
    if (!token || /^https?:/.test(token) || token.startsWith('-')) return;
    if (looksLikePath(token)) written.add(token);
  };
  // A flag value is a written target BY DEFINITION, so it is added even when it
  // is a bare directory name like `public`, which looksLikePath would drop
  // (airhorn-5c81: --outDir public must mark public/ written).
  const addFlagValue = (raw) => {
    const token = sanitise(raw);
    if (!token || /^https?:/.test(token) || token.startsWith('-')) return;
    written.add(token);
  };

  for (const line of block.split('\n')) {
    // Redirection targets: `> out/log.txt`, `>> "$scratch/rows.txt"`.
    for (const m of line.matchAll(/>>?\s*("[^"]+"|'[^']+'|[^\s;&|()]+)/g)) add(m[1]);
    // Build tools spell the output flag several ways: --out/--output/--dest, and
    // vite/esbuild/tsc's --outDir/--out-dir/--outfile/--out-file, in any case,
    // with `=value` or a space (airhorn-5c81).
    for (const m of line.matchAll(/--(?:out|output|outdir|out-dir|outfile|out-file|dest|destination)[= ]\s*("[^"]+"|'[^']+'|[^\s;&|()]+)/gi)) addFlagValue(m[1]);

    // Command segments, so `cp a b && grep x b` is two commands and not one
    // argument list whose "last operand" would be grep's file.
    for (const segment of line.split(/&&|\|\||;|\|/)) {
      const words = segment.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^["'`]|["'`]$/g, ''));
      if (words.length === 0) continue;
      const verb = words[0].split('/').pop();
      if (!COPIERS.has(verb) && CREATORS.has(verb)) for (const operand of words.slice(1)) add(operand);
    }
  }
  // The DEST of every copier, from the one parser both answers come from.
  for (const { dest } of copyCalls(block)) add(dest);
  return written;
};

/**
 * Is `p` produced by this block? Exact match, or anything UNDER a written
 * directory: --outDir public makes public/sw.js generated, because a build
 * that writes a directory writes everything under it (airhorn-5c81). A read
 * outside every written path stays a claim, so the guard still bites.
 */
const isGenerated = (generated, p) => {
  const norm = p.replace(/^\.\//, '');
  for (const g of generated) {
    if (norm === g) return true;
    if (norm.startsWith(g.endsWith('/') ? g : `${g}/`)) return true;
  }
  return false;
};

/**
 * Every path a block claims is IN THE REPO, with where it says it lives:
 *   { path, base: 'root' } - the repo root;  { path, base: 'doc' } - the doc's dir.
 * Generated paths and artifact-directory reads are not repo claims and are not
 * returned. Exported so the rules themselves can be pinned by tests: this guard
 * is only as good as its ability to be wrong out loud (airhorn-lgx8).
 */
export function pathClaims(block) {
  const generated = generatedBy(block);
  const claims = new Map();
  const add = (rawPath, base) => {
    // "./x" and "x" are the same claim from the repo root, and SLASHED_MD and
    // DOT_RELATIVE both see "./x": normalise here so a reviewer is not told the
    // same path is missing twice.
    const p = rawPath.replace(/^["']|["']$/g, '').replace(/^\.\//, '');
    if (!p || /^https?:/.test(p) || p.includes('*') || p.startsWith('$')) return;
    if (isGenerated(generated, p)) return; // generated in this block
    if (/^repo\//.test(p)) return; // the tail of $repo/x, already claimed as root
    const key = `${base}:${p}`;
    if (!claims.has(key)) claims.set(key, { path: p, base });
  };
  for (const m of block.matchAll(REPO_TOKEN)) add(m[1], 'root');
  if (!leavesRepo(block)) {
    for (const m of block.matchAll(DOT_RELATIVE)) {
      const rel = m[1];
      if (rel.startsWith('../')) continue;           // outside the repo: not ours to judge
      add(rel.replace(/^\.\//, ''), 'root');        // ./x is x, from the repo root
    }
    for (const m of block.matchAll(BARE_MD)) add(m[1], 'root');
    for (const m of block.matchAll(SLASHED_MD)) add(m[1], 'root');
    for (const m of block.matchAll(READER_TOKEN)) if (m[1].includes('/')) add(m[1], 'root');
    // A copy READS its sources (airhorn-kuqn round 2): without this, a source was
    // only claimed when it happened to be markdown, so `cp absent/input.js out/x.js`
    // read green while `cp absent/input.md ...` read red.
    for (const { sources } of copyCalls(block)) for (const src of sources) add(src, 'root');
  }
  return [...claims.values()];
}

/** Where a claim points on disk, inside the repo. */
const claimTarget = (claim, docName) => (claim.base === 'doc'
  ? path.resolve(root, path.dirname(docName), claim.path)
  : path.resolve(root, claim.path));

// Every markdown file that carries operator instructions, wherever airhorn-alze
// has put it: the runbooks moved to docs/runbooks/ and the README did not.
function operatorDocs() {
  const docs = ['README.md'];
  for (const dir of ['docs/runbooks', 'docs', '.']) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (!name.endsWith('.md')) continue;
      const rel = dir === '.' ? name : `${dir}/${name}`;
      if (!docs.includes(rel)) docs.push(rel);
    }
  }
  return docs;
}

test('a fenced recipe never names a repo path that does not exist', () => {
  const missing = [];
  let checked = 0;
  for (const name of operatorDocs()) {
    const text = fs.readFileSync(path.join(root, name), 'utf8');
    for (const [index, rawBlock] of fencedBlocks(text).entries()) {
      // A comment is prose inside a block: drop comment-only lines and trailing
      // comments, so "roll back as described in ROLLBACK.md" is not a path claim.
      const block = rawBlock
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
        .join('\n');
      for (const claim of pathClaims(block)) {
        checked += 1;
        if (!fs.existsSync(claimTarget(claim, name))) {
          missing.push(`${name} block ${index + 1}: ${claim.base === 'doc' ? `./${claim.path}` : claim.path}`);
        }
      }
    }
  }
  assert.equal(checkMissing(missing, checked), 0,
    `a documented command names a path that does not exist, so it cannot run as printed (airhorn-2jwe, airhorn-fs8s):\n  ${missing.join('\n  ')}`);
});

// Split out so the failure message can show what WAS checked, not just what failed.
function checkMissing(missing, checked) {
  if (missing.length === 0) assert.ok(checked > 0, 'the guard found no paths at all, so it is asserting nothing - check its patterns');
  return missing.length;
}

/*
 * airhorn-lgx8 — the rules above are only a guard if they can be shown wrong, so
 * the two blind spots the reviewer found are pinned directly. Both cases are the
 * reviewer's own repro, expressed as assertions instead of prose.
 */
const claimsOf = (block) => pathClaims(block);

test('./x is checked, not skipped: the convention the header promises is enforced', () => {
  const claims = claimsOf('runbook="./ROLLBACK.md"\nsed -n 1p "$runbook"');
  assert.deepEqual(claims, [{ path: 'ROLLBACK.md', base: 'root' }],
    `./ROLLBACK.md must be claimed (as the repo root, where a documented recipe runs), got ${JSON.stringify(claims)}`);
  // ...and a doc-relative miss is a real miss: ./NOT-THERE.md resolves to nothing.
  const missing = claimsOf('cat ./NOT-THERE.md').filter((c) => !fs.existsSync(claimTarget(c, 'docs/runbooks/ROLLBACK.md')));
  assert.equal(missing.length, 1, './NOT-THERE.md must be reported as missing, otherwise it is silently unchecked');
});

test('a path the recipe itself generates is read back without being called missing', () => {
  const generateThenRead = [
    'mkdir -p out',
    'sha256sum dist/sw.js > out/log.txt',
    'grep -c . out/log.txt',
    'node tools/x.mjs --out out/report.json',
    'cat out/report.json',
  ].join('\n');
  const generated = claimsOf(generateThenRead).filter((c) => c.path.startsWith('out/'));
  assert.deepEqual(generated, [],
    `a recipe that writes out/log.txt and out/report.json, then reads them, makes no repo claim about them; got ${JSON.stringify(generated)}`);

  // The same read WITHOUT a write is still a claim, so this is not a blanket
  // exemption for anything under a directory.
  const readOnly = claimsOf('grep -c . out/log.txt').filter((c) => c.path.startsWith('out/'));
  assert.deepEqual(readOnly, [{ path: 'out/log.txt', base: 'root' }],
    'reading a generated-looking path that nothing in the block creates is still a claim');
});

/*
 * airhorn-5c81 — WRITE_FLAG used to know only --out/--output/--dest/--destination,
 * so a CORRECT recipe that built with --outDir public and then read public/sw.js
 * was called missing. Both directions are pinned: every spelling marks its value
 * written (green), and a path nothing creates is still a claim (red).
 */
test('build output flags mark their value written: --outDir/--out-dir/--outfile/--out-file, space or = (airhorn-5c81)', () => {
  const spellings = ['--outDir', '--out-dir', '--outfile', '--out-file'];
  for (const flag of spellings) {
    for (const separator of [' ', '=']) {
      const claims = claimsOf(`node tools/build.mjs ${flag}${separator}public\ncat public/sw.js`)
        .filter((c) => c.path.startsWith('public/'));
      assert.deepEqual(claims, [],
        `${flag}${separator}public marks public/ written, so reading public/sw.js back is not a repo claim; got ${JSON.stringify(claims)}`);
    }
  }
  // A file-valued flag covers exactly that file.
  const fileForm = claimsOf('node tools/build.mjs --outFile=dist/bundle.js\ncat dist/bundle.js')
    .filter((c) => c.path === 'dist/bundle.js');
  assert.deepEqual(fileForm, [], '--outFile=<file> marks that file written');
});

test('a path the recipe never creates is still a claim, so the guard keeps biting (airhorn-5c81)', () => {
  const noWrite = claimsOf('cat dist/never-built.js');
  assert.deepEqual(noWrite, [{ path: 'dist/never-built.js', base: 'root' }],
    `reading a path nothing in the block creates must be claimed, got ${JSON.stringify(noWrite)}`);
  const outsideDir = claimsOf('node tools/build.mjs --outDir public\ncat other/sw.js')
    .filter((c) => c.path.startsWith('other/'));
  assert.deepEqual(outsideDir, [{ path: 'other/sw.js', base: 'root' }],
    `writing public/ must not exempt a read outside it, got ${JSON.stringify(outsideDir)}`);
});

test('$repo stays root-relative and a bare name stays root-relative: the alze bug is still caught', () => {
  // The shape that shipped in airhorn-alze: a moved doc whose recipe still names
  // the old root path. It must be a root claim, never rescued by the doc's own dir.
  const alze = claimsOf('rows=$(grep -c x "$repo/ROLLBACK.md")').map((c) => c.base);
  assert.deepEqual(alze, ['root'], `$repo/ROLLBACK.md must be a root claim, got ${JSON.stringify(alze)}`);
  const bare = claimsOf('grep -c x ROLLBACK.md').map((c) => c.base);
  assert.deepEqual(bare, ['root'], `a bare ROLLBACK.md must be a root claim, got ${JSON.stringify(bare)}`);
});

/*
 * airhorn-kuqn — cp/mv/install have a SOURCE and a DESTINATION, and only the
 * destination is written. The first version of the generated-file rule captured
 * the first path-ish argument, i.e. the source, which produced both errors at
 * once: a missing source was silently excused (it looked generated) and a
 * generated destination with a file extension was still reported missing when a
 * later line read it back.
 */
test('cp marks the DESTINATION as generated and never the source', () => {
  const cp = claimsOf('cp gone/src.md dist/');
  const claimed = cp.map((c) => c.path);
  assert.ok(claimed.includes('gone/src.md'),
    `the cp SOURCE is read, so a missing one must be claimed (and then reported): got ${JSON.stringify(cp)}`);

  // A destination with an extension, written by cp, is generated: reading it back
  // on a later line must make no repo claim about it.
  const cpThenRead = claimsOf('cp dist/sw.js out/copy.js\nsha256sum -c out/copy.js');
  assert.deepEqual(cpThenRead.filter((c) => c.path.startsWith('out/')), [],
    `out/copy.js is written by the cp, so reading it back is not a repo claim: got ${JSON.stringify(cpThenRead)}`);

  // mv and install behave the same way, and a multi-argument cp still writes its
  // LAST argument only.
  for (const line of ['mv dist/sw.js out/moved.js', 'install -m 644 dist/sw.js out/installed.js', 'cp -r a b c out/']) {
    const dest = line.split(/\s+/).at(-1);
    const claims = claimsOf(`${line}\nsha256sum ${dest}`).map((c) => c.path);
    assert.ok(!claims.includes(dest), `${dest} is the destination of "${line}": reading it back must not be a claim (got ${JSON.stringify(claims)})`);
  }
});

test('a missing cp source is caught end to end, the way a reader would hit it', () => {
  // The reviewer's repro, as a document: the source does not exist, so running
  // this as printed fails. Only the destination is written.
  const claims = claimsOf('cp gone/source.md out/copied.md');
  const missing = claims.filter((c) => !fs.existsSync(claimTarget(c, 'docs/runbooks/ROLLBACK.md')));
  assert.deepEqual(missing.map((c) => c.path), ['gone/source.md'],
    `the cp source must be the only missing claim, got ${JSON.stringify(claims)}`);
});

/*
 * airhorn-kuqn round 2 (reviewer): marking the DESTINATION as generated was only
 * half the fix. The SOURCE of a cp/mv was still not a claim unless it happened to
 * be markdown, because the claim pass reads BARE_MD/SLASHED_MD/READER_TOKEN and
 * `cp` is none of those. So `cp absent/input.js out/copy.js` read green while
 * `cp absent/input.md out/copy.md` read red: the guard was watching one
 * extension. A copy reads its source whatever the extension.
 */
test('a missing cp SOURCE is caught for every extension, not just markdown (airhorn-kuqn)', () => {
  const claims = claimsOf('cp absent/input.js out/copy.js\ncat out/copy.js');
  const paths = claims.map((c) => c.path);
  assert.ok(paths.includes('absent/input.js'),
    `the .js source is read by the cp, so a missing one must be claimed: ${JSON.stringify(claims)}`);
  assert.ok(!paths.includes('out/copy.js'), `the destination is written, not read: ${JSON.stringify(claims)}`);
  const missing = claims.filter((c) => !fs.existsSync(claimTarget(c, 'docs/runbooks/ROLLBACK.md')));
  assert.deepEqual(missing.map((c) => c.path), ['absent/input.js'],
    `the .js source must be the only missing claim: ${JSON.stringify(missing)}`);

  // Same for mv, install and a multi-source cp: every source is read.
  const moved = claimsOf('mv absent/a.zip out/b.zip').map((c) => c.path);
  assert.deepEqual(moved, ['absent/a.zip']);
  const installed = claimsOf('install -m 644 absent/tool.sh out/tool').map((c) => c.path);
  assert.deepEqual(installed, ['absent/tool.sh'], 'a value-taking flag must not become a claim of its own');
  const many = claimsOf('cp absent/one.c absent/two.h out/').map((c) => c.path);
  assert.deepEqual(many, ['absent/one.c', 'absent/two.h']);
});
