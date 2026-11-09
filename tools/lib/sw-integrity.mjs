/*
 * tools/lib/sw-integrity.mjs - the build side of the worker's integrity records (airhorn-oybq).
 *
 * The worker records a digest of every body it precaches and re-checks that digest on every offline read. That catches
 * a body changed AFTER the install, but the record itself was TRUST-ON-FIRST-USE: the baseline digest was computed from
 * the very fetch it later vouched for, so a poisoned first fetch became the truth. Nothing in the worker can fix that on
 * its own - a worker can only compare bytes against something it did not derive from those bytes.
 *
 * So the build produces the something: one SHA-256 per file it emits, injected into dist/sw.js. The worker then refuses
 * a first fetch whose bytes disagree with the build, which turns "the first copy is assumed good" into "the first copy
 * must equal what the builder shipped".
 *
 * Kept out of vite.config.js so it can be tested without running a build, and so the mapping rule ('/' is index.html)
 * exists in exactly one place.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The identifier the worker carries; the build replaces EVERY occurrence with a digest-map literal.
 *
 * An identifier rather than a comment placeholder (the first attempt used one, and it produced `{...} {}` - the
 * placeholder's own trailing `{}` survived, and the BUILT worker was a syntax error that no test noticed because the
 * tests read the source, not dist/). The `typeof` guard in the worker makes an UNBUILT worker parse and run with an
 * empty map instead of throwing a ReferenceError, so the degradation is the documented TOFU warning rather than a
 * broken service worker.
 */
export const INTEGRITY_PLACEHOLDER = '__PRECACHE_INTEGRITY__';

/** The URL a file in the output directory is served under. */
export function servedPathFor(relativePath) {
  const posix = relativePath.split(path.sep).join('/');
  return posix === 'index.html' ? '/' : `/${posix}`;
}

/**
 * Every path a file is precached under, which for one file can be several (airhorn-lu8a).
 *
 * The worker precaches BOTH shell spellings on purpose (airhorn-btt: `/` for navigations, `/index.html` for in-page
 * fetches and the navigation fallback), and they are one file. Mapping index.html only to '/' left '/index.html' with no
 * build digest, so basisFor() fell back to TOFU for a path the worker precaches statically: a poisoned first fetch of
 * '/index.html' installed cleanly and was served offline as a verified hit. The manifest must cover every spelling the
 * worker asks for, not just the canonical one.
 */
export function servedPathsFor(relativePath) {
  const primary = servedPathFor(relativePath);
  return primary === '/' ? ['/', '/index.html'] : [primary];
}

/**
 * SHA-256 of every file the build emitted, keyed by the path the browser asks for.
 *
 * Deliberately the WHOLE output, not a hand-kept list: the worker precaches a fixed set plus whatever hashed assets
 * index.html names, and a list here would drift from that set and silently stop binding the ones someone forgot. A file
 * the worker never asks for costs one hash and nothing else.
 */
export function digestsFor(distDir) {
  const digests = {};
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) { walk(full, rel); continue; }
      if (!entry.isFile()) continue;
      // sw.js itself is not served to the page as content and cannot contain its own digest.
      if (servedPathFor(rel) === '/sw.js') continue;
      const sha = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      for (const served of servedPathsFor(rel)) digests[served] = sha;
    }
  };
  if (fs.existsSync(distDir)) walk(distDir, '');
  return digests;
}

/**
 * Replace the placeholder in the worker source with the digest map.
 *
 * An EMPTY map is valid and means "not bound" - the worker says so out loud at install (see sw.js) rather than pretending
 * to verify, because a manifest that quietly binds nothing is worse than no manifest: it reads as a guarantee.
 */
export function injectIntegrity(swSource, digests) {
  if (!swSource.includes(INTEGRITY_PLACEHOLDER)) return swSource;
  const object = `{${Object.keys(digests).sort().map((key) => `${JSON.stringify(key)}:${JSON.stringify(digests[key])}`).join(',')}}`;
  return swSource.split(INTEGRITY_PLACEHOLDER).join(object);
}
