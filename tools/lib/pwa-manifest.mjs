/**
 * Two installability facts the HTTPS proof claimed to check and did not.
 *
 * `tools/install-https-proof.mjs` collected `startUrlInScope` with
 * `reg.scope === '/'` - but `ServiceWorkerRegistration.scope` is an ABSOLUTE URL
 * (`https://host:port/`), so the comparison was false on every run, even a correct
 * one. The field was then never asserted at all, so a manifest whose start_url sits
 * outside the worker's scope produced a green report (airhorn-nxuv.28).
 *
 * The icon filter was `String(i.sizes).includes('192')`, so an icon declared
 * `1920x1080` satisfied the 192 requirement - a size substring is not a size.
 *
 * Both rules are pure here, so both worlds can be proven without a browser.
 */

/** Resolve a possibly-relative start_url against the manifest's own URL. */
export function resolveStartUrl({ startUrl, manifestHref, pageHref }) {
  const base = manifestHref || pageHref;
  const raw = startUrl === undefined || startUrl === null || startUrl === '' ? './' : String(startUrl);
  try {
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

/**
 * Is the manifest's start_url inside the service worker's registration scope?
 *
 * @param {{ scope?: string, startUrl?: string, manifestHref?: string, pageHref?: string }} facts
 *   `scope` is `reg.scope` (absolute), `startUrl` is `manifest.start_url` (usually
 *   relative), `manifestHref` is the resolved `<link rel="manifest">` URL.
 * @returns {{ inScope: boolean, scopeHref: string|null, startUrlHref: string|null, reason: string }}
 */
export function startUrlInScope({ scope, startUrl, manifestHref, pageHref } = {}) {
  let scopeHref = null;
  try {
    scopeHref = scope ? new URL(String(scope), pageHref || manifestHref).href : null;
  } catch {
    scopeHref = null;
  }
  const startUrlHref = resolveStartUrl({ startUrl, manifestHref, pageHref });

  if (!scopeHref) {
    return {
      inScope: false,
      scopeHref: null,
      startUrlHref,
      reason: 'no registration scope was observed, so nothing can be in scope',
    };
  }
  if (!startUrlHref) {
    return {
      inScope: false,
      scopeHref,
      startUrlHref: null,
      reason: `the manifest start_url (${JSON.stringify(startUrl)}) does not resolve against ${manifestHref || pageHref}`,
    };
  }
  // Scope matching is PREFIX-based on the SERIALIZED url, and deliberately not path-structural.
  // Both normative algorithms say so: Service Workers' 'Match Service Worker Registration'
  // picks the longest scope string the client url starts with, with a note that the match is
  // prefix-based and that https://example.com/prefix-of/resource.html is within the scope
  // https://example.com/prefix; the Web App Manifest's 'within scope' algorithm compares target
  // against scope as strings, so a query or fragment does not move a url out of scope.
  //
  // The consequence that matters for /app-evil: it is excluded by the scope's TRAILING SLASH,
  // which the platform always supplies (reg.scope for a script at /app/sw.js is /app/), not by
  // any segment logic here. A scope without that slash genuinely contains /app-evil - per spec,
  // not by oversight. airhorn-c51i: a segment-boundary rule here false-rejected /app?source=pwa,
  // /app#home and /app-evil against a scope of /app.
  const inScope = startUrlHref.startsWith(scopeHref);
  return {
    inScope,
    scopeHref,
    startUrlHref,
    reason: inScope
      ? `start_url ${startUrlHref} is inside the registration scope ${scopeHref}`
      : `start_url ${startUrlHref} is OUTSIDE the registration scope ${scopeHref}`,
  };
}

/**
 * Which of the required icon sizes the manifest does not actually declare.
 *
 * `sizes` is a whitespace-separated list of exact `WxH` tokens; an icon declared
 * `1920x1080` is not a 192x192 icon.
 */
export function missingIconSizes({ icons, required = ['192x192', '512x512'] } = {}) {
  const declared = new Set();
  for (const icon of Array.isArray(icons) ? icons : []) {
    for (const token of String(icon && icon.sizes ? icon.sizes : '').trim().split(/\s+/)) {
      if (token) declared.add(token.toLowerCase());
    }
  }
  return required.filter((size) => !declared.has(String(size).toLowerCase()));
}
