# The Air Horner

A single-page air horn for the web, at [airhorner.com](https://airhorner.com/).
Press the horn and it sounds; hold it and it keeps sounding; let go and the sample
rings out. It installs as an app, works offline, and exposes its horn to in-page AI
agents through WebMCP.

The app is one button, one sound and no framework: plain ES modules, the Web Audio
API and a service worker, built with Vite.

## Using it

- **Pointer**: press and hold the horn to sound it, release to stop.
- **Keyboard**: `Tab` to the horn, then hold `Space` or `Enter`. The horn is a real
  `<button>`; `aria-pressed` follows the sound, focus draws a visible ring, and the
  press-and-hold instruction is exposed to assistive tech via `aria-describedby`.
- **Install**: the Install button appears when the browser offers the install
  prompt; it disappears again once the app is installed.
- **`/#instant`**: sounds one blast on load (also the manifest's *Instant Blast*
  shortcut).
- The app badge counts your blasts (where `setAppBadge` is supported), and the horn
  stops when the tab is hidden.
- **Colour scheme**: the page declares `color-scheme: light dark` and has a dark
  palette (design tokens switched with `light-dark()` where the browser supports it).
- **Reduced motion**: with `prefers-reduced-motion: reduce`, the pressed horn keeps its
  animations off and shows a static lit rim and deeper red instead.

## Building and running

Requires Node 20 or newer (developed on Node 24).

```bash
npm install
npm run dev       # Vite dev server with live reload
npm run build     # writes the deployment build to dist/
npm run preview   # serves dist/ locally
```

`dist/` is plain static files. Serve it from the root of an origin — the service
worker's scope is `/` — with any static file server, for example
`npx serve dist`, or the Deno server in `server.ts`:

```bash
deno run --allow-net --allow-read --allow-env --allow-run=git server.ts

PORT=9000 deno run --allow-net --allow-read --allow-env --allow-run=git server.ts
```

The first line serves `dist/` on port 8000; the second moves the listener, which
matters on hosts where 8000 is taken. Each flag earns its place, and leaving one out
changes what you get rather than failing loudly:

| Flag | What it buys | Left out |
| --- | --- | --- |
| `--allow-net` | the listener itself | nothing to connect to |
| `--allow-read` | `dist/`, and `package.json`'s `version` | no app; `version` is `"unknown"` |
| `--allow-env` | `PORT` and the build stamps | `PORT` is **ignored** — it still listens on 8000 |
| `--allow-run=git` | `commit`, read from this checkout | `commit` is `"unknown"` |

`"unknown"` is a truthful answer, not an error — a host that ships only `dist/` has
no `.git` to ask. Where you would rather not grant the flag, stamp the value at build
time instead: [DEPLOY.md](DEPLOY.md) sets `APP_VERSION`, `GIT_COMMIT` and
`BUILD_TIMESTAMP` and runs without `--allow-run=git`.

The server also exposes **`GET /health`**: unauthenticated JSON describing the
running build — `{"status":"ok","version":"2.0.0","commit":"<short sha>",
"buildTimestamp":"<ISO-8601>"}`. Each value is resolved once at startup with a
build/deploy-time override and a safe fallback (`APP_VERSION` → package.json →
`"unknown"`; `GIT_COMMIT` → one `git rev-parse --short HEAD` → `"unknown"`;
`BUILD_TIMESTAMP` → server start time), so the route never blocks and never errors;
`curl -s localhost:8000/health` is the one-line proof of a deployment.
`tests/health.test.mjs` pins the contract.

## Offline and updates

`public/sw.js` precaches `/`, `/index.html`, `/styles/main.css` and
`/sounds/airhorn.mp3`. Both shell spellings are deliberate: `/` is what a
navigation matches, and storing a navigation response is also how an emptied cache
re-seeds itself from one online visit (a device whose caches were wiped recovers by
loading the page — `tests/sw-failover.test.mjs` stage D pins that); `/index.html` is
what an in-page fetch and the worker's navigation fallback ask for. At build time a
Vite plugin appends every hashed `/assets/*.js` referenced by the built `index.html`
to that list, and stamps the cache name with a hash of the whole build, so a new
deployment gets a new cache and the previous one is deleted on activate.

A new worker calls `skipWaiting()`. When the page already had a controller, the
`controllerchange` handler reloads once so the tab is running the new build. After
the first load the app renders from the cache, and an offline reload still shows the
horn and still plays it.

## WebMCP tools

On load the app registers three tools on `document.modelContext`, so an in-page
agent can use the horn through the same code path a person does (button state, app
badge and analytics all stay correct):

| Tool | What it does |
| --- | --- |
| `play_horn({ loop })` | Sounds the horn; `loop: true` keeps it going until `stop_horn` |
| `stop_horn()` | Silences it immediately |
| `get_horn_state()` | Reports `playing`, `loop` and `hasAudioContext` |

A call resolves to a result or a structured refusal (`{ playing, loop, code, error }`) —
never an unhandled rejection — and bad input is refused rather than guessed at. The
full contract (schemas, result and error shapes, annotations, rate limits, the loop
seam between "one horn" and "always silence") is [docs/webmcp-tools.md](docs/webmcp-tools.md).

Registration is a no-op in browsers without WebMCP, and a registration failure can
never break the horn itself. The API is behind a flag in current Chrome:

```bash
google-chrome --enable-features=WebMCP,WebMCPTesting https://airhorner.com/
# then, from the page or DevTools:
#   const [tool] = (await document.modelContext.getTools()).filter(t => t.name === 'play_horn');
#   await document.modelContext.executeTool(tool, {});
```

## Tests

```bash
npm test                  # build, then every suite below
npm run test:acceptance   # whole-product pass in one real browser
```

`npm test` builds `dist/`, then runs every `tests/**/*.test.{js,mjs}` suite with
`node --test --test-concurrency=1`:

- `tests/horn.test.js` — the `Horn` audio class (buffer loading, loop and stop, the
  synthesised fallback) against fake browser globals, with no browser or audio device;
- `tests/webmcp.test.mjs` — the tool definitions and their wiring;
- `tests/webmcp-fuzz.test.mjs` — hostile callers: wrong types, huge payloads, floods,
  cancellation, and that the tools never stack audio or leak an `AudioContext`;
- `tests/a11y.test.mjs` — accessibility tree, keyboard operation, focus ring;
- `tests/sw-offline.test.mjs` — manifest, service worker activation and offline
  reload;
- `tests/webmcp-browser.test.mjs` — the tools driven end to end in a browser;
- `tests/shortcuts.test.mjs` — the manifest's `/#instant` shortcut: it blasts, keeps a
  shareable URL, survives offline, and an unknown hash or a navigation after it leaves
  the horn at rest (also checks that a blocked-autoplay tab does not claim to play).

The last three launch headless Chromium against the built `dist/`, and finish by
waiting for the page to go quiet — no outstanding timers, intervals or fetches — before
asserting that nothing threw, rather than sleeping for a fixed window.

`npm run test:acceptance` is the whole-product pass: one browser session that presses
the horn with the pointer, works it from the keyboard, installs and reloads it
offline, calls the WebMCP tools, and renders it under reduced-motion and dark-mode
preferences — screenshotting each step and writing `report.json` plus a PASS/FAIL
summary to `/tmp/airhorn-acceptance/<git-sha>-<timestamp>/` (override with
`ACCEPTANCE_OUT`). It exits non-zero if any item fails, so it can be used as a gate.
It is deliberately not part of `npm test`: it launches its own browser and is slower
than the focused suites.

Both commands launch the browser found via `CHROME_BIN`, falling back to
`google-chrome`, `chromium` or `chromium-browser`.

### Long-session soak

Every suite above proves a moment; `tools/soak.mjs` proves a session. It drives the
built app through 240 start/stop cycles (WebMCP tools, pointer press-and-hold with the
sample ringing out, keyboard `Space`, and `/#instant`), publishes three
service-worker versions over the live controller, and toggles offline/online four
times — then measures what the page is *holding* rather than what it printed:

```bash
npm run build && node tools/soak.mjs        # 240 cycles, ~2.5 min
```

After a forced GC at every sample it reads the retained heap (V8 heap **plus**
typed-array backing stores, which is where a leaked `AudioBuffer` lives), counts live
`AudioBufferSourceNode`/`OscillatorNode` instances and `AudioContext`s still reachable
in the heap, and takes the renderer's live node, document and JS-event-listener
counts. It also asserts the page drains to zero timers/intervals/fetches between
cycles, that each worker update replaces its caches and reloads the page once, and
that an offline reload still renders and still plays. `report.json` and a screenshot
land in `/tmp/airhorn-soak/<git-sha>-<timestamp>/` (override with `--out` or
`SOAK_OUT`); it exits non-zero when any check fails.

Like the acceptance pass it is explicit-only — a soak is minutes long and has no
business in the fast gate.

None of that is worth anything if it cannot fail, so the harness ships with injectable
leaks it is expected to catch (`--mutant source-leak|listener-leak|heap-leak`): the
page retains every buffer source it starts, or adds a document listener per blast, or
keeps 1 MB per blast. Run one and the matching check goes red:

```bash
node tools/soak.mjs --cycles 24 --updates 0 --offline 0 --mutant source-leak
```

### Storage growth across deploys

The worker precaches under a cache name stamped with the build, and every deploy ships
a new hashed bundle — the shape that grows without bound on a device that comes back
after a few releases. `tools/cache-growth.mjs` installs ten successive builds into one
browser profile (each with its own hashed asset and content, rewritten in `index.html`
and the worker's precache list) and, per version, reads back the cache names, the
entries and stored bytes of every cache, and `navigator.storage.estimate()`:

```bash
npm run build && node tools/cache-growth.mjs      # 10 deploys, ~25 s
```

It asserts that each deploy leaves exactly the current version's two caches (the
precache and its integrity records), that both caches hold exactly the paths the worker
declares (compared as sets, not counts — `--self-check` proves a same-count substitution
is rejected), that stored bytes and origin usage stay flat rather than stepping up by
one build per deploy, that nothing from the previous deploy — or two deploys ago —
survives, that an old hashed asset is neither readable from cache nor still served by
the origin, and that the horn still plays under each new worker. `--mutant keep-old-caches` serves a
worker whose activate handler deletes nothing, and those growth checks must go red.

### How suites report to the gate

`tools/fast-gate.sh` runs two tiers, and both put *per-case* results in its summary:

- **node:test tier** (`tests/*.test.js`) runs under `node --test --test-reporter=tap`, so
the gate prints `node:test pass=N fail=M` and names any `not ok` case.
- **script tier** (`tests/*.test.mjs`) runs directly under a preload,
`tests/support/report-hook.mjs`, which records the suite's own narration as timed steps
and writes `$AIRHORN_RESULTS_DIR/<suite>.json` (default `/tmp/airhorn-test-results/`).
The gate then prints `status`, event count, duration and, on failure, the last step the
suite reached plus the cause — so a red suite says *where* it went red, not just *that*
it did.

No suite has to change for that: the hook reads what it already prints. To name cases
explicitly, a suite can emit a marker line (`console.log('##case## <name>')`), which is
counted as a named case; `ok - <name>` / `not ok - <name>` lines are recognised the same
way. A suite that dies before reporting is shown as `no result` and still fails the gate.

## Evidence and limitations

All automated test passes and performance numbers in this repository were produced
by a synthetic harness on a single Linux VM running Chromium.

See [EVIDENCE-LIMITS.md](EVIDENCE-LIMITS.md) for a blunt inventory of what our
evidence does not cover (zero WebKit/Safari or Gecko verification, synthetic
`AnalyserNode` probes instead of human ears, self-signed local certs instead of public
HTTPS, performance measured by emulated mobile throttling or by an unthrottled desktop
headless harness rather than on a phone, WebMCP flags, and artificial test shims), what
closing each gap entails, and what it costs.

[PHONE-CHECK.md](PHONE-CHECK.md) is the same gaps as a two-minute checklist you can run
on a real phone (Android Chrome, iOS Safari), with the exact pass/fail observable for
each step - useful, because our evidence is only ever a headless Chromium on a Linux VM.

## Known gaps

- In the light scheme the red horn on the blue background is 1.18:1, below the 3:1
  non-text contrast threshold in WCAG 1.4.11. The dark scheme is 3.76:1, so the light
  palette is the one that needs attention.

## License

Copyright 2015 Google, Inc.

Licensed to the Apache Software Foundation (ASF) under one or more contributor
license agreements. See the NOTICE file distributed with this work for additional
information regarding copyright ownership. The ASF licenses this file to you under
the Apache License, Version 2.0 (the “License”); you may not use this file except in
compliance with the License. You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an “AS IS” BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the specific
language governing permissions and limitations under the License.
