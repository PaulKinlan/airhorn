// Pin for the Content-Security-Policy the site actually ships (airhorn-xnd1,
// decision airhorn-ao23 / ADR-0002).
//
// The policy was withheld (airhorn-kv7m) because index.html carried two inline
// <script> blocks, two inline event-handler attributes on the stylesheet link and
// one inline <style>. Those are now three external files plus one hashed style,
// so the header ships - and this suite is what keeps it honest:
//
//   1. the policy is the reviewed one, DIRECTIVE BY DIRECTIVE, so a silently
//      weakened directive fails by name;
//   2. the style hash it carries is the SHA-256 of the <style> element's text in
//      the BUILT document - a dynamic fact (ADR-0001), not a copy of a sentence.
//      What the browser hashes is the text of the element it was served; today
//      the build leaves that text untouched, and pinning the built bytes is what
//      makes that an observed fact rather than an assumption about Vite;
//   3. the document the build emits has nothing left for the policy to block:
//      every <script> has a src, no element carries an on* handler attribute,
//      and there is exactly one inline <style> - the one the hash allows;
//   4. every external script the document asks for exists in the build, and the
//      worker precaches it with a build digest (an uncovered statically
//      precached path makes the install refuse - airhorn-lu8a).
//
// A pin nobody has seen fail is a pin nobody can trust, so the hash comparison is
// exercised against a mutated header below. The BEHAVIOUR under the enforced
// policy (page boots, sheet applies, watchdog reveals, horn sounds) is
// tests/csp-enforced.test.mjs: this file proves the artifact, that one proves the
// browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePagesHeaders } from '../tools/lib/static-server.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

// The one policy. Every directive the site relies on, with the value it must
// carry. `style-src`'s hash is filled in from the build (see expectedPolicy).
const EXPECTED_DIRECTIVES = {
  'default-src': "'self'",
  'script-src': "'self'",
  'img-src': "'self' data:",
  'media-src': "'self'",
  'connect-src': "'self'",
  'worker-src': "'self'",
  'manifest-src': "'self'",
  'base-uri': "'none'",
  'form-action': "'none'",
  'frame-ancestors': "'none'",
  'object-src': "'none'",
};

/** Split a policy into {directive: value}. Duplicates are refused, not merged. */
function parsePolicy(text) {
  const out = {};
  for (const part of text.split(';')) {
    const clause = part.trim();
    if (!clause) continue;
    const [name, ...values] = clause.split(/\s+/);
    assert.equal(Object.hasOwn(out, name), false,
      `the policy declares ${name} twice; a browser intersects duplicates, so the page would be blocked for a reason nobody can read`);
    out[name] = values.join(' ');
  }
  return out;
}

/**
 * The single CSP line public/_headers APPLIES, or a named failure.
 *
 * Note the syntax: `/*` is the all-paths PATTERN in Pages `_headers`, not a comment opener,
 * and there is no block terminator - `#` is the comment. So the file is parsed by the same
 * parser the released test server runs (tools/lib/static-server.mjs, airhorn-yxxq) rather
 * than by a local guess at comment syntax: a rule that parser refuses is a rule no test ever
 * runs with, and the first version of this header shipped a block-terminator line that it
 * (correctly) refused - which is what caught it.
 */
function shippedPolicyText(headers = read('public', '_headers')) {
  const applied = parsePagesHeaders(headers); // throws by name outside the supported subset
  const policy = applied['Content-Security-Policy'];
  assert.ok(policy,
    'public/_headers must apply a Content-Security-Policy under the /* all-paths pattern; without it the site ships with no policy at all');
  const lines = headers.split('\n').filter((line) => /^\s*Content-Security-Policy:/i.test(line));
  assert.equal(lines.length, 1,
    `the /* block must carry exactly one Content-Security-Policy line (found ${lines.length}); two policies intersect in the browser, so the page fails for a reason no single line shows`);
  return policy;
}

/** SHA-256 of a style element's text, in the CSP's own spelling. */
function styleHash(styleText) {
  return `sha256-${crypto.createHash('sha256').update(styleText, 'utf8').digest('base64')}`;
}

/** The text of the document's one inline <style>, or a named failure. */
function inlineStyleText(document) {
  const matches = [...document.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  assert.equal(matches.length, 1,
    `the built document must carry exactly one inline <style> (the hashed critical layer); found ${matches.length}. `
    + 'A second one is blocked by style-src and its styles silently never apply');
  return matches[0][1];
}

/**
 * Assert the shipped policy is exactly the reviewed one, with the hash the built
 * document actually needs. Throws (never warns) so it can be exercised below.
 */
function assertShippedPolicy(headers, document) {
  const directives = parsePolicy(shippedPolicyText(headers));
  const expected = {
    ...EXPECTED_DIRECTIVES,
    'style-src': `'self' '${styleHash(inlineStyleText(document))}'`,
  };
  assert.deepEqual(directives, expected);
  return directives;
}

const distIndex = () => read('dist', 'index.html');

test('the shipped CSP is the reviewed policy, directive by directive', () => {
  assertShippedPolicy(read('public', '_headers'), distIndex());
});

test('the style hash is the digest of the style the browser is served', () => {
  const directives = assertShippedPolicy(read('public', '_headers'), distIndex());
  const hash = styleHash(inlineStyleText(distIndex()));
  assert.ok(directives['style-src'].includes(hash),
    `style-src must allow ${hash}; without it the critical layer is blocked and the page paints unstyled`);
  // The source and the built document agree today (the build does not rewrite
  // the style body). Pinned so a Vite upgrade that starts rewriting it cannot
  // leave the header allowing a digest the browser never computes.
  assert.equal(styleHash(inlineStyleText(read('index.html'))), hash,
    'the built style text no longer matches the source: the policy must carry the digest of what is SERVED, so re-derive it from dist/index.html');
});

test('the pin can fail: a stale style hash is refused, by name', () => {
  const headers = read('public', '_headers');
  const document = distIndex();
  const live = styleHash(inlineStyleText(document));
  const stale = styleHash(`${inlineStyleText(document)}/* edited after the header was written */`);
  // The mutation must be the ONLY difference, or this proves nothing.
  assert.notEqual(stale, live, 'the negative control is not actually different');
  assert.throws(
    () => assertShippedPolicy(headers.replace(live, stale), document),
    (err) => /style-src/.test(err.message) && stale.length > 0,
    'a header whose style hash does not match the built style must be refused by the pin, and the failure must name style-src');
  assert.throws(
    () => assertShippedPolicy(`${headers.trimEnd()}\n  Content-Security-Policy: default-src *\n`, document),
    /exactly one Content-Security-Policy/,
    'a second policy must be refused: the browser intersects them and the page fails invisibly');
  // The syntax the first version of this header got wrong. `/*` is the all-paths PATTERN and
  // Pages has no block terminator, so a `*/` line is an unparseable rule - refused by name,
  // not carried as a header Pages would ignore.
  assert.throws(
    () => assertShippedPolicy(`${headers.trimEnd()}\n*/\n`, document),
    /expected 'Key: value'/,
    'a */ line must be refused: Pages _headers has no block terminator, so that line is not a rule any server applies');
  assert.throws(
    () => assertShippedPolicy(headers.replace(/^\/\*$/m, '# no pattern'), document),
    /only a \/\* path block/,
    'a file with no /* all-paths pattern must be refused: nothing is applied without one, so the CSP would silently not ship');
});

test('the built document leaves nothing for script-src to block', () => {
  const document = distIndex();
  // The critical layer must NOT declare overscroll-behavior: tests/csp-enforced.test.mjs
  // reads that property off <body> as the proof that the swapped-in main.css is
  // what styles the page, and it would stop discriminating if the inline layer
  // carried it too.
  assert.doesNotMatch(inlineStyleText(document), /overscroll-behavior/,
    'the critical layer now declares overscroll-behavior, which is the property the enforced-policy suite uses to prove main.css applied - pick another main.css-only property there, or drop that assertion');
  // Strip comments first: prose may legitimately mention `onload=` or `<script>`,
  // and a scan that counted prose would be a rule about wording, not the artifact.
  const markup = document.replace(/<!--[\s\S]*?-->/g, '');
  const scriptTags = [...markup.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  assert.ok(scriptTags.length >= 4, `expected the document's scripts, found ${JSON.stringify(scriptTags)}`);
  for (const tag of scriptTags) {
    assert.match(tag, /\ssrc\s*=/i,
      `${tag} has no src, so it is an inline script and script-src 'self' blocks it silently`);
  }
  const handlerAttributes = [...markup.matchAll(/<[a-z][^>]*?\s(on[a-z]+)\s*=/gi)].map((m) => m[1]);
  assert.deepEqual(handlerAttributes, [],
    `inline event-handler attributes are blocked by script-src and fail silently (${handlerAttributes.join(', ')}); an attribute does not run without 'unsafe-inline'`);
  // The critical layer stays inline ON PURPOSE (it is what paints before the
  // async sheet lands) and is allowed by the hash pinned above.
  assert.equal([...markup.matchAll(/<style\b/gi)].length, 1,
    'exactly one inline <style> is allowed, and only because the policy hashes it');
});

test('the document asks for the external files the build ships, in the order the loader needs', () => {
  const document = distIndex().replace(/<!--[\s\S]*?-->/g, '');
  for (const file of ['/boot-watchdog.js', '/sw-register.js', '/async-css.js']) {
    assert.ok(document.includes(`src='${file}'`) || document.includes(`src="${file}"`),
      `the built document must load ${file}; it is an external file now (airhorn-xnd1)`);
    assert.ok(fs.existsSync(path.join(root, 'dist', file.slice(1))),
      `dist${file} is missing: the document asks for a file the build did not emit`);
  }
  // Ordering the loader depends on: the media swap must be attached to the link
  // element by a script the parser runs right after it. A load/error event that
  // lands before the listener exists would leave media at 'print' forever.
  const linkAt = document.search(/<link[^>]*id=['"]main-css['"]/);
  assert.ok(linkAt > -1, "the stylesheet link must keep id='main-css' - /async-css.js finds it by that id");
  const linkTag = document.slice(linkAt, document.indexOf('>', linkAt) + 1);
  assert.match(linkTag, /media=['"]print['"]/,
    'the sheet must stay media=print so it never blocks first paint; the swap is what makes it apply');
  assert.doesNotMatch(linkTag, /\son[a-z]+=/i,
    'no inline handler may be left on the link: that is the attribute CSP blocks silently');
  const loaderAt = document.search(/<script[^>]*src=['"]\/async-css\.js['"]/);
  assert.ok(loaderAt > linkAt, 'the loader must come after the link it configures');
  const loaderTag = document.slice(loaderAt, document.indexOf('>', loaderAt) + 1);
  // Paint timing is part of the contract (airhorn-xnd1 requirement 1): a
  // parser-blocking script here would put a new round trip in front of first
  // paint. Deferred, the fetch runs during parse and the execution after it.
  assert.match(loaderTag, /\sdefer\b/,
    `${loaderTag} must be deferred: a parser-blocking loader is a new round trip in front of first paint, which this change may not add`);
  assert.equal(document.slice(linkAt, loaderAt).match(/<script\b/gi), null,
    'nothing may be parsed between the link and its loader: the reconcilation inside the loader is what closes the event race, and it only runs once');
});

test('the worker precaches the three new files and the build digest covers them', () => {
  const worker = read('dist', 'sw.js');
  const list = worker.match(/const precacheUrls = \[([\s\S]*?)\];/)?.[1];
  assert.ok(list, 'could not read precacheUrls from the built worker: the build changed shape');
  // The build injects the digest map as a JSON object literal; read it as one
  // rather than guessing at entry shapes.
  const tail = worker.slice(worker.indexOf('const buildDigests'));
  const literal = tail.slice(tail.indexOf('? ') + 2, tail.indexOf(' : {}'));
  let digests;
  try {
    digests = JSON.parse(literal);
  } catch {
    assert.fail(`could not read the injected build digest map from dist/sw.js: ${JSON.stringify(literal.slice(0, 120))}`);
  }
  for (const file of ['/boot-watchdog.js', '/sw-register.js', '/async-css.js']) {
    assert.ok(new RegExp(`["'\u0060]${file.replace(/\./g, '\\.')}["'\u0060]`).test(list),
      `${file} must be precached: without it an offline first load has no watchdog, no SW registration and no media swap`);
    // basisFor() THROWS for a statically precached path the build manifest omits
    // (airhorn-lu8a), so an uncovered entry would refuse the whole install.
    assert.match(digests[file] || '', /^[0-9a-f]{64}$/,
      `${file} is precached but has no build digest, so the install would refuse it (airhorn-lu8a)`);
  }
});
