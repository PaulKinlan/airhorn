import fs from 'node:fs';
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

const insideOf = (root, candidate) => {
  const resolvedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate === path.resolve(root) || candidate.startsWith(resolvedRoot);
};

/**
 * Join a decoded request path onto the served root, refusing anything that escapes it.
 *
 * TWO checks, and the second is the one that matters (review finding on airhorn-k0xp):
 *  1. LEXICAL: the joined path must stay under the root, so '..' is refused even when the
 *     target does not exist. This is a path prefix WITH a separator, so a sibling directory
 *     sharing a string prefix cannot pass.
 *  2. REAL: the joined path is resolved with realpath and the RESULT must still be inside the
 *     real root. A lexical check alone is bypassed by a symlink that lives inside the root and
 *     points outside it: '/linked.txt' looks contained and reads /etc/passwd. The reviewer
 *     reproduced exactly that (200 with a file from outside dist).
 *
 * Unresolvable real paths fail CLOSED rather than falling back to the lexical answer:
 *   - ENOENT  -> 404 naming the missing target (the file genuinely is not there);
 *   - ELOOP   -> 403 naming the loop, so a symlink cycle is not silently "not found";
 *   - anything else (EACCES, ENOTDIR) -> 403 naming the code.
 * A directory resolves through its index.html, and THAT path is re-checked, so a symlinked
 * directory cannot serve a listing or a file from outside the root.
 *
 * TOCTOU: this resolves first and hands back the REAL path, which the caller opens. A symlink
 * swapped between the check and the read is therefore not followed - the read uses the target
 * the check approved. Residual risk, stated rather than claimed closed: a component of the
 * real path could be renamed and re-created between resolution and open, so the bytes could
 * differ from the ones checked; they would still come from a path inside the root, which is
 * the same power an operator editing dist/ already has. Containment is not bypassed by that.
 */
export function resolveWithinRoot(root, requestPath, { realpath = fs.realpathSync.bind(fs) } = {}) {
  const relative = requestPath === '/' || requestPath === '' ? 'index.html' : requestPath;
  const lexical = path.resolve(root, '.' + (relative.startsWith('/') ? relative : `/${relative}`));

  if (!insideOf(root, lexical)) {
    return {
      ok: false,
      status: 403,
      reason: `refusing to serve ${JSON.stringify(requestPath)}: it resolves to ${lexical}, which is outside the served root ${root}`,
    };
  }

  let realRoot;
  try {
    realRoot = realpath(root);
  } catch {
    // The root itself is unreadable: we cannot prove containment, so nothing is served.
    return { ok: false, status: 403, reason: `refusing to serve ${JSON.stringify(requestPath)}: the served root ${root} cannot be resolved` };
  }

  const resolveTarget = (candidate) => {
    try {
      return { real: realpath(candidate) };
    } catch (error) {
      const code = error && error.code ? error.code : 'unknown';
      if (code === 'ELOOP') {
        return {
          refusal: {
            ok: false,
            status: 403,
            reason: `refusing to serve ${JSON.stringify(requestPath)}: ${candidate} is a symlink loop (ELOOP) - the target can never be contained, so it is refused as a loop rather than reported as missing`,
          },
        };
      }
      if (code === 'ENOENT') {
        return {
          refusal: {
            ok: false,
            status: 404,
            reason: `not found: ${JSON.stringify(requestPath)} does not exist under the served root (no real path to verify, so it is not served from a lexical guess)`,
          },
        };
      }
      return {
        refusal: {
          ok: false,
          status: 403,
          reason: `refusing to serve ${JSON.stringify(requestPath)}: its real path cannot be resolved (${code})`,
        },
      };
    }
  };

  const first = resolveTarget(lexical);
  if (first.refusal) return first.refusal;

  let real = first.real;
  if (real !== realpath(root) && !insideOf(realRoot, real)) {
    return {
      ok: false,
      status: 403,
      reason: `refusing to serve ${JSON.stringify(requestPath)}: it resolves through a symlink to ${real}, which is outside the served root ${realRoot}`,
    };
  }

  let stats = null;
  try {
    stats = fs.statSync(real);
  } catch {
    stats = null;
  }
  if (stats && stats.isDirectory()) {
    const indexPath = path.join(real, 'index.html');
    const second = resolveTarget(indexPath);
    if (second.refusal) return second.refusal;
    if (second.real !== realRoot && !insideOf(realRoot, second.real)) {
      return {
        ok: false,
        status: 403,
        reason: `refusing to serve ${JSON.stringify(requestPath)}: its index.html resolves to ${second.real}, which is outside the served root ${realRoot}`,
      };
    }
    real = second.real;
  }

  return { ok: true, filePath: real };
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
