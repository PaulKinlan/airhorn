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
  // And that refusal is MEASURED, not an assumption (airhorn-nnos): headless Chrome 155
  // (--headless=new, --no-sandbox, --disable-gpu, --host-resolver-rules MAP airhorn.test 127.0.0.1,
  // cert trusted via --ignore-certificate-errors-spki-list, fresh profile) over the real-HTTPS
  // harness (tools/install-https-proof.mjs, dist built at 822dcc0a, service worker ACTIVATED on
  // every leg) does NOT fire beforeinstallprompt when the manifest's ONLY icon declares NO sizes
  // member ({ src: '/images/airhorn.svg' }) or sizes:"" - the same not-installable signature as
  // the no-icons negative control - while the same harness fires for the repo's explicit-size
  // icons and for sizes:"any" (airhorn-iyim), and the HTTP contrast leg never fired on any run.
  // So refusing {} and sizes:'' is what the browser does; unlike the 'any' refusal this pin is
  // the measured answer, not a false negative. Evidence: /tmp/nnos/{control-default,no-sizes,
  // control-any,control-none,control-empty-sizes}/install-https-evidence.json (driver:
  // /tmp/nnos/run-legs.sh; one variable per leg, one browser at a time, closed in finally).
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

test('sizes:"any" is a scalable declaration and satisfies every required size (airhorn-iyim)', () => {
  // MEASURED, not assumed: with a manifest whose ONLY icon is sizes:"any", headless Chrome 155
  // (--headless=new, --no-sandbox, --disable-gpu, --host-resolver-rules MAP airhorn.test 127.0.0.1,
  // cert trusted via --ignore-certificate-errors-spki-list, fresh profile) over a real HTTPS origin
  // FIRES beforeinstallprompt and enables the app's Install button - so refusing it (the previous
  // behaviour, and the reading airhorn-5006 pinned) was a FALSE NEGATIVE, not a regression: the check
  // failed a site Chrome would install, the airhorn-nxuv.28 bug inverted. The same measurement fixes
  // the rule's SHAPE: the browser honours the token, not the image type or its case.
  //   SVG type=image/svg+xml : fired=True   PNG declaring "any"   : fired=True
  //   SVG with NO type        : fired=True   "ANY" in upper case  : fired=True
  // (raster control fired=True over HTTPS and the HTTP contrast fired=False on every run, so the
  // harness still discriminates). Evidence: /tmp/iyim/{control,svgonly}/install-https-evidence.json,
  // /tmp/iyim2/{png-any,svg-any-notype,svg-any-upper}/install-https-evidence.json.
  assert.deepEqual(missingIconSizes({ icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] }), []);
  assert.deepEqual(missingIconSizes({ icons: [{ src: '/icon.svg', sizes: 'any' }] }), [], 'no type field');
  assert.deepEqual(missingIconSizes({ icons: [{ src: '/i.png', sizes: 'ANY', type: 'image/png' }] }), [], 'case is not the discriminator');
  assert.deepEqual(missingIconSizes({ icons: [{ sizes: '96x96 any' }] }), [], 'one scalable entry covers the list');
  assert.deepEqual(missingIconSizes({ icons: [{ sizes: '96x96' }] }), ['192x192', '512x512'],
    'and the raster rule is unchanged: 96x96 declares neither required size');

  // The token must be EXACT - the substring bug (nxuv.28) must not re-enter through this door.
  for (const spell of ['anything', 'anywhere', 'mana', 'an', 'ANYTHING', '192x192ansi']) {
    assert.deepEqual(missingIconSizes({ icons: [{ sizes: spell }] }), ['192x192', '512x512'],
      `"${spell}" is not the scalable keyword`);
  }
});

test('scope matching is the platform\u2019s PREFIX rule, not a path-segment rule (airhorn-5006, airhorn-c51i)', () => {
  // I first wrote this as a segment-boundary assertion (airhorn-5006) and a reviewer took it apart
  // with the specs (airhorn-c51i): Service Workers' 'Match Service Worker Registration' matches on
  // the SERIALIZED url prefix, with a normative note that "prefix-of/resource.html" is within scope
  // "prefix", and the Web App Manifest's 'within scope' algorithm compares the target and scope as
  // strings, so query and fragment never move a url out of scope. The rule below is therefore the
  // platform's, and the cases that would distinguish a segment rule are exactly the cases that
  // PROVE the platform is not one.
  const facts = {
    scope: 'https://localhost:8443/app',
    manifestHref: 'https://localhost:8443/app/manifest.json',
    pageHref: 'https://localhost:8443/app/',
  };
  const inScope = (startUrl, scope = facts.scope) => startUrlInScope({ ...facts, scope, startUrl }).inScope;

  // Same path, different query or fragment: in scope (a segment rule would wrongly refuse).
  assert.equal(inScope('/app?source=pwa'), true, 'a query does not move a start_url out of scope');
  assert.equal(inScope('/app#home'), true, 'a fragment does not move a start_url out of scope');
  // Plain children and the scope itself.
  assert.equal(inScope('/app/'), true);
  assert.equal(inScope('/app/index.html'), true);
  // A scope WITHOUT its trailing slash is a prefix, so a sibling that shares the prefix is inside
  // it. This is the spec's own example, not an accident.
  assert.equal(inScope('/app-evil/index.html'), true,
    'https://h/app is a prefix of https://h/app-evil/index.html, so the platform puts it in scope');
  // The /app-evil protection therefore comes from the trailing slash the platform supplies.
  assert.equal(inScope('/app-evil/index.html', 'https://localhost:8443/app/'), false,
    'with the scope the browser actually reports (/app/), the sibling is outside');
  // And an unrelated path is outside either way.
  assert.equal(inScope('/other/index.html', 'https://localhost:8443/app/'), false);
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
  // `sizes: "any"` is NOT pinned here: airhorn-iyim measured that Chrome installs such a manifest and
  // owns that decision, which is why the exactness rule here is about WxH tokens only.
  // A caller can ask for different requirements without changing the rule.
  assert.deepEqual(missingIconSizes({ icons: [{ sizes: '192x192' }], required: ['192x192'] }), []);
  assert.deepEqual(missingIconSizes({ icons: [{ sizes: '192x192' }], required: ['512x512'] }), ['512x512']);
});
