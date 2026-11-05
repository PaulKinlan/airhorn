// Pin for the Cloudflare Pages hosting configuration (airhorn-9dal, fleet-fpr18).
//
// The site is a Tier 3 static site: `npm run build` (plain Vite) writes dist/, and dist/ is the entire
// artifact. Moving it to Cloudflare Pages is HOSTING CONFIGURATION - no framework, no Pages Functions,
// no change to what the browser runs. These assertions keep the three things that could rot silently
// honest:
//   (a) wrangler.jsonc stays minimal and points at the real build output,
//   (b) the deploy workflow is the only deploy automation, and it carries the two secrets by name,
//   (c) with either secret absent the workflow's guard FAILS BY NAME before anything is built or
//       deployed - this suite runs the guard step exactly as written in the YAML, so the no-secret path
//       is exercised rather than described.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// JSONC: comments are allowed, trailing commas are not used here. Strip line comments outside strings.
const parseJsonc = (text) => {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
};

test('wrangler.jsonc is minimal and publishes the directory the build writes', () => {
  const config = parseJsonc(read('wrangler.jsonc'));
  assert.deepEqual(Object.keys(config).sort(), ['compatibility_date', 'name', 'pages_build_output_dir'],
    'the Pages config carries exactly the three fields the site needs - a binding, a Pages Function or a build command here would be a change to the site, not to its hosting');
  assert.equal(config.pages_build_output_dir, 'dist', 'Pages must serve the directory `npm run build` writes');
  assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/, 'compatibility_date must be a date');
  assert.match(config.name, /^[a-z0-9-]+$/, 'the project name is the pages.dev subdomain, so it is lowercase and hyphenated');

  // The output directory in the config and the build must agree: dist/ is what .gitignore keeps out of
  // the repo and what vite.config.js writes.
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.build, 'vite build', 'the build must stay a plain vite build for the Pages output dir to be dist');
  assert.match(read('.gitignore'), /^dist\/$/m, 'dist/ must stay untracked build output');
  assert.equal(fs.existsSync(path.join(root, 'node_modules', 'wrangler')), false,
    'wrangler must not become a dependency of the site: the workflow runs it with npx, so nothing about the build depends on it');
});

test('the deploy workflow names both Cloudflare secrets and never embeds a credential', () => {
  const yaml = read('.github', 'workflows', 'deploy-pages.yml');
  assert.match(yaml, /secrets\.CLOUDFLARE_API_TOKEN/, 'the API token must come from a repository secret');
  assert.match(yaml, /secrets\.CLOUDFLARE_ACCOUNT_ID/, 'the account id must come from a repository secret');
  // No literal token shapes anywhere in the file.
  assert.doesNotMatch(yaml, /\b[A-Za-z0-9_-]{40}\b/, 'no credential value may be embedded in the workflow');
  // Every YAML env assignment of either name must come from a secret - not just the first one, and not
  // just the token: a literal account id in the guard's env would otherwise slip past this test (it did,
  // until this loop covered both names). Shell uses ${NAME:-} tests, which the leading-`NAME:` anchor skips.
  const assignments = yaml.split('\n').filter((l) => /^\s+CLOUDFLARE_(API_TOKEN|ACCOUNT_ID):/.test(l));
  assert.ok(assignments.length >= 4, `expected both names in the guard and the deploy step, found ${assignments.length}`);
  for (const line of assignments) {
    const [name, ...rest] = line.trim().split(':');
    const value = rest.join(':').trim();
    assert.equal(value.startsWith('${{'), true,
      `${name} may only be sourced from a secret, never a literal: ${line.trim()}`);
    assert.match(value, /^\$\{\{\s*secrets\.(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)\s*\}\}$/,
      `${name} must read the repository secret by name, not an expression that could resolve elsewhere: ${line.trim()}`);
  }
  // Both names must appear in BOTH places: the guard's env and the deploy step's env.
  for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
    const at = yaml.split('\n').filter((l) => new RegExp(`^\\s+${name}:`).test(l)).length;
    assert.ok(at >= 2, `${name} must be wired into the guard AND the deploy step, found ${at} assignment(s)`);
  }
  // One automation, not two: the workflow is the only deploy path in the repo (there was no CI before it).
  const workflows = fs.readdirSync(path.join(root, '.github', 'workflows'));
  assert.deepEqual(workflows.filter((f) => /\.ya?ml$/.test(f)), ['deploy-pages.yml'],
    'a second deploy workflow would race this one - keep one');
  // The guard must run BEFORE the deploy step, so a missing secret cannot half-deploy.
  const guardAt = yaml.indexOf('Require the Cloudflare credentials');
  const deployAt = yaml.indexOf('Deploy dist/ to Cloudflare Pages');
  assert.ok(guardAt > -1, 'the workflow needs a named credential guard step');
  assert.ok(deployAt > guardAt, 'the guard must run before the deploy step, not after it');
});

// airhorn-nm7r: the first version of this workflow triggered on `main` while origin/HEAD is `master`, so the
// deploy could never fire - and the same mistake was copied into the comments (`--production-branch main`).
// Exit codes and roster rows were all green; the trigger was the deliverable. This pins the branch against the
// REPOSITORY rather than against a constant: the trigger must name a branch this clone actually has, and must not
// name one it does not. In CI there is no refs/remotes/origin/HEAD, so the equality check is skipped there and the
// membership check still applies.
const gitOut = (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

test('the deploy workflow cannot fire automatically: dispatch only, preview by default', () => {
  const yaml = read('.github', 'workflows', 'deploy-pages.yml');
  // airhorn-9dal production-safety: with both secrets present a push trigger would publish to PRODUCTION on
  // every merge, and Paul has not authorised switching the production origin. Auto-deploy must stay OFF.
  assert.equal(/^on:\s*$/m.test(yaml), true, 'the workflow needs an `on:` block');
  assert.doesNotMatch(yaml, /^\s{2}push:/m,
    'the workflow must have NO push trigger - a merge would deploy to production without an approval gate');
  assert.doesNotMatch(yaml, /^\s{2}pull_request:/m, 'a pull_request trigger would deploy unreviewed code too');
  assert.match(yaml, /^\s{2}workflow_dispatch:/m, 'the deploy must be started by hand');
  assert.match(yaml, /AUTO-DEPLOY-ON-MERGE IS DELIBERATELY OFF/,
    'the workflow must say in words that auto-deploy is deliberately off, so nobody "fixes" it back on');

  // Dispatching is target=preview by default, and a preview must deploy to a branch that is NOT the
  // production branch - otherwise the default manual run would publish to production.
  const targetBlock = /inputs:\s*\n(?:.*\n)*?\s+target:\s*\n(?:\s+.*\n)+?\s+default:\s*(\w+)/.exec(yaml);
  assert.ok(targetBlock, 'the dispatch inputs must declare a `target` with a default');
  assert.equal(targetBlock[1], 'preview', 'the default dispatch target must be preview, not production');
  assert.match(yaml, /options:\s*\[preview, production\]/, 'the target must offer preview and production explicitly');
  assert.match(yaml, /branch=preview-\$\{GITHUB_SHA::7\}/,
    'a preview run must deploy to a preview-<sha> branch, not to the production branch');
  assert.match(yaml, /branch=master/, 'a production run must deploy to the production branch');
  assert.match(yaml, /--branch "\$\{\{ steps\.target\.outputs\.branch \}\}"/,
    'the deploy must use the chosen branch, so target=preview cannot publish to production');
  assert.doesNotMatch(yaml, /--branch "\$\{\{ github\.ref_name \}\}"/,
    'the dispatch branch must not be the deploy branch: workflow_dispatch from master would publish to production');

  // airhorn-nm7r, kept for the day someone re-adds a push trigger: if one exists it must name a branch this
  // clone actually has (the first version named `main` while origin/HEAD is master, so it could never fire).
  const remoteHead = (() => {
    const r = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim().replace(/^origin\//, '') : null;
  })();
  const pushBranches = /^\s{4}branches:\s*\[([^\]]*)\]/m.exec(yaml);
  if (pushBranches) {
    const names = pushBranches[1].split(',').map((b) => b.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    if (remoteHead) assert.ok(names.includes(remoteHead), `a push trigger on ${JSON.stringify(names)} would never fire; the default branch is '${remoteHead}'`);
  }
  // The documented Pages production branch must be the branch a production run deploys to.
  const productionMentions = [...yaml.matchAll(/--production-branch\s+([A-Za-z0-9._/-]+)/g)].map((m) => m[1]);
  assert.ok(productionMentions.length > 0, 'the workflow must document project creation with the production branch');
  for (const observed of productionMentions) {
    assert.equal(observed, 'master', `the Pages production branch must be master (deploys go there for target=production), found '${observed}'`);
    assert.notEqual(observed, 'preview', 'a production branch called preview would make the two deploy paths indistinguishable');
  }
});

// Run the guard exactly as the YAML writes it: extract its `run: |` block, run it under bash with the
// two variables controlled, and read the exit code. This is the "no secret" path the reviewer and CI
// depend on, so it is executed here rather than described.
const guardScript = () => {
  const yaml = read('.github', 'workflows', 'deploy-pages.yml');
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l.includes('Require the Cloudflare credentials'));
  assert.ok(start > -1, 'guard step not found');
  const runAt = lines.findIndex((l, i) => i > start && /^\s+run: \|$/.test(l));
  assert.ok(runAt > -1, 'guard step has no `run: |` block');
  const indent = lines[runAt].search(/\S/);
  const body = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() !== '' && line.search(/\S/) <= indent) break;
    body.push(line.slice(Math.min(indent + 2, line.length)));
  }
  return body.join('\n');
};

const runGuard = (env) => spawnSync('bash', ['-e', '-c', guardScript()], {
  encoding: 'utf8',
  env: { PATH: process.env.PATH, ...env },
});

test('the no-secret path fails by name, before anything is built or deployed', () => {
  for (const missing of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'both']) {
    const env = { CLOUDFLARE_API_TOKEN: 'placeholder', CLOUDFLARE_ACCOUNT_ID: 'placeholder' };
    if (missing === 'both') {
      delete env.CLOUDFLARE_API_TOKEN;
      delete env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      delete env[missing];
    }
    const result = runGuard(env);
    assert.notEqual(result.status, 0, `the guard must FAIL when ${missing} is absent (it exited 0)`);
    assert.match(result.stdout, /Cloudflare credentials missing/, `the failure must be named, stdout was: ${result.stdout}${result.stderr}`);
    if (missing !== 'both') assert.match(result.stdout, new RegExp(missing), 'the message must name the missing secret');
    assert.match(result.stdout, /Nothing was built and nothing was deployed/, 'the message must say that nothing happened, so a half-deploy is not implied');
  }
  const ok = runGuard({ CLOUDFLARE_API_TOKEN: 'placeholder', CLOUDFLARE_ACCOUNT_ID: 'placeholder' });
  assert.equal(ok.status, 0, `with both present the guard must proceed: ${ok.stdout}${ok.stderr}`);
  assert.doesNotMatch(ok.stdout, /placeholder/, 'the guard must not echo the credential values');
});
