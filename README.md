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
deno run --allow-net --allow-read server.ts   # serves dist/ on port 8000
```

## Offline and updates

`public/sw.js` precaches `/`, `/index.html`, `/styles/main.css` and
`/sounds/airhorn.mp3`. At build time a Vite plugin appends every hashed
`/assets/*.js` referenced by the built `index.html` to that list, and stamps the
cache name with a hash of the whole build, so a new deployment gets a new cache and
the previous one is deleted on activate.

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
- `tests/a11y.test.mjs` — accessibility tree, keyboard operation, focus ring;
- `tests/sw-offline.test.mjs` — manifest, service worker activation and offline
  reload;
- `tests/webmcp-browser.test.mjs` — the tools driven end to end in a browser.

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
