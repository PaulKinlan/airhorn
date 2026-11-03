import path from 'node:path';

/*
 * tools/lib/request-path.mjs — untrusted request URLs, refused with a NAME.
 *
 * The tools all serve dist/ on loopback for a browser to drive, and each one turned
 * `req.url` into a file path by hand. Two failure modes came from that (embargoed factory
 * findings, 2026-11-03):
 *
 *   1. an unguarded decodeURIComponent threw URIError on a malformed percent-escape
 *      ("/%zz"), killing the whole run mid-measurement with a stack instead of an HTTP
 *      status. resilience-audit.mjs already had the right shape - try/catch -> 400 - so
 *      that shape is copied here rather than a second one invented;
 *   2. path.join(root, '/../../etc/passwd') followed the path out of the root, because
 *      path.join normalises '..' and nobody checked the result (idle-cost, measure-perf
 *      had no containment check at all).
 *
 * Both return `{ ok: true, ... }` or `{ ok: false, status, reason }`, where the reason
 * names what was refused - a refusal an operator cannot read is not much better than a
 * crash.
 */

/** Decode a request URL's path. A malformed escape is a 400 naming the raw URL. */
export function decodeRequestPath(rawUrl) {
  const raw = String(rawUrl ?? '/');
  const withoutQuery = raw.split('?')[0] || '/';
  try {
    return { ok: true, pathname: decodeURIComponent(withoutQuery) };
  } catch {
    return {
      ok: false,
      status: 400,
      reason: `bad percent-escape in the request URL ${JSON.stringify(raw)} - the path cannot be decoded, so it was refused instead of throwing`,
    };
  }
}

/**
 * Join a decoded request path onto the served root, refusing anything that escapes it.
 * Containment is checked as a path PREFIX with a separator, so /dist-evil cannot pass by
 * sharing a string prefix with /dist.
 */
export function resolveWithinRoot(root, requestPath) {
  const relative = requestPath === '/' || requestPath === '' ? 'index.html' : requestPath;
  const resolvedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  const filePath = path.resolve(root, '.' + (relative.startsWith('/') ? relative : `/${relative}`));
  if (filePath !== path.resolve(root) && !filePath.startsWith(resolvedRoot)) {
    return {
      ok: false,
      status: 403,
      reason: `refusing to serve ${JSON.stringify(requestPath)}: it resolves to ${filePath}, which is outside the served root ${root}`,
    };
  }
  return { ok: true, filePath };
}

/**
 * The whole request path in one call, the way every tool's handler wants it:
 * decode, then contain. `ok:false` carries the status and the named reason to send back.
 */
export function resolveRequestUrl(root, rawUrl) {
  const decoded = decodeRequestPath(rawUrl);
  if (!decoded.ok) return decoded;
  const contained = resolveWithinRoot(root, decoded.pathname);
  // Callers want the decoded path AND the file: soak matches on the path (/sw.js) before
  // it reads anything, so returning only the file would force a second decode in the handler.
  return contained.ok ? { ...contained, pathname: decoded.pathname } : contained;
}
