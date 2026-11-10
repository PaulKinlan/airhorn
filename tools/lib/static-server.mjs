/*
 * tools/lib/static-server.mjs — the ONE static server the suites share
 * (airhorn-yxxq). The browser harness learned this lesson first: eight copies
 * of a launcher drifted until the path was shared (tools/lib/chrome.mjs). The
 * static server had the same shape - 27 http.createServer sites across 14
 * files, twelve of them serving dist/ by hand - and the cost was not tidiness:
 * no suite applied public/_headers, so the entire security-header policy was
 * pinned as TEXT (tests/pages-config.test.js), never as a served response. A
 * header that breaks the boot could not fail a test. Now it can.
 *
 * serveDist({ dir, headers, route, extraHeaders }):
 *   dir          - the directory to serve (usually dist/).
 *   headers      - 'none' (default): no policy headers.
 *                  'auto': parse the Pages subset of <dir>/_headers (the built
 *                          copy) and apply it to EVERY response, the way
 *                          Cloudflare Pages does. The subset we use: comment
 *                          lines (#), blank lines, and ONE /* block of
 *                          `Key: value` lines. Anything else REFUSES by name -
 *                          silently ignoring a rule would re-open exactly the
 *                          hole this module exists to close.
 *                  object: applied verbatim ({ Key: value }).
 *   route        - optional hook consulted BEFORE the file lookup:
 *                  route(pathname, req) returns
 *                    undefined              -> default dist serving
 *                    { body, contentType?, headers? } -> custom response
 *                    { destroy: true }      -> kill the connection (offline sim)
 *                    { hang: ms }           -> never respond; destroy after ms (lie-fi)
 *   extraHeaders - headers added to every DEFAULT response (the SW suites serve
 *                  'Service-Worker-Allowed': '/' this way).
 *
 * WHAT THIS IS NOT (so nobody mistakes it for Pages): it does not emulate Pages
 * routing (no redirects, no SPA fallback beyond directory index.html, no
 * _redirects file), Pages caching semantics (everything is no-store here),
 * Pages' real 404 page handling, or any header beyond what the _headers subset
 * above declares. It answers one question: does the page work when the declared
 * headers are on the wire.
 *
 * Every response is no-store; MIME by extension; path traversal and directory
 * requests refuse with 404. Returns { server, port, close() }.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
};

/* Parse the Pages _headers subset we actually use. Returns { Key: value }.
 * Throws, naming the line, on anything outside the subset - a rule the parser
 * does not understand is a rule a test silently runs WITHOUT, which is the
 * failure class this module exists to remove (airhorn-yxxq). */
export function parsePagesHeaders(text) {
  const out = {};
  let inBlock = false;
  let seenBlock = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!inBlock) {
      if (line === '/*') {
        if (seenBlock) throw new Error(`_headers: a second path block is outside the supported subset: ${raw}`);
        inBlock = true;
        seenBlock = true;
        continue;
      }
      throw new Error(`_headers: only a /* path block is supported (Pages semantics need real paths otherwise); got: ${raw}`);
    }
    const m = line.match(/^([A-Za-z-]+):\s+(.+)$/);
    if (!m) throw new Error(`_headers: expected 'Key: value' inside the /* block, got: ${raw}`);
    out[m[1]] = m[2];
  }
  return out;
}

export function serveDist({ dir, headers = 'none', route = null, extraHeaders = {} } = {}) {
  if (!dir) throw new Error('serveDist: dir is required');
  const root = path.resolve(dir);
  let policy = {};
  if (headers === 'auto') {
    const file = path.join(root, '_headers');
    policy = parsePagesHeaders(fs.readFileSync(file, 'utf8'));
  } else if (headers && typeof headers === 'object') {
    policy = headers;
  }
  const server = http.createServer((req, res) => {
    const pathname = req.url.split('?')[0];
    if (route) {
      const r = route(pathname, req);
      if (r && r.destroy) { req.destroy(); return; }
      if (r && r.hang) {
        // lie-fi: respond never, destroy after the delay (a bounded stall).
        const timer = setTimeout(() => res.destroy(), r.hang);
        req.on('close', () => clearTimeout(timer));
        return;
      }
      if (r && 'body' in r) {
        res.writeHead(200, {
          'content-type': r.contentType || 'application/octet-stream',
          'cache-control': 'no-store',
          ...policy, ...(r.headers || {}),
        });
        res.end(r.body);
        return;
      }
    }
    const rel = pathname === '/' ? '/index.html' : pathname;
    let file = path.join(root, rel);
    // Pages serves index.html for directory paths; do the same.
    if (file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      file = path.join(file, 'index.html');
    }
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      ...policy, ...extraHeaders,
    });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}
