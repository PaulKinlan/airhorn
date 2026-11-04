# Supply chain: dependencies and advisories

Airhorn ships **no production dependencies**. Everything the browser runs is source in this repo, bundled by
Vite at build time; `vite` is the only devDependency and none of it is in the shipped bytes.

Recorded for airhorn-dntz (factory `deps-supply-chain` audit, 2026-11-03) so the next audit can be answered
from the repo instead of re-triaged from scratch.

## What is installed

    $ python3 -c 'import json;p=json.load(open("package.json"));print(p.get("dependencies"), list(p.get("devDependencies",{})))'
    None ['vite']

`vite@6.4.1` is build-time only: `npm run build` writes `dist/`, and `dist/` is what is served.

## Measured on 2026-11-04 (master e45d069)

    $ npm audit --omit=dev
    prod vulnerabilities: info 0, low 0, moderate 0, high 0, critical 0, total 0

    $ grep -l vite dist/assets/*.js        # after `npx vite build`
    (no output - no Vite runtime in the bundle)

    $ npm audit                            # dev tree, five high advisories, all in the Vite toolchain
    vite            direct devDependency   <=6.4.3   path traversal in optimized-deps .map handling;
                                                     arbitrary file read via the dev-server WebSocket
    nanoid          via vite               <=3.3.17  non-secure generators can loop on negative/zero size
    picomatch       via vite               4.0.0-4.0.3  method injection in POSIX classes; ReDoS via extglob
    postcss         via vite               <=8.5.22  XSS in CSS stringify; file read via sourceMappingURL
    source-map-js   via vite               1.0.0-1.2.1  event-loop DoS through indexed section offsets

## Decision: wontfix, revisit at the next routine dependency bump

Why not now:

- **Nothing is reachable from the shipped app.** There are no production dependencies, and `dist/` contains no
  Vite code, so the vulnerable code paths are the local dev server and the build-time CSS/glob/source-map
  processing - they run on a developer machine or in CI, on inputs from this repo, not on visitor input.
- **The Vite advisories are dev-server issues** (path traversal and file read through the dev server). The dev
  server is bound to loopback and is not part of any deployed artefact.
- **The transitive advisories reach us only through the Vite toolchain**, so they are fixed by the same bump.

Why not "just bump tonight": the lockfile keys this fleet's shared `node_modules` store, so a bump rebuilds it
for every lane on the VM, and it is a routine maintenance change rather than a security fix for anything we
serve. Do it as its own change with a full gate, not folded into unrelated work.

## How to re-check (any of these getting worse reverses the decision)

    npm audit --omit=dev                     # any non-zero count here is a production problem
    npm ls --omit=dev --all                  # must stay empty
    grep -rlE "createServer|vite:client" dist/   # must stay empty after a build

If a future change adds a runtime dependency, or if `dist/` starts carrying Vite code, this record is void: the
advisories then apply to shipped bytes and the bump becomes mandatory.
