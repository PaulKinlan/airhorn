import { serveDir } from "jsr:@std/http@^1.0.25/file-server";

// GET /health (airhorn-uexx) — a fast, unauthenticated build report.
//
// Everything it returns is resolved ONCE, at startup: no git call, file read or
// env lookup happens per request, and the body is serialized a single time, so
// the route costs one string write under load.
//
// Each value has a build/deploy-time override (set these when you build or
// upload dist/, e.g. from CI — see docs/runbooks/DEPLOY.md) and a run-time fallback:
//
//   version        APP_VERSION      -> package.json's "version" -> "unknown"
//   commit         GIT_COMMIT       -> `git rev-parse --short HEAD`, once
//                  (or COMMIT_SHA)     (needs --allow-run=git)     -> "unknown"
//   buildTimestamp BUILD_TIMESTAMP  -> this server's start time (ISO-8601)
//
// "unknown" is a truthful value, never an error: a deployment that ships only
// dist/ has no package.json and no .git, and the endpoint must still answer.

const ROOT = import.meta.dirname!;

/** Read one env var without ever prompting: undefined unless already granted. */
function envOpt(name: string): string | undefined {
  try {
    if (Deno.permissions.querySync({ name: "env", variable: name }).state !== "granted") {
      return undefined;
    }
    const value = Deno.env.get(name);
    return value && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function resolveVersion(): Promise<string> {
  const fromEnv = envOpt("APP_VERSION");
  if (fromEnv) return fromEnv;
  try {
    const pkgPath = `${ROOT}/package.json`;
    if (Deno.permissions.querySync({ name: "read", path: pkgPath }).state !== "granted") {
      return "unknown";
    }
    const pkg = JSON.parse(await Deno.readTextFile(pkgPath));
    if (typeof pkg?.version === "string" && pkg.version) return pkg.version;
  } catch {
    // Shipped without package.json, or unreadable — fall through.
  }
  return "unknown";
}

async function resolveCommit(): Promise<string> {
  const fromEnv = envOpt("GIT_COMMIT") ?? envOpt("COMMIT_SHA");
  if (fromEnv) return fromEnv;
  try {
    if (Deno.permissions.querySync({ name: "run", command: "git" }).state !== "granted") {
      return "unknown";
    }
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--short", "HEAD"],
      cwd: ROOT,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    });
    const out = await cmd.output();
    if (out.success) {
      const sha = new TextDecoder().decode(out.stdout).trim();
      if (sha) return sha;
    }
  } catch {
    // No git binary, not a checkout, or --allow-run=git not granted.
  }
  return "unknown";
}

/** PORT env override for the listener; default 8000 as documented. */
function readPort(): number {
  const raw = envOpt("PORT");
  if (raw === undefined) return 8000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`airhorner: PORT must be an integer 0-65535, got "${raw}"`);
  }
  return port;
}

/** HOST env override for the bound interface; LOOPBACK by default (airhorn-bs19).
 *
 * The server used to pass no hostname, so Deno bound 0.0.0.0 and every self-hosted
 * preview became a LAN/public listener by accident. Loopback is the honest default for
 * the documented "serve dist and look at it" recipe; a real deployment opts in with
 * HOST=0.0.0.0 and a matching --allow-net grant, which the runbooks say out loud. */
function readHostname(): string {
  return envOpt("HOST") ?? "127.0.0.1";
}

/* The response headers public/_headers ships for the Pages origin (airhorn-kv7m), applied
 * to THIS server too (airhorn-bs19): it is the documented self-host origin, and it served
 * dist/ with none of them. The values are deliberately identical to public/_headers -
 * tests/health.test.mjs compares the served responses against that file, so the two cannot
 * drift apart.
 *
 * The CSP is deliberately NOT here, exactly as it is not in _headers: index.html carries two
 * deliberate inline scripts (the boot watchdog and the SW registration) plus an inline
 * critical stylesheet, so script-src 'self' would break the boot. It arrives with
 * airhorn-xnd1, and the parity test will demand it here on the same day it lands there. */
const POLICY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "geolocation=(), camera=(), microphone=(), payment=(), usb=()",
  "x-frame-options": "DENY",
};

const [version, commit] = await Promise.all([resolveVersion(), resolveCommit()]);
const BUILD_TIMESTAMP = envOpt("BUILD_TIMESTAMP") ?? new Date().toISOString();

const HEALTH_BODY = JSON.stringify({ status: "ok", version, commit, buildTimestamp: BUILD_TIMESTAMP });
const HEALTH_HEADERS = { "content-type": "application/json; charset=utf-8", ...POLICY_HEADERS };
// The length GET sends, derived from the body rather than written down twice, so
// the HEAD below cannot drift from it (airhorn-ld31).
const HEALTH_BODY_BYTES = new TextEncoder().encode(HEALTH_BODY).byteLength;

function handler(req: Request): Response | Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === "/health") {
    if (req.method === "GET") return new Response(HEALTH_BODY, { headers: HEALTH_HEADERS });
    // RFC 9110 9.3.2: a HEAD response carries the header fields GET would send,
    // including content-length. Deno fills in content-length: 0 for a null body,
    // which asserts an empty entity for the one endpoint whose body is the whole
    // point - so it is stated here explicitly (airhorn-ld31).
    if (req.method === "HEAD") {
      return new Response(null, { headers: { ...HEALTH_HEADERS, "content-length": String(HEALTH_BODY_BYTES) } });
    }
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...HEALTH_HEADERS, allow: "GET, HEAD" },
    });
  }
  return serveDist(req);
}

/** Serve dist/ under the same policy headers as /health and the Pages origin.
 *
 * `serveDir` builds the Response (status, content-type, ranges, 304s), so its body and status
 * are kept verbatim and only the policy headers are added on a copy of its headers. Rebuilding
 * the Response is deliberate: mutating the headers of a Response built by the file server is
 * not a contract we own, and this way a 304/204 keeps its empty body. */
async function serveDist(req: Request): Promise<Response> {
  const served = await serveDir(req, { fsRoot: "dist" });
  const headers = new Headers(served.headers);
  for (const [name, value] of Object.entries(POLICY_HEADERS)) headers.set(name, value);
  return new Response(served.body, { status: served.status, statusText: served.statusText, headers });
}

const server = Deno.serve({ port: readPort(), hostname: readHostname() }, handler);
console.log(`airhorner: serving dist/ on http://${server.addr.hostname}:${server.addr.port}`);
