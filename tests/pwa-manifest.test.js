import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { missingIconSizes, resolveStartUrl, startUrlInScope } from '../tools/lib/pwa-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What this pins (airhorn-nxuv.28): the HTTPS proof collected `startUrlInScope` with
// `reg.scope === '/'` - always false, because a registration scope is an absolute URL -
// and then never asserted the field, so a start_url outside the worker's scope shipped
// a green report. The icon check was `String(sizes).includes('192')`, which an
// 1920x1080 icon satisfies.

test('an ABSOLUTE scope is in scope for a relative start_url (the old read said false)', () => {
  // The old read, pinned: this is exactly the pair the tool observed on every run.
  const OLD_READ = (scope) => scope === '/';
  const scope = 'https://localhost:8443/';
  assert.equal(OLD_READ(scope), false, 'the old comparison is false for a real scope');

  const verdict = startUrlInScope({
    scope,
    startUrl: './',
    manifestHref: 'https://localhost:8443/manifest.json',
    pageHref: 'https://localhost:8443/',
  });
  assert.equal(verdict.inScope, true, verdict.reason);
  assert.equal(verdict.scopeHref, scope);
  assert.equal(verdict.startUrlHref, 'https://localhost:8443/');
  assert.match(verdict.reason, /is inside the registration scope/);
});

test('a start_url OUTSIDE the scope is a failure, and says why (airhorn-nxuv.28)', () => {
  const verdict = startUrlInScope({
    scope: 'https://localhost:8443/app/',
    startUrl: '/outside/',
    manifestHref: 'https://localhost:8443/app/manifest.json',
    pageHref: 'https://localhost:8443/app/',
  });
  assert.equal(verdict.inScope, false);
  assert.match(verdict.reason, /OUTSIDE the registration scope/);
});

test('scope is a URL prefix, not a pathname prefix (airhorn-nxuv.28)', () => {
  // /app-evil/ starts with the STRING /app but is not inside the scope /app/.
  const verdict = startUrlInScope({
    scope: 'https://localhost:8443/app/',
    startUrl: '/app-evil/',
    manifestHref: 'https://localhost:8443/app/manifest.json',
    pageHref: 'https://localhost:8443/app/',
  });
  assert.equal(verdict.inScope, false, verdict.reason);
});

test('an unmeasured scope is not a pass (airhorn-nxuv.28)', () => {
  for (const scope of [undefined, null, '']) {
    const verdict = startUrlInScope({ scope, startUrl: './', pageHref: 'https://localhost:8443/' });
    assert.equal(verdict.inScope, false, `scope=${scope} must not read as in scope`);
    assert.match(verdict.reason, /no registration scope/);
  }
  // ...and an unresolvable start_url is not a pass either.
  const bad = startUrlInScope({ scope: 'https://h/', startUrl: './', manifestHref: 'not a url' });
  assert.equal(bad.inScope, false);
});

test('a start_url resolves against the MANIFEST url, not the page url (airhorn-nxuv.28)', () => {
  const verdict = startUrlInScope({
    scope: 'https://localhost:8443/app/',
    startUrl: './',
    manifestHref: 'https://localhost:8443/app/manifest.json',
    pageHref: 'https://localhost:8443/',
  });
  assert.equal(verdict.startUrlHref, 'https://localhost:8443/app/');
  assert.equal(verdict.inScope, true);
  assert.equal(resolveStartUrl({ startUrl: undefined, pageHref: 'https://h/x/' }), 'https://h/x/');
});

test('icon sizes are exact tokens, so 1920x1080 is NOT a 192 icon (airhorn-nxuv.28)', () => {
  // The old filter, pinned: it accepted a size that merely contains the digits.
  const OLD_FILTER = (icons, want) => icons.some((i) => String(i.sizes || '').includes(want));
  const misleading = [{ sizes: '1920x1080' }];
  assert.equal(OLD_FILTER(misleading, '192'), true, 'the old filter accepts 1920x1080 for 192');

  assert.deepEqual(missingIconSizes({ icons: misleading }), ['192x192', '512x512']);

  // The real manifest declarations pass, including a multi-size entry.
  assert.deepEqual(missingIconSizes({
    icons: [{ sizes: '192x192' }, { sizes: '512x512 1024x1024' }],
  }), []);

  // Case and spacing are tolerated; a missing sizes field is not a match.
  assert.deepEqual(missingIconSizes({ icons: [{ sizes: ' 192X192 ' }, { sizes: '512x512' }] }), []);
  assert.deepEqual(missingIconSizes({ icons: [{}, null, { sizes: '' }] }), ['192x192', '512x512']);
});

test('the tool no longer asks whether the scope is the string / and does assert both facts (airhorn-nxuv.28)', () => {
  // A pure-rule test cannot stop the tool ignoring the rule, and that is how the bug
  // lived: the field was collected with an always-false comparison and never asserted.
  const source = fs.readFileSync(path.join(root, 'tools', 'install-https-proof.mjs'), 'utf8');
  assert.ok(!source.includes("reg.scope === '/'"),
    'the always-false scope comparison must be gone');
  assert.ok(!/\.includes\(s\)/.test(source) || !source.includes("['192','512']"),
    'the size SUBSTRING filter must be gone');
  assert.ok(source.includes('startUrlInScope('), 'the tool must use the scope rule');
  assert.ok(source.includes('missingIconSizes('), 'the tool must use the exact-size rule');
  assert.ok(source.includes('if (!httpsEv.startUrlInScope)'),
    'the HTTPS leg must FAIL when the start_url is out of scope');
  assert.ok(source.includes('httpsEv.missingIconSizes.length > 0'),
    'the HTTPS leg must FAIL when a required icon size is missing');
});

test('the scope rule is a SEGMENT prefix, which a string prefix is not (airhorn-5006)', () => {
  // The gap the browser could not close: reg.scope always carries its trailing slash, so in a
  // real page both rules refuse /app-evil/ against /app/ and the two are indistinguishable.
  // Here the scope has NO trailing slash, which is where the rules disagree.
  const STRING_PREFIX_ONLY = (scope, startUrl) => startUrl.startsWith(scope);
  const facts = {
    scope: 'https://localhost:8443/app',
    startUrl: '/app-evil/index.html',
    manifestHref: 'https://localhost:8443/app/manifest.json',
    pageHref: 'https://localhost:8443/app/',
  };
  const naive = STRING_PREFIX_ONLY(facts.scope, new URL(facts.startUrl, facts.pageHref).href);
  assert.equal(naive, true, 'a string prefix DOES accept /app-evil inside /app - that is the bug');

  const verdict = startUrlInScope(facts);
  assert.equal(verdict.inScope, false, `a segment prefix must refuse it: ${verdict.reason}`);

  // ...and the sibling cases, so the boundary rule is not just "refuse siblings":
  assert.equal(startUrlInScope({ ...facts, startUrl: '/app/index.html' }).inScope, true,
    'a real child of the scope is still in scope');
  assert.equal(startUrlInScope({ ...facts, startUrl: '/app' }).inScope, true,
    'the scope itself is in scope');
  // A scope WITH its trailing slash does not accept its own path without one: /app is not
  // inside /app/ (the URL model, not string slicing).
  assert.equal(startUrlInScope({ ...facts, scope: 'https://localhost:8443/app/', startUrl: '/app' }).inScope,
    false, '/app is not inside /app/');
});

test('the icon enumeration: every spelling the manifest allows is exercised (airhorn-5006)', () => {
  // One entry declaring several sizes (the shape big manifests use).
  assert.deepEqual(missingIconSizes({ icons: [{ sizes: '192x192 512x512' }] }), []);
  // Whitespace-padded and upper-case tokens.
  assert.deepEqual(missingIconSizes({ icons: [{ sizes: '  192X192   512x512  ' }] }), []);
  // Several entries, one per size, plus an unrelated size that must not count as either.
  assert.deepEqual(missingIconSizes({ icons: [{ sizes: '96x96' }, { sizes: '512x512' }, { sizes: '192x192' }] }), []);
  // A required size satisfied only as a PREFIX or SUFFIX is not satisfied.
  assert.deepEqual(missingIconSizes({ icons: [{ sizes: '1192x1920' }, { sizes: '512x5120' }] }), ['192x192', '512x512']);
  // `sizes: any` is the SVG spelling and does NOT declare an exact raster size - pinned as the
  // current decision (a manifest that relies on it is refused), see airhorn-5006 for the
  // open question of whether Chrome would install such a manifest.
  assert.deepEqual(missingIconSizes({ icons: [{ sizes: 'any' }] }), ['192x192', '512x512']);
  // A caller can ask for different requirements without changing the rule.
  assert.deepEqual(missingIconSizes({ icons: [{ sizes: '192x192' }], required: ['192x192'] }), []);
  assert.deepEqual(missingIconSizes({ icons: [{ sizes: '192x192' }], required: ['512x512'] }), ['512x512']);
});
