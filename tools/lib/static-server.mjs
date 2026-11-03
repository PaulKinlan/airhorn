/*
 * tools/lib/static-server.mjs — the one static server the dev tools use for dist/.
 *
 * Three factory findings, all the same subject: an untrusted request path turned into a
 * file by hand, in four tools, with no shared answer (airhorn-k0xp, -dklf, -k77v, -m2hi).
 *
 *   • an unguarded decodeURIComponent threw URIError out of a request handler and killed the
 *     run (install-https-proof, soak);
 *   • path.join followed '..' out of the root, and two tools never decoded at all, so %2e%2e
 *     went straight through (idle-cost, measure-perf);
 *   • a LEXICAL containment check - even a separator-aware one - is bypassed by a symlink
 *     that lives INSIDE the root and points outside it: the request path is contained, the
 *     file is not (the reviewer's /linked.txt reproduction);
 *   • resolve-then-open leaves a TOCTOU window: the path can be swapped between the check
 *     and the read (airhorn-dklf).
 *
 * So containment is decided on the OPENED FILE HANDLE, not on a name:
 *
 *   1. LEXICAL pre-check. The joined path must stay under the root, so '..' is refused even
 *      when the target does not exist, and the prefix is SEPARATOR-AWARE, so '/rooted' is
 *      not inside '/root' (the dist-evil sibling probe).
 *   2. OPEN first, following symlinks: fs.openSync(target, 'r'). A failure is a named
 *      refusal - ENOENT -> 404 "nothing to verify", ELOOP -> 403 "symlink loop (ELOOP)",
 *      anything else -> 403 naming the code.
 *   3. VERIFY THE HANDLE: fs.realpathSync('/proc/self/fd/<fd>') is the path the opened inode
 *      actually lives at, so the answer cannot be changed by swapping a symlink after the
 *      check. That path must be inside the real (realpath'd) root, or the handle is closed
 *      and the request refused, naming both paths.
 *   4. The bytes come from THAT fd (fs.createReadStream(null, { fd })), never from the name
 *      that was checked, so the file served is the file verified.
 *
 * TOCTOU: with fstat/realpath on the open descriptor, the classic window is closed - the
 * verification describes the same inode the response reads, and unlinking or re-pointing the
 * name afterwards cannot redirect the read. Residual risk, stated rather than claimed gone:
 * (a) /proc/self/fd is Linux-specific; where it is missing we keep the descriptor and compare
 * `fstat` (dev+ino) against a realpath'd stat of the target, which is verified-then-opened and
 * therefore keeps the old window for that platform; (b) if the root directory itself is moved
 * out from under the process mid-request, realpath of the fd reports the NEW location - that
 * is a change to the root, not a traversal, and an operator who moves dist/ is trusted to.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

const FD_DIR = '/proc/self/fd';

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

/** Separator-aware containment: '/rooted' is NOT inside '/root'. */
export function isInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const withSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  return candidate === resolvedRoot || candidate.startsWith(withSep);
}

/** The lexical half, exposed so a test can show that it alone is not containment. */
export function lexicalPath(root, requestPath) {
  const relative = requestPath === '/' || requestPath === '' ? 'index.html' : requestPath;
  return path.resolve(root, '.' + (relative.startsWith('/') ? relative : `/${relative}`));
}

const named = (status, reason) => ({ ok: false, status, reason });

function openNamed(target, requestPath) {
  try {
    return { ok: true, fd: fs.openSync(target, 'r'), target };
  } catch (error) {
    const code = (error && error.code) || 'unknown';
    if (code === 'ELOOP') {
      return named(403, `refusing to serve ${JSON.stringify(requestPath)}: ${target} is a symlink loop (ELOOP) - it can never be contained, so it is refused as a loop rather than reported as missing`);
    }
    if (code === 'ENOENT') {
      return named(404, `not found: ${JSON.stringify(requestPath)} does not exist under the served root - there is no handle to verify, so nothing is served from a lexical guess`);
    }
    if (code === 'EISDIR') {
      return { ok: true, fd: null, target, isDirectory: true };
    }
    return named(403, `refusing to serve ${JSON.stringify(requestPath)}: ${target} cannot be opened (${code})`);
  }
}

/** The path the OPENED inode lives at, or null when this platform cannot say. */
function pathOfHandle(fd) {
  try {
    return fs.realpathSync(`${FD_DIR}/${fd}`);
  } catch {
    return null;
  }
}

/**
 * Open `requestPath` under `root` and prove the opened handle is inside the root.
 * Returns { ok: true, fd, realPath, size } or { ok: false, status, reason }.
 */
export function openWithinRoot(root, requestPath) {
  const lexical = lexicalPath(root, requestPath);
  if (!isInside(root, lexical)) {
    return named(403, `refusing to serve ${JSON.stringify(requestPath)}: it resolves to ${lexical}, which is outside the served root ${root}`);
  }

  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return named(403, `refusing to serve ${JSON.stringify(requestPath)}: the served root ${root} cannot be resolved`);
  }

  let target = lexical;
  // A directory is answered by its index.html. Resolve that through the DIRECTORY'S handle
  // first, so a symlinked directory cannot be used to reach a page outside the root.
  const first = openNamed(target, requestPath);
  if (!first.ok) return first;

  if (first.fd === null || (first.fd !== null && statIsDirectory(first.fd))) {
    if (first.fd !== null) fs.closeSync(first.fd);
    const dirReal = pathOfHandleOrTarget(target);
    if (dirReal && !isInside(realRoot, dirReal)) {
      return named(403, `refusing to serve ${JSON.stringify(requestPath)}: the directory resolves to ${dirReal}, which is outside the served root ${realRoot}`);
    }
    target = path.join(dirReal || target, 'index.html');
    if (!isInside(realRoot, target)) {
      return named(403, `refusing to serve ${JSON.stringify(requestPath)}: its index.html would be ${target}, outside the served root ${realRoot}`);
    }
    const second = openNamed(target, requestPath);
    if (!second.ok) return second;
    if (second.fd === null) return named(403, `refusing to serve ${JSON.stringify(requestPath)}: index.html is itself a directory`);
    return verify(second.fd, target, requestPath, realRoot);
  }

  return verify(first.fd, target, requestPath, realRoot);
}

function statIsDirectory(fd) {
  try {
    return fs.fstatSync(fd).isDirectory();
  } catch {
    return false;
  }
}

function pathOfHandleOrTarget(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function verify(fd, target, requestPath, realRoot) {
  const handlePath = pathOfHandle(fd);
  const checked = handlePath || pathOfHandleOrTarget(target);

  if (handlePath) {
    // realpath of /proc/self/fd appends this when the file was unlinked after open: compare
    // the path it LIVED at, because the handle is still the verified file.
    const comparable = handlePath.endsWith(' (deleted)') ? handlePath.slice(0, -' (deleted)'.length) : handlePath;
    if (!isInside(realRoot, comparable)) {
      fs.closeSync(fd);
      return named(403, `refusing to serve ${JSON.stringify(requestPath)}: the OPENED file lives at ${comparable}, which is outside the served root ${realRoot}`);
    }
  } else if (!checked || !isInside(realRoot, checked)) {
    fs.closeSync(fd);
    return named(403, `refusing to serve ${JSON.stringify(requestPath)}: this platform cannot report the opened path, and ${checked || target} could not be proven inside the served root ${realRoot}`);
  }

  let stats;
  try {
    stats = fs.fstatSync(fd);
  } catch {
    fs.closeSync(fd);
    return named(403, `refusing to serve ${JSON.stringify(requestPath)}: the opened handle cannot be stat'ed`);
  }

  return { ok: true, fd, realPath: checked || target, size: stats.size, target };
}

/**
 * A static-file server over `root`, used by every tool that serves dist/. `onRequest` may
 * answer first (soak intercepts /sw.js and the unpublished case) and returns true when it
 * has taken the response.
 */
export function createStaticServer({ root, mimeTypes = {}, tls = null, headers = {}, onRequest = null }) {
  const handler = (req, res) => {
    if (onRequest && onRequest(req, res) === true) return;

    const decoded = decodeRequestPath(req.url);
    if (!decoded.ok) {
      res.writeHead(decoded.status, { 'Content-Type': 'text/plain' });
      res.end(decoded.reason);
      return;
    }

    const opened = openWithinRoot(root, decoded.pathname);
    if (!opened.ok) {
      res.writeHead(opened.status, { 'Content-Type': 'text/plain' });
      res.end(opened.reason);
      return;
    }

    const ext = path.extname(opened.realPath);
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Content-Length': opened.size,
      ...headers,
    });
    // The bytes come from the verified HANDLE, not from the checked name.
    const stream = fs.createReadStream(null, { fd: opened.fd });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  };

  return tls ? https.createServer(tls, handler) : http.createServer(handler);
}

/** Listen on loopback with an ephemeral port; resolves with the server. */
export function listenLoopback(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
