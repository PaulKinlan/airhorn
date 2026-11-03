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

/* ------------------------------------------------------------------ opening ---- */

/*
 * OPEN FIRST, THEN DECIDE (airhorn-dklf).
 *
 * resolveWithinRoot above answers "is this NAME inside the root?", and that answer is stale
 * the moment it is given: between the realpath and the caller's createReadStream, the name
 * can be re-pointed at a file outside the root, and the read follows the new target. The
 * window is not theoretical - it is the difference between deciding on a name and deciding
 * on a handle.
 *
 * openWithinRoot closes it by inverting the order:
 *   1. open the target (fs.openSync, O_RDONLY) - following symlinks, so the served tree keeps
 *      working exactly as measured;
 *   2. ask the OPENED DESCRIPTOR where it actually lives:
 *      fs.realpathSync('/proc/self/fd/<fd>'). That path describes the same inode the response
 *      will read, so re-pointing the name afterwards cannot redirect the read, and a file
 *      unlinked after the open still serves the verified bytes (the kernel appends
 *      " (deleted)", which is stripped before comparing);
 *   3. require that path inside the realpath'd root, else close the handle and refuse;
 *   4. hand back the fd and its size, so the caller streams the descriptor it verified.
 *
 * The lexical check is still done FIRST (resolveWithinRoot), because it keeps the '..' and
 * sibling-prefix answers identical to the behaviour already measured - this function only
 * changes WHEN the file answer is trusted, not what is refused.
 */
export function openWithinRoot(root, requestPath, { realpath = fs.realpathSync.bind(fs), afterResolve = null } = {}) {
  const contained = resolveWithinRoot(root, requestPath, { realpath });
  if (!contained.ok) return contained;

  // Test seam ONLY: runs in the interval the old ordering left open (after the name was
  // verified, before it is opened), so a probe can prove the window is closed rather than
  // hope to win a race. Never passed by a tool.
  if (afterResolve) afterResolve(contained.filePath);

  let fd;
  try {
    fd = fs.openSync(contained.filePath, 'r');
  } catch (error) {
    const code = (error && error.code) || 'unknown';
    if (code === 'ELOOP') {
      return { ok: false, status: 403, reason: `refusing to serve ${JSON.stringify(requestPath)}: ${contained.filePath} is a symlink loop (ELOOP)` };
    }
    if (code === 'ENOENT') {
      return { ok: false, status: 404, reason: `not found: ${JSON.stringify(requestPath)} has no handle to verify under the served root` };
    }
    return { ok: false, status: 403, reason: `refusing to serve ${JSON.stringify(requestPath)}: cannot open ${contained.filePath} (${code})` };
  }

  let realRoot;
  try {
    realRoot = realpath(root);
  } catch {
    fs.closeSync(fd);
    return { ok: false, status: 403, reason: `refusing to serve ${JSON.stringify(requestPath)}: the served root ${root} cannot be resolved` };
  }

  const handlePath = pathOfHandle(fd);
  const decided = handlePath
    ? stripDeleted(handlePath)
    : contained.filePath;
  if (!insideOf(realRoot, decided)) {
    fs.closeSync(fd);
    return {
      ok: false,
      status: 403,
      reason: `refusing to serve ${JSON.stringify(requestPath)}: the OPENED file lives at ${decided}, which is outside the served root ${realRoot}`,
    };
  }

  let stats;
  try {
    stats = fs.fstatSync(fd);
  } catch {
    fs.closeSync(fd);
    return { ok: false, status: 403, reason: `refusing to serve ${JSON.stringify(requestPath)}: the opened handle cannot be stat'ed` };
  }

  return { ok: true, fd, realPath: decided, filePath: decided, size: stats.size, pathname: requestPath };
}

/** '/tmp/x (deleted)' -> '/tmp/x': the handle still is the verified file. */
const stripDeleted = (handlePath) =>
  handlePath.endsWith(' (deleted)') ? handlePath.slice(0, -' (deleted)'.length) : handlePath;

function pathOfHandle(fd) {
  try {
    return fs.realpathSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

/**
 * The whole request in one call for a handler that streams a descriptor:
 * decode, contain, open, verify the handle. `ok:false` carries status + named reason;
 * `ok:true` carries `fd` (close it by streaming it) and `size`.
 */
export function openRequestUrl(root, rawUrl, options) {
  const decoded = decodeRequestPath(rawUrl);
  if (!decoded.ok) return decoded;
  return openWithinRoot(root, decoded.pathname, options);
}
