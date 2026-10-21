# DEPLOY — how to publish this build

This is the operator runbook for shipping V2, and the record of what local
verification proves. **Every command in steps 1–6 was run literally, in order,
on a Linux VM on 2026-10-20** (Node 24.22.0, npm 11.19.1, Chrome 155) — first
against `ba2cad3` to write this document, then again against `b477ddb` to
regenerate everything in `preview/` after the CLS fix
(`airhorn-qons`). The expected output quoted for each step is what actually
happened on that second run, not a sketch. Steps marked **PRODUCTION ONLY** touch DNS,
hosting or credentials, were *not* run here, and each says what you should
expect to see when you run it for real.

Read [EVIDENCE-LIMITS.md](EVIDENCE-LIMITS.md) alongside this file: it is the
full list of what the local evidence cannot prove. Once the origin is live, the
live-origin checks in Step 8 hand over to [PHONE-CHECK.md](PHONE-CHECK.md), the
two-minute real-device pass.

## What gets published

The **entire contents of `dist/`**, at the **root of an origin**. The service
worker's scope is `/` and so is the manifest's `scope`/`start_url`
(`public/manifest.json`), so it cannot be served from a subdirectory without
changing `public/sw.js` and the manifest.

Totals for the build below (from `preview/evidence.json`, `publishedTotals`):

- **26 files, 244,741 B (~245 KB) raw, 183,085 B (~183 KB) gzipped** (zlib
  level 9, decimal KB; a real host's brotli will usually do better).

| Path | Raw | Gzip |
| --- | --- | --- |
| `index.html` | 17,170 B | 5,600 B |
| `assets/index-C81EVIwm.js` — **one hashed bundle; the hash changes on every build** | 16,657 B | 5,820 B |
| `sw.js` — build-stamped by the Vite plugin in `vite.config.js` (`__BUILD_HASH__` → cache name `airhorner-2.0.0-<hash>`, plus the exact `/assets/*` list) | 9,441 B | 3,705 B |
| `manifest.json` — install metadata (name, id, standalone, 192/512 + maskable icons, screenshots, *Instant Blast* shortcut) | 2,980 B | 633 B |
| `styles/main.css` | 11,879 B | 4,023 B |
| `sounds/airhorn.mp3` | 40,858 B | 28,859 B |
| `images/**` (16 files: icons, maskable icons, manifest screenshots) | — | — |
| `favicon.ico`, `robots.txt`, `humans.txt` | — | — |
| `.well-known/assetlinks.json` — **see the warning in step 7** | 300 B | 239 B |

Those numbers are **per build** and they have gone stale in this document
twice (it once quoted a 232,215 B build whose `index.html` was 11,965 B, and the
pre-CLS-fix build was 244,049 B with a 16,478 B `index.html`). Do not copy them
into a release note: regenerate with step 4 and read `publishedTotals`. The same
applies to the bundle filename — `index-C81EVIwm.js` is this build's hash;
`sw.js` names it, and a stale name in an edge config breaks the app.

**Everything in `preview/` that this document quotes is generated**, and by the
commands below: `evidence.json` and the four `horn-*.png` screenshots by step 4,
`CWV-report.txt` by step 5, `preview/https/` (evidence json + two screenshots)
by step 6 — after `npm run build` (step 2). Two files in the directory are not
part of this runbook: `audio-parity.json`/`audio-parity.md` come from
`node tools/audio-parity.mjs --json preview/audio-parity.json`, and
`manifest-shortcuts.md` is a hand-written analysis, not a generated artefact.
If a number in this document disagrees with `preview/evidence.json`, the
document is stale — not the pack.

## Preconditions

- **Node 20 or newer** (developed on Node 24). `package.json` declares no
  `engines` field, so `npm ci` will *not* stop you on an older Node — check
  `node --version` yourself. Nothing in the build needs network access beyond
  the install.
- **npm 11** (bundled with Node 24) — that is what produced the output quoted
  below.
- **Chrome on the machine** for steps 4–6: the tools default to
  `/usr/bin/google-chrome`, override with `CHROME_BIN`. Without it those steps
  fail non-zero; nothing in steps 1–3 needs a browser.
- **A rollback plan, made before you publish.** Read [ROLLBACK.md](ROLLBACK.md): archive the
  current live artifact - the deployed bytes, not a rebuild. A rebuild of the V1 tip does
  work, and it still gives you a near-miss: 49 of the 54 live files byte-identically, plus an
  `sw.js` whose version string production never had, an `index.html` without production's
  analytics block, and no `images/screenshots/*` at all. Then confirm the previous deployment
  stays retrievable. The origin is the easy part; the service worker already on visitors'
  devices is the part a revert cannot reach.
- **A green test gate.** Publishing is gated on `npm test` (builds `dist/`
  first, then runs every `tests/**/*.test.{js,mjs}` in one serial sweep) being
  green for the commit you are shipping. This document does not quote a test
  verdict: the fleet gate runs the full suite once on the merged tree, and a
  copy of the numbers here would go stale exactly like the sizes did. If you are
  publishing outside that flow, run it yourself and record the result.
- No credentials are needed for steps 1–6.

## Step 1 — install (dry-runnable)

```bash
npm ci
```

`npm ci`, not `npm install`: it installs exactly `package-lock.json` and fails
if the two disagree, which is what you want for a ship. Observed, from a clean
`git archive` copy of the repo (`npm install` also works — that is what
[README.md](README.md) shows — but it may rewrite the lockfile):

```
added 14 packages, and audited 15 packages in 1s
5 packages are looking for funding
5 high severity vulnerabilities
npm warn install-scripts 1 package has install scripts not yet covered by allowScripts:
npm warn install-scripts   esbuild@0.25.12 (postinstall: node install.js)
```

Both warnings are expected and are **not** a reason to stop:

- the 5 advisories are all in the dev dependency tree (`vite` → `esbuild`,
  `nanoid`, `picomatch`); there is no production dependency, and nothing but
  static files is published;
- the `install-scripts` warning is npm 11 telling you it has not allow-listed
  esbuild's postinstall. `npm ci --ignore-scripts` was also tried: the build
  still works (esbuild's platform binary comes from an optional dependency), so
  a hardened CI with `ignore-scripts=true` will not break this build.

## Step 2 — build (dry-runnable)

```bash
npm run build          # -> dist/
```

Observed (`vite v6.4.1`, and the hash differs on your build):

```
> airhorn@2.0.0 build
> vite build

vite v6.4.1 building for production...
transforming...
✓ 6 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                17.17 kB │ gzip: 5.61 kB
dist/assets/index-C81EVIwm.js  16.66 kB │ gzip: 5.82 kB
✓ built in 222ms
```

Vite prints only the two files it generates. **The other 24 are copied verbatim
from `public/`** and are not listed — that is normal, and it is why you verify
the tree rather than the log:

```bash
find dist -type f | wc -l                                  # -> 26
find dist -type f -printf '%s\n' | awk '{s+=$1} END{print s}'   # -> 244741
find dist -type f | grep -E 'assetlinks|sw\.js|manifest'   # the three files worth eyeballing
grep -m1 'const version' dist/sw.js                        # -> const version = "2.0.0-<buildhash>";
```

If `dist/sw.js` still contains `__BUILD_HASH__` the plugin did not run — stop,
the service worker would ship with a placeholder cache name.

## Step 3 — serve it locally and look at it (dry-runnable)

```bash
npm run preview        # vite preview, http://localhost:4173/
```

`vite preview` binds **localhost only** (no `--host`), so this is a same-machine
check; for a phone on your network see [PHONE-CHECK.md](PHONE-CHECK.md) and a
real origin.

What you should see: a full-screen red horn on blue, nothing else. Hold the
horn — it sounds while held, `aria-pressed` flips, and it stops when you
release. After a few seconds an **Install** button fades in at the bottom
(`beforeinstallprompt` fires on `localhost`/`127.0.0.1` because they are secure
contexts). DevTools → Application → Service Workers shows one **activated**
worker controlling the page; Application → Manifest shows the icons and
screenshots. Devices toolbar → offline, then reload: the app still renders and
still sounds, with the app's own "No connection" banner — that is the whole
offline story, served from the worker's cache.

### The one thing `vite preview` will lie to you about

It runs in SPA mode: **any unknown path returns `200` and the app's
`index.html`**, not a 404. Verified:

```bash
curl -sSI http://localhost:4173/sounds/missing.mp3   # 200, Content-Type: text/html
```

So a typo'd precache path, a missing icon or a mistyped `assetlinks.json` route
is invisible under `npm run preview` — the browser gets HTML where it expected a
binary and the failure surfaces later, on a real host. For a file-level check,
serve `dist/` with something that 404s properly:

```bash
python3 -m http.server 8099 -d dist     # 127.0.0.1:8099, real 404s, correct MIME types
```

(`README.md`'s `deno run --allow-net --allow-read server.ts` does the same on
:8000; it was not exercised in this dry run because port 8000 was already
occupied on the dry-run host.)

### Headers, as measured — and what production must send instead

Measured with `curl -sSI` against `npm run preview` (vite 6.4.1):

| Path | `Content-Type` | `Cache-Control` |
| --- | --- | --- |
| `/`, `/index.html` | `text/html` | `no-cache` |
| `/sw.js` | `text/javascript` | `no-cache` |
| `/assets/index-<hash>.js` | `text/javascript` | `no-cache` |
| `/styles/main.css` | `text/css` | `no-cache` |
| `/manifest.json`, `/.well-known/assetlinks.json` | `application/json` | `no-cache` |
| `/images/*.svg` | `image/svg+xml` | `no-cache` |
| `/favicon.ico` | `image/x-icon` | `no-cache` |
| `/sounds/airhorn.mp3` | `audio/mpeg` | `no-cache` |

`vite preview` sends `no-cache` for everything, which happens to be *correct*
for `/sw.js` and harmless for local checks, but it means **the local server
proves nothing about your host's caching** — the production rules are step 7's
table, and step 8's `curl`s are what verify them.

## Step 4 — regenerate the evidence pack (dry-runnable)

```bash
node tools/preview-evidence.mjs      # writes preview/evidence.json + 4 screenshots
```

It serves `dist/` on an ephemeral loopback port and drives two fresh-profile
headless Chromes (render, offline, installability; then WebMCP with the flag
on), closing each in a `finally`. Exit code 0 = every required capture
succeeded. Observed, in full:

```
=== Preview evidence pack ===
  published: 26 file(s), 244741 B raw, 183085 B gzipped (zlib level 9)
  screenshots: horn-light.png, horn-dark.png, horn-320.png, horn-offline.png
  desktop horn width: 219px; offline: 219px
  dark applied: true (bg rgb(33, 150, 243) -> rgb(7, 19, 31); negative control detects false: true)
  offline renders: true; boot-failure shown: false
  offline play: {"pressedWhileHeld":"true","released":"false"}
  installable: manifest=true (192:true 512:true maskable:true), sw=true, fetch-handler=true, beforeinstallprompt fired=true
  webmcp: modelContext=true tools=[get_horn_state, play_horn, stop_horn]
written to preview/evidence.json
preview-evidence: PASS
```

The `published:` line is where the size claims in step 1 come from. Re-run this
after **any** source change: the screenshots and `generatedAt` are the record of
*that* build, and the bundle hash in them changes with it. This is the only
source of the pack's size numbers — step 1 must not be edited by hand.

## Step 5 — performance report (dry-runnable; desktop-class, so quote the conditions)

```bash
node tools/measure-perf.mjs > preview/CWV-report.txt
```

Unthrottled desktop headless Chrome, default viewport, against a loopback
server — **not** a phone and not a mobile network (see
[EVIDENCE-LIMITS.md](EVIDENCE-LIMITS.md) §4 for why that distinction matters).
The report now says so itself on its `Conditions:` line, so
`preview/CWV-report.txt` cannot be quoted without the caveat travelling with it:

```
Conditions: NO CPU throttling, NO network throttling, default viewport 780x437 @1x,
server on loopback - a desktop-class measurement, NOT a phone on a mobile network
```

Three consecutive runs on the dry-run host against this build
(`preview/CWV-report.txt` is the third of them):

| Load | Transferred | First Paint | LCP | INP (p98) | CLS |
| --- | --- | --- | --- | --- | --- |
| cold | 104,188 B | 232 / 260 / 104 ms | 324 / 308 / 332 ms | 24 ms | 0.0000 ×3 |
| repeat (SW) | 0 B | 60 / 56 / 64 ms | 100 / 104 / 120 ms | none / 32 ms / none | 0.0000 ×3 |

Three things to take from that rather than a single number:

- **Bytes are stable, timings are not.** The cold load transfers 104,188 B over
  the network and the repeat load transfers 0 B, every run. First paint moved
  by ~150 ms run to run on a 2-vCPU VM and INP flipped between "none ≥16 ms" and
  32 ms, so quote the class and the command, never a millisecond figure as a
  promise.
- **CLS is 0.0000, and that is now a measured claim, not a lucky run.** Before
  `airhorn-fgvq` this page scored 0.3599 on 5 of 6 loads: the inline critical
  layer let `#airhorn` shrink-wrap the horn (219 px wide) until the async sheet
  made it viewport-wide (780 px), a shift on the page's only element. The
  critical layer now sizes that box like `main.css` does, and three runs here
  (six loads) score 0.0000. `LCP` also became reliable for the same reason: the
  horn's box now has its final size from the first paint, so the entry is
  recorded (324/308/332 ms cold) instead of `None (0 entries recorded)`, which
  is what it printed on 4 of 6 loads before the fix.
- **This is a desktop-class number only.** Nothing here is throttled, so the
  mobile-class figures `airhorn-df1` measured (see
  [EVIDENCE-LIMITS.md](EVIDENCE-LIMITS.md) §4) are roughly an order of magnitude
  worse; do not carry these numbers into a CWV/RUM claim.

## Step 6 — the HTTPS installability proof (dry-runnable, self-signed only)

```bash
node tools/install-https-proof.mjs   # writes preview/https/
```

Serves the same `dist/` on the hostname `airhorn.test` over both HTTP and
HTTPS (self-signed cert generated per run, mapped with
`--host-resolver-rules`, nothing written to `/etc/hosts`) so the *only* variable
is the scheme. Observed:

```
  chrome: ... HeadlessChrome/155.0.0.0 Safari/537.36
  HTTP  http://airhorn.test:<port>/:  secureContext=false sw=false prompt={"fired":false,"at":0,"platforms":null,"promptError":null,"choice":null}
  HTTPS https://airhorn.test:<port>/: secureContext=true sw=true prompt={"fired":true,...,"platforms":["web"],"promptError":"NotAllowedError: Failed to execute 'prompt' on 'BeforeInstallPromptEvent': The prompt() method must be called with a user gesture","choice":null} button={"disabled":false,"hasAvailableClass":true,"visibility":"visible","pointerEvents":"auto","text":"Install"}
  screenshots: install-http-insecure.png, install-https-selfsigned.png
install-https-proof: PASS
```

(The `promptError` is the proof, not a failure: Chrome rejects `prompt()` when
there is no user gesture, which is exactly what a scripted run is — the event
itself fired and the Install button is enabled.)

That is the strongest local evidence for the "HTTPS at the origin root"
requirement in step 7, and it is still not a real CA chain:
`--ignore-certificate-errors` is in play, so genuine chain validation and
WebAPK generation remain unproven here
([EVIDENCE-LIMITS.md](EVIDENCE-LIMITS.md) §3).

## Step 7 — publish **PRODUCTION ONLY**

Not run in this dry run: nothing below was executed, and no DNS, hosting or
credential was touched. What to do:

1. **Upload the contents of `dist/` to the origin root** (not a subdirectory,
   not a `dist/` folder inside the root). If your host has a "build output
   directory" setting, it is `dist`; if you upload by hand, `dist/.well-known/`
   is a dot-directory and some GUIs skip it silently — verify with step 8's
   `assetlinks` `curl`.
2. **Decide `.well-known/assetlinks.json` before you upload.** It ships as
   `com.airhorner.twa` with the **old production TWA's** signing fingerprint. If
   the existing Play-store TWA is not being reused as-is, regenerating it matters
   *before* publishing (it breaks Android deep links if it is wrong, and does not
   affect the website). Expected content:
   `package_name: "com.airhorner.twa"`, one `sha256_cert_fingerprints` entry.
3. **TLS**: a real certificate for the origin, valid chain, HTTP→HTTPS redirect.
   Without it no service worker registers at all: the whole offline story is a
   secure-context feature.
4. **Cache headers** — the three that matter, and the reason:

   | Path | Required | Why |
   | --- | --- | --- |
   | `/sw.js` | `Cache-Control: no-cache` (or `max-age` ≤ 60) | a stale worker file is the one thing that can pin an old deployment in place. The worker's cache name is stamped with a hash of the whole build, so a *fresh* fetch always creates a new cache and deletes the old one on activate. |
   | `/assets/*` | `Cache-Control: public, max-age=31536000, immutable` | the filenames are content-hashed; this is what makes a returning user download only `sw.js` + `index.html`. |
   | `/index.html` | `no-cache` (or a short max-age) | it names the current bundle hash. |

5. **MIME types**: `.js` → `text/javascript` (or `application/javascript`),
   `.css` → `text/css`, `.json` → `application/json`, `.mp3` → `audio/mpeg`,
   `.svg` → `image/svg+xml`, `.ico` → `image/x-icon`. The local checkers above
   send exactly these; static hosts normally get them right, but a wrong
   `Content-Type` on `sw.js` or the bundle is fatal (the worker will not
   register, or the script will not execute).

## Step 8 — verify the live origin **PRODUCTION ONLY**

Run these against the real origin before telling anyone it is live. Each line
says what a correct deployment returns; the last one is the trap this dry run
found in the local server.

```bash
curl -sSI https://<origin>/sw.js | grep -i 'cache-control'      # no-cache (or a short max-age)
curl -sSI https://<origin>/sw.js | grep -i 'content-type'       # text/javascript
curl -sSI https://<origin>/assets/index-<hash>.js | grep -i 'cache-control'  # immutable, max-age=31536000
curl -sSI https://<origin>/sounds/airhorn.mp3 | grep -i 'content-type'     # audio/mpeg
curl -sS  https://<origin>/manifest.json | head -c 60         # JSON, NOT <!doctype html>
curl -sS  https://<origin>/.well-known/assetlinks.json | head -c 60  # your decision from step 7, served
curl -sS  -o /dev/null -w '%{http_code}\n' https://<origin>/no-such-path  # 404
```

The 404 line is the one that catches a host configured for an SPA fallback —
Cloudflare Pages, Netlify and Firebase Hosting all do it in their most common
configurations, and `vite preview` does it locally (verified above). Under such
a host a wrong precache path ships silently instead of 404ing.

Then in a desktop Chrome, on the live origin:

- DevTools → Application → **Service Workers**: one worker, **activated**,
  controlling the page, no error. Then tick *Offline* and reload — the app
  renders and sounds, with the "No connection" banner.
- Application → **Manifest**: name, icons, screenshots, no installability
  warning. The **Install** button appears in-page within a few seconds.
- **Lighthouse: attempted, environment-incompatible — recorded, not hidden.**
  `npx lighthouse https://<origin>/ --view` (needs network for `npx`) is the
  only way to get a synthetic score, and the one thing here that could not be
  dry-run at all. On this VM Lighthouse 13.5.0 failed with `NO_FCP` in **nine**
  full-page runs while the page demonstrably painted (its own traces show paint
  ~80 ms after navigation start, and the repo's CDP tool records FCP); a trivial
  page scores 100 under the same binary. No Lighthouse score is claimed
  anywhere in this repo — run it on a desktop machine or a hosted runner, and
  treat `preview/CWV-report.txt` as the perf evidence of record locally.
- Then hand over to **[PHONE-CHECK.md](PHONE-CHECK.md)** — steps 7–9 of that
  page (install from the real origin, home-screen shortcut, badge) are the parts
  no local check can do.

## What local verification still cannot prove

Kept from the ship/no-ship record, in one place, with the full list in
[EVIDENCE-LIMITS.md](EVIDENCE-LIMITS.md):

- **Real-device install flow.** `beforeinstallprompt` firing on `127.0.0.1`
  proves Chrome's installability checker passed, and the self-signed HTTPS run
  (step 6) proves it is the scheme that gates it — but the mobile OS install
  banners, standalone launch, icon/splash rendering and Chrome's engagement
  heuristics are only provable on a served, certificated origin, on a phone.
- **`.well-known/assetlinks.json`** is the old production TWA's unless you
  regenerate it (step 7.2).
- **Real-user CWV (CrUX/RUM)** — every number in step 5 is synthetic, on a fast
  VM on loopback. Field data exists only after deployment.
- **The WebMCP flag** — `document.modelContext` is behind
  `--enable-features=WebMCP,WebMCPTesting` in this Chrome; the code path is
  exercised by the repo's browser suites, but no shipping browser enables it by
  default, so real in-page agents are unverified in the wild.
- **Non-Chromium engines** — every local run is Chrome 155 on Linux; WebKit and
  Gecko behaviour (iOS install, audio-gesture rules, the mute switch) is
  entirely unverified.

## Scope of this dry run

Steps 1–6 were executed against a fresh `git archive` copy of `ba2cad3` on
2026-10-20, and again against `b477ddb` to regenerate the pack; the only files they write are `dist/` and `preview/`. **No
production resource was touched**: no DNS record, no hosting configuration, no
certificate, no credential, and nothing was uploaded anywhere. Steps 7–8 are
written from the requirements the local checks establish (origin root, HTTPS,
the two cache headers, MIME types) and have not been run — treat their quoted
expectations as the target to verify against, not as observed output.
