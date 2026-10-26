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

const [version, commit] = await Promise.all([resolveVersion(), resolveCommit()]);
const BUILD_TIMESTAMP = envOpt("BUILD_TIMESTAMP") ?? new Date().toISOString();

const HEALTH_BODY = JSON.stringify({ status: "ok", version, commit, buildTimestamp: BUILD_TIMESTAMP });
const HEALTH_HEADERS = { "content-type": "application/json; charset=utf-8" };

function handler(req: Request): Response | Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === "/health") {
    if (req.method === "GET") return new Response(HEALTH_BODY, { headers: HEALTH_HEADERS });
    if (req.method === "HEAD") return new Response(null, { headers: HEALTH_HEADERS });
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...HEALTH_HEADERS, allow: "GET, HEAD" },
    });
  }
  return serveDir(req, { fsRoot: "dist" });
}

const server = Deno.serve({ port: readPort() }, handler);
console.log(`airhorner: serving dist/ on http://${server.addr.hostname}:${server.addr.port}`);
