# ROLLBACK — undoing a V2 deploy to airhorner.com

This is the undo plan for shipping V2 (`dist/`, 26 files) over the live V1 site at
`airhorner.com`. It is the companion to [DEPLOY.md](DEPLOY.md): DEPLOY says how to put V2
up, this says how to take it down, in what order, and exactly how far the undo reaches.

The short version, because it is not the obvious one:

1. **The origin is easy.** V1 is a 54-file static tree (2,909,540 B) served by a Google
   front end with `cache-control: public, max-age=10` on every file, including
   `/sw.js`. Nothing needs purging; a revert is visible everywhere within 10 seconds.
2. **The service worker is the only part that can outlive the revert**, and it does so
   through a specific, measured failure mode: a rollback that restores V1's cache-first
   worker (0.6.20) can have that worker's precache filled with *V2* bytes, because the
   precache fetch is answered from the browser's HTTP cache while the origin's
   `max-age=10` window is still fresh. The device then shows V2 forever, with a V1 worker
   in control, and nothing self-heals. That is the risk worth planning for, and §6 has
   the escape hatch that cannot be poisoned.
3. **Production is not any commit in this repo, and no build of it is production.**
   Building the V1 tip (`563bdc3`, `npm ci` + `npx gulp` on Node 24) reproduces **49 of the
   54 live files byte-identically** — including `scripts/main.min.js`, `styles/main.css` and
   all 15 images, so even the gulp/`imagemin` output is reproducible. It does not reproduce
   `sw.js` (production says `0.6.20`; that string exists in **no** commit), `index.html`
   (production carries an Analytics/`interestCohort` block and a different `origin-trial`
   token) or `manifest.json` (production adds two screenshots), and it contains neither
   screenshot file. So **the rollback target is the deployed bytes, archived — not a
   checkout.** A V2 deploy destroys the only easy path back unless that archive exists.

Every number here was observed on this VM on 2026-10-21 (Chrome 155 headless, Node
24.22.0, a loopback server) unless it says **PRODUCTION ONLY** — those commands need the
real host and were *not* run. §9 lists the limits of the evidence.

## 1. What is actually deployed today (V1), measured

Read-only probes against the live origin, 2026-10-21:

| Fact | Value |
| --- | --- |
| Reachable, TLS | `https://airhorner.com/` → 200 over HTTP/2; `curl` verified the certificate chain (no `-k`) |
| Server | `server: Google Frontend`, `x-cloud-trace-context: …` — the App Engine static shape that V1's (now deleted) `app.yaml` declares |
| Cache policy | `cache-control: public, max-age=10`, `expires: <date> +10s`, `etag` — on `/` **and** on `/sw.js` (`default_expiration: "10s"` in `app.yaml` at `563bdc3`) |
| `/sw.js` | 1,505 B, `content-type: application/javascript`, `const version = "0.6.20"`, cache `airhorner-0.6.20` |
| Unknown paths | 404 (`/no-such-path-xyz` → 404) — **no SPA fallback**, so a wrong path fails loudly |
| V2-only paths | `/assets/index-C81EVIwm.js` → 404: V2 is not deployed |
| Published tree | **54 files, 2,909,540 B**, all 200; byte-identical across two fetches (no gzip instability when fetched with `curl --compressed`) |
| Reproducible from `git@563bdc3` (V1 tip) | **49 of 54**, byte-identical, by `npm ci` + `npx gulp` (measured on Node 24) |
| NOT reproducible from any commit | `sw.js` (`0.6.20` exists in no commit), `index.html` (Analytics/`interestCohort` block + a different `origin-trial` token), `manifest.json` (adds 2 screenshots), and those 2 screenshots (`/images/screenshots/1-360x640.png`, `2-360x640.png`) — paths no commit contains |
| Archive of record | `~/airhorn-v1-artifact/` (outside this repo): `live/` = these 54 files, `cannot-regenerate/` = the 5 above with hashes, `SHA256SUMS` (55 entries), verified by serving it and driving it in Chrome (§5 Step 0) |
| `.well-known/assetlinks.json` | 300 B, byte-identical in V1 and in V2's `dist/` — no Android deep-link change either way |

Why this matters: V1's build was `gulp` (`gulpfile.babel.js` at `563bdc3`: gulp 4 + rollup +
babel + `gulp-imagemin`) into `dist/`, which V1's `.gitignore` excludes. That pipeline *does*
still run (measured: ~50 s, exit 0, on Node 24), so a rebuild is a fallback that gives you a
**working** V1 — 49/54 exact, with the differences being an expired `origin-trial` token, an
analytics snippet and a manifest field. It is not a rollback: it is a different deployment
whose `sw.js` version string nobody can predict from the repo. **The rollback artifact is the
archived deployment, and it is the only thing that puts production back exactly.**

## 2. What V2 changes at the origin

| | V1 (live) | V2 (`dist/`, this tree) |
| --- | --- | --- |
| Files at the origin root | 52 | 26 |
| Paths | `/scripts/*`, `/images/icons/*`, `/images/touch/*`, `/sounds/{MP3,WAV}/*` | `/assets/index-<hash>.js`, `/images/*`, `/sounds/airhorn.mp3` |
| `sw.js` | hand-written, `version = "0.6.20"`, stable text | build-stamped by the Vite plugin: `version = "2.0.0-<buildhash>"` |
| SW caches | `airhorner-0.6.20` | `airhorner-2.0.0-<buildhash>` + `horn-integrity-2.0.0-<buildhash>` |
| SW fetch strategy | cache-first for every same-origin GET, network fallback, **no integrity check, no pruning on activate** | verified-bytes cache hit first (navigations get the cached shell), bounded network waits, activate deletes every other `airhorner-*` / `horn-integrity-*` |
| `manifest.json` | 2,218 B | 2,980 B (adds `id`, screenshots, *Instant Blast* shortcut) |

A traffic switch to a V1 deployment restores that tree **atomically** — a deployment
serves only its own files, so there is no way to end up with V2's `index.html` next to
V1's `scripts/`, which is the single most dangerous half-state (§4 drill D).

**V2's tree carries no host configuration.** `49346d5` deleted `app.yaml`, and nothing at
`HEAD` replaces it — so whatever is used to publish V2 must supply the config that
produces the measured live behaviour, or the rollback inherits a different one:

```yaml
# app.yaml at 563bdc3 (V1, live today) — the file that yields `public, max-age=10`
default_expiration: "10s"
handlers:
- url: /manifest.json
  mime_type: application/json
  static_files: dist/manifest.json
  upload: dist/manifest.json
  secure: always
  http_headers: { Access-Control-Allow-Origin: "*" }
- url: /
  mime_type: text/html
  static_files: dist/index.html
  secure: always
  upload: dist/index.html
- url: /(.+)
  static_files: dist/\1
  upload: dist/(.+)
  secure: always
  http_headers: { Access-Control-Allow-Origin: "*" }
```

Three of those lines are load-bearing for a rollback, and for the `dist/` deploy that
replaces them: `default_expiration` (a long TTL widens drill E's window, and `immutable`
on `/` — which DEPLOY.md forbids for `/sw.js` and `/index.html` — would widen it a lot),
`secure: always` (without HTTPS there is no service worker at all), and the `/(.+)`
static handler (which is what makes a missing file a 404 instead of an HTML 200).

## 3. The four things "rollback" can mean — and which ones you actually need

| Lever | What it is | Reach | Notes |
| --- | --- | --- | --- |
| **A. Traffic switch** | re-point the origin at the stored V1 deployment (`gcloud app services set-traffic … --splits=<version>=1`) | every request, in seconds | byte-exact, reversible; the primary lever. Use `set-traffic`: `gcloud app versions migrate` is documented as *gradual*, so it is the wrong tool when you need the old version *now* |
| **B. Deployed artifact** | the bytes at the origin root | as A | only relevant if you deploy by uploading files (static host / rsync); never rebuild V1 |
| **C. Edge cache / CDN invalidation** | purging cached responses | up to `max-age` | measured `max-age=10` on today's origin: **nothing to purge**, wait 10 s. Only becomes a real step if V2 ships somewhere with longer TTLs |
| **D. The service worker on devices** | the copy of `sw.js` already installed in every browser that visited | **not revocable** | A–C cannot touch it. The only lever is the bytes served at `https://airhorner.com/sw.js`, and they are read on the device's next load. §4–§6 |

D is the whole reason this document exists: A+B+C is one command and ten seconds, and a
device can still be sitting on V2 afterwards.

## 4. What a stale service worker does to visitors after a rollback — measured

Six drills, each a fresh Chrome profile, a loopback server, V2's real `dist/`, and the
**real live V1 tree** (the 52 mirrored files, hashes in §Appendix) as the rollback
target. "Reload" is a plain navigation with no scripted `registration.update()` — what a
returning visitor does.

| # | Situation after the rollback | Result |
| --- | --- | --- |
| **A** | Plain V1 restore (`sw.js` → 0.6.20), visitor reloads | **Leaves V2 on the first reload.** V1 worker installs → activates → `clients.claim()` → V2's `controllerchange` handler reloads the tab → V1 renders. `/sw.js` is fetched on *every* reload. |
| **B** | Same, but `sw.js` served `public, max-age=31536000, immutable` (host misconfig, before and after the switch) | **Same result.** The update check sends `cache-control: max-age=0` (+`If-None-Match`), i.e. Chrome bypasses its HTTP cache for the worker script (`updateViaCache: "imports"`), so a long TTL on `/sw.js` does not pin Chromium. |
| **C** | V2 worker rejects **every navigation** (catastrophic V2 bug), then rollback | Visitor sees Chrome's error page **once**; the update check still runs during that navigation, and **the next visit renders V1**. Recoverable without user action beyond a reload. |
| **D** | Rollback tree is **incomplete** — the restoring worker's precache 404s (half-restored upload, or a host that answers 200 with HTML for missing paths) | **The device stays on V2 forever.** Install rejects, the empty cache it created is abandoned and recreated on each attempt, the old V2 worker keeps control, and each reload re-fetches `sw.js` and fails again. The V2 page does announce *"The app could not update – you are still on the previous version."* Fix the tree and the next visit installs. |
| **E** | Rollback happens while the device's HTTP cache for `/`, `/index.html`, `/styles/main.css` is still fresh (`max-age=10`) | **The device keeps showing V2, silently, indefinitely.** The V1 worker's `cache.addAll()` is answered from the browser's HTTP cache with V2 bytes (no request reaches the origin), so `airhorner-0.6.20` stores the V2 document and CSS. V1's worker is cache-first and never revalidates or heals, and its own `sw.js` will not change again — so there is no second chance. Measured both ways: rolled back immediately (wedged across three reloads) and after a 20 s wait (clean V1 handover). |
| **F** | Rollback worker that precaches **nothing** and deletes every `airhorner-*` / `horn-integrity-*` cache on activate (§6) | **Clean, and cannot be poisoned.** Page is V1 on the first reload, `caches.keys()` is `[]`, V1 loads straight from the origin on every subsequent load, no reload loop, still controlled by a worker (so no unregister/re-register churn). |

Reproduce a drill: serve `dist/` on one port and the mirrored V1 tree on another, load the
V2 page twice (so its worker controls), then swap the served tree, reload, and read
`caches.keys()` plus `caches.match('/')`'s body for `Press and hold to sound the air horn`
(V2) versus `class=horn role=button` (V1).

### The 24-hour question

Chrome's documented behaviour is that navigation-triggered update checks are throttled to
one per 24 hours. **That throttle did not appear in any drill here** — `/sw.js` was
requested on every reload in every scenario, including when the page being served was
V1's. Both pages call `navigator.serviceWorker.register('/sw.js', { scope: '/' })` on load,
which is the likely reason, but a day-old registration could not be reproduced on this VM.
Treat "the device is released on its next visit" as the measured case and "up to 24 hours"
as the documented worst case; plan for neither being guaranteed. **Non-Chromium engines
were not tested at all** (no WebKit or Gecko on this VM — see
[EVIDENCE-LIMITS.md](EVIDENCE-LIMITS.md) §1), and Safari's update cadence for
home-screen additions is its own story.

### Can a pinned client be broken free at all?

- **By the origin: yes, but only through `/sw.js`.** It is the one file a device re-reads
  on its own; nothing else you deploy can reach a worker that is committed to serving a
  cached shell. A device that fetched `/` from the origin inside the `max-age` window just
  before the switch (drill E) is the one case where serving plain V1 bytes is not enough.
- **By the user: yes, always.** DevTools → Application → Storage → *Clear site data*, or
  Application → Service Workers → *Unregister*; Chrome Android: Settings → Site settings →
  all sites → `airhorner.com` → *Clear & reset*. Reinstalling the PWA is **not** a reliable
  substitute — the origin's storage can survive it. Do not count on this in a plan: it
  requires every visitor to know what it is.
- **By us, remotely: no.** There is no push channel, no `postMessage` from the server, and
  no API that reaches an installed worker. Only the next read of `/sw.js` does.

## 5. The order of operations

### Step 0 — the archive: it now exists, and it is the rollback target

**Revert means redeploying the archived live bytes, not `git checkout`.** Production is not
any commit here (§1), so a checkout gives you a near-miss, and `sw.js` — the one file that
decides whether installed devices ever see the revert — would come back with a version
string production never had.

**A V2 deploy destroys the only easy path back unless this archive exists.** Once `dist/` is
at the origin, the V1 tree is gone from the live host; the only copies are whatever was
archived beforehand plus the host's own stored deployment. Do not deploy V2 before both of
those are confirmed.

The archive of record, made 2026-10-21 and verified:

```
~/airhorn-v1-artifact/
  live/                 54 files, 2,909,540 B — production, byte-for-byte
  cannot-regenerate/    sw.js, index.html, manifest.json, 2 screenshot PNGs + hashes and why
  rollback-overlay/     sw.js — the §6 worker (NOT production; rollback use only)
  SHA256SUMS            55 entries; `sha256sum -c SHA256SUMS` passes
```

It was verified the way it will be used, not by inspection: served on a loopback origin with
production's own `cache-control: public, max-age=10`, then driven in headless Chrome 155 —
boots (`.horn[role=button]`, styles applied), works (press-and-hold flips `aria-pressed`),
installs (manifest 200, all 12 icons **and** both screenshots resolve, worker activates,
`airhorner-0.6.20` holds its 8 precached paths), and survives an offline reload with the
origin destroyed.

To get a copy on a fresh machine, either form works and neither needs the old toolchain:

```bash
# (i) from the branch in this repo (no network beyond your git remote):
ARCHIVE="${ARCHIVE:-$HOME/airhorn-v1-artifact}" && mkdir -p "$ARCHIVE"
git fetch origin fleet/live-v0.6.20-archive
git archive origin/fleet/live-v0.6.20-archive archive/live-v0.6.20 \
  | tar -x -C "$ARCHIVE" --strip-components=2
find "$ARCHIVE/live" -type f | wc -l          # 54

# (ii) or from the checksummed tarball kept outside the repo (verify it where it sits:
#      the .sha256 names the file, so no path juggling and no "~" inside a quoted string):
tarball="$HOME/airhorn-v1-artifact/airhorner-live-v0.6.20-2026-10-21.tar.gz"
( cd "$(dirname "$tarball")" && sha256sum -c "$(basename "$tarball").sha256" )
tar -xzf "$tarball" -C "$HOME/airhorn-v1-artifact"
```

To re-fetch it **from production** instead (this is also how you check that the live site is
still serving the archived bytes), run this from a checkout of this repo - it locates
`ROLLBACK.md` itself, so there is nothing to edit:

```bash
repo=$(git rev-parse --show-toplevel)          # run from the checkout, before the cd
mkdir -p ~/airhorn-v1-artifact && cd ~/airhorn-v1-artifact
awk -F'|' '{p=$2; h=$3; gsub(/^ +| +$/, "", p); gsub(/^ +| +$/, "", h);
            if (length(h)==64) print p}' "$repo/ROLLBACK.md" > paths.txt
while IFS= read -r path; do
  mkdir -p "live/$(dirname "$path")"          # inside live/, because that is where -o writes
  curl -sS --compressed --fail -o "live/$path" "https://airhorner.com/${path// /%20}"
done < paths.txt
echo "downloaded $(wc -l < paths.txt) files into ./live - now run section 10 check (b)"
```

The re-fetch writes `live/` only; `MANIFEST.tsv`, `SHA256SUMS` and the overlay worker come
from (i) or (ii), and `section 10 check (a)` needs them. `section 10 check (b)` verifies a
re-fetch against the table in this file.

Two properties were measured for this archive: the origin is byte-stable (two fetches of
all 54 files matched), and `curl --compressed` is required — without it four files
(`sw.js`, `styles/main.css`, `scripts/comlink.global.js`, `assetlinks.json`) sometimes
arrive gzip-encoded and every hash disagrees.

Also confirm, before V2 goes near the host, that **the V1 deployment stays retrievable**:

```bash
# PRODUCTION ONLY — not run here
gcloud app versions list --service=default --sort-by='~version.createTime'   # the serving V1 version id
gcloud app versions describe <v1-version-id> --service=default               # its own files, not a rebuild
```

**Deploy V2 as a new version and keep the old one.** Never `--promote` over the V1 version
in a way that leaves nothing to switch back to, and never delete the V1 version until V2's
window is over.

### Step 1 — decide which rollback you are running

- **R1 (recommended): one atomic switch to a rollback deployment.** A new version whose
  files are *the archived V1 tree plus the rollback worker from §6 as `/sw.js`*. It
  restores V1 and purges poisoned caches in the same instant, and because a deployment
  serves only its own files there is no half-restored state (drill D).
- **R2 (fastest, if the archive is not ready): switch traffic back to the plain V1
  version.** Correct for every device whose HTTP cache is cold (drills A–C); leaves the
  devices from drill E showing V2, and leaves `airhorner-2.0.0-*` /
  `horn-integrity-2.0.0-*` on every V2 device for good (V1's worker never deletes caches).
- **R3 (correction after R2):** publish the rollback worker on its own as soon as R2 is
  live; devices from drill E are freed on their next visit by the `sw.js` change alone.

### Step 2 — switch traffic (seconds)

**One switch, to one named version. Never a second command that re-targets a different
version** — that is how an R2 rollback silently turns into an R1 one.

```bash
# PRODUCTION ONLY — not run here
# R1 deployment directory = the archived V1 tree (its contents sit at the root, because the
# archive IS what was published), plus the §6 worker as ./sw.js. Its app.yaml therefore
# points at the root, not at dist/:
#
#   default_expiration: "10s"
#   handlers:
#   - { url: /manifest.json, mime_type: application/json, static_files: manifest.json, upload: manifest.json, secure: always }
#   - { url: /,              mime_type: text/html,          static_files: index.html,    upload: index.html,    secure: always }
#   - { url: /(.+),          static_files: \1,              upload: (.+),                secure: always }
gcloud app deploy app.yaml --version v1-rollback --no-promote
# preview on the version URL first; note that hostname is a DIFFERENT origin, so the
# service worker being exercised there is not the one airhorner.com uses.
# Then pick ONE of the two switches below - they target different versions:
#
#   R1 - the rollback deployment just uploaded (archived V1 + the §6 worker):
gcloud app services set-traffic default --splits=v1-rollback=1 --quiet
#
#   R2 - the plain V1 deployment already on the host (no build, no upload):
# gcloud app services set-traffic default --splits=<v1-version-id>=1 --quiet
#
# `set-traffic` sends ALL traffic to the named version in one step. `gcloud app versions
# migrate <version>` is documented as a GRADUAL shift (it ramps traffic), so it is not the
# command to reach for in an incident - if you use it, watch the split until it reaches 1.
#
# INSTANT is not the same as ALL DEVICES: see §4 - the origin can be V1 in seconds while a
# device that never loads the page again is still on V2.
```

If V2 ships on a static host instead, one operation per host (re-promote the previous
deployment, or upload the archived tree), plus a purge only if that host caches HTML:

```bash
# PRODUCTION ONLY — not run here. Exact syntax varies by CLI version; check --help first.
# Cloudflare Pages:  re-promote the previous deployment (dashboard → Deployments → Rollback),
#                    or `npx wrangler pages deploy <archived-v1-dir> --project-name <name>`,
#                    then purge if the zone caches HTML:
#   curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE/purge_cache" \
#     -H "Authorization: Bearer $CF_TOKEN" -H 'content-type: application/json' \
#     --data '{"files":["https://airhorner.com/sw.js","https://airhorner.com/","https://airhorner.com/index.html"]}'
# Firebase Hosting:  `npx firebase hosting:rollback` (previous release) or
#                    `npx firebase hosting:clone <site>:<channel> <site>:live`
# Netlify:           `netlify api restoreSiteDeploy --data '{"site_id":"…","deploy_id":"…"}'`
```

Restore the **whole tree** in one operation. A partial restore is strictly worse than no
rollback (drill D): it pins every V2 device and it does so quietly.

If you restore by hand rather than by switching deployments, two files are easy to lose
and both are silent: `.well-known/assetlinks.json` (a dot-directory — check it served, it
is byte-identical in V1 and V2) and the `/sw.js` of §6 (a hand-restore of V1's own
`sw.js` is exactly drill E).

### Step 3 — wait out the cache window, then verify (§7)

`max-age=10` is measured on the live origin, so 10 s after the switch the edge is serving
V1 everywhere. Verifying earlier can read a cached V2 response and tell you the rollback
failed when it did not.

### Step 4 — the devices that are still on V2

There is no push. They move on their next visit, by reading `/sw.js` (§4). If drill E
applies, that is what Step 1-R1/R3 exists for: the rollback worker deletes
`airhorner-2.0.0-*` and `horn-integrity-2.0.0-*`, precaches nothing, and does not
intercept fetches, so the device loads V1 from the origin on the same visit.

## 6. The rollback worker (the one file worth writing by hand)

V1's own `sw.js` is the wrong thing to serve during a rollback twice over: it precaches
the shell (drill E) and it is cache-first forever after (no heal, no prune). Serve this
instead, at `/sw.js` in the rollback deployment, and nothing else changes:

```js
// Rollback worker for airhorner.com — bead airhorn-xuta, plan in ROLLBACK.md §6.
// Job: get the poisoned caches off the device and then stay out of the way.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names
    .filter(name => name.startsWith('airhorner-') || name.startsWith('horn-integrity-'))
    .map(name => caches.delete(name)));
  await self.clients.claim();
})()));

// Deliberately no fetch handler: every request goes to the origin. Nothing here can be
// poisoned by a fresh HTTP cache entry and nothing here serves a stale shell.
```

Why this shape and not "V1's worker, quickly":

- **It cannot be poisoned.** Drill E happens because a *precache* read stale bytes from the
  HTTP cache. This worker precaches nothing, so there is nothing to fill with V2.
- **It heals what the revert cannot reach.** It deletes `airhorner-2.0.0-*` and
  `horn-integrity-2.0.0-*` — roughly V2's whole published tree per device (244,741 B raw,
  `publishedTotals` in DEPLOY.md step 4) — which V1's worker leaves behind forever.
  Measured: `caches.keys()` is empty after this worker activates; with a plain V1 restore
  both V2 caches are still listed three reloads later.
- **It removes the cache-first pin.** With no fetch handler, the page is the origin's page
  from that visit onward. V1's `index.html` still calls `register('/sw.js')` on every load,
  which now just re-checks this worker — harmless, and no reinstall.
- **It does not loop.** Measured across three reloads: one reload on the change, then
  stable.

Cost to be explicit about: **offline support is off for everyone while this is deployed**
and every load is a network load. That is a deliberate trade for the minutes of an
incident; ship a normal caching worker (a fresh build, or V1's `sw.js` bumped to `0.6.21`)
when the incident is over, and offline comes back on the next visit.

## 7. Verifying the rollback from outside

Origin first (`max-age=10`, so repeat after `sleep 11` if the first read is suspicious):

```bash
curl -sSI https://airhorner.com/sw.js | grep -iE 'cache-control|content-type|expires'
#   public, max-age=10 · application/javascript · expires +10s

# --compressed on every body fetch: this origin sometimes returns gzip without being asked
# for it, and an un-decompressed body makes grep report "binary file matches" and print
# nothing - which looks like "no version string" rather than "curl did not decode".
curl -sS --compressed https://airhorner.com/sw.js | grep -m1 -a 'const version'
#   V1:        const version = "0.6.20";
#   rollback worker: no version line at all (it holds no cache) — check for its marker comment
#   still V2:  const version = "2.0.0-<buildhash>"   ← the rollback has not reached this POP

curl -sS --compressed https://airhorner.com/ | grep -c 'Press and hold to sound the air horn'   # V1 → 0
curl -sS --compressed https://airhorner.com/ | grep -c 'role=button'                            # V1 → 1
curl -sS --compressed https://airhorner.com/scripts/main.min.js -o /dev/null -w '%{http_code}\n' # V1 → 200
curl -sS --compressed https://airhorner.com/assets/index-C81EVIwm.js -o /dev/null -w '%{http_code}\n' # V2's bundle → 404
curl -sS --compressed https://airhorner.com/.well-known/assetlinks.json | head -c 60              # JSON, unchanged
curl -sS --compressed https://airhorner.com/no-such-path-xyz -o /dev/null -w '%{http_code}\n'     # 404 (no SPA fallback)
```

A cache-buster (`.../sw.js?cb=$(date +%s)`) proves what the *origin* holds; it does not
prove what a device's next update check will see, because that request uses the plain URL.
One POP is not the world either: these curls prove the edge that answered them.

Then the part that actually decides whether the rollback worked — a browser:

```bash
google-chrome --user-data-dir="$(mktemp -d)" --no-first-run https://airhorner.com/
# DevTools → Application → Service Workers: one worker, activated, no error.
# DevTools → Application → Cache Storage: airhorner-0.6.20 present; with the §6 worker, no caches at all.
# Expect the V1 horn: full-screen red horn, press-and-hold sounds, no WebMCP tools in the console.
```

And, critically, **a profile that had V2** (this is where a rollback that looks perfect at
the origin is invisible to users):

```bash
# reuse the profile you tested V2 with, or one that visited during the V2 window
google-chrome --user-data-dir=/tmp/profile-that-had-v2 https://airhorner.com/
# DevTools → Application → Service Workers → "Update on reload" off; navigate normally.
# Cache Storage: airhorner-2.0.0-* / horn-integrity-2.0.0-* must be gone with the §6 worker,
# and the page must be V1. If it still renders V2, you are looking at drill E:
# ship the §6 worker (it is the only lever) and re-check on the next load.
```

## 8. What is lost, and what is not

**Not lost / no data to restore:**

- No server-side state: this is a static site — no database, no accounts, no analytics (V2
  removed the old analytics and `pwacompat`). Nothing to restore, nothing to reconcile.
- No DNS, TLS or certificate change is involved in a revert; redirects and the
  `assetlinks.json` (300 B, identical in both versions) stay as they are.
- The V2 deployment itself: keep the version (or the `dist/` tarball) — re-promoting it
  later is the same traffic switch in reverse.

**Lost on every device that had V2:**

- **V2's user-visible improvements**: the semantic `<button>` horn and its accessibility
  work, the WCAG contrast ring, the CLS fix (V1's own layout shift), the synthesised audio
  fallback for a failed sample load, the boot-failure banner, the WebMCP tools
  (`play_horn` / `stop_horn` / `get_horn_state`), manifest *Instant Blast* shortcut and
  screenshots, and V2's bounded/hanging-connection handling. A rollback is a feature
  regression, not just a version number.
- **Offline storage hygiene**: with the §6 worker deployed, `airhorner-2.0.0-*` and
  `horn-integrity-2.0.0-*` are deleted (that is the point); with a plain V1 restore they
  stay for the life of the profile, unreachable and unreclaimed (244,741 B raw per device).
- **Offline support itself**, while the §6 worker is serving: every load needs the network.
- **Residue that stays**: V2's `localStorage` keys (`airhorn:badge-count`,
  `airhorn:badge-epoch`) are ignored by V1 and remain on disk; the installed icon and app
  badge state live in the OS launcher and are unaffected.

## 9. Limits of this evidence

- **Chromium only.** Every measurement is headless Chrome 155 on Linux. WebKit/Safari and
  Gecko service-worker update behaviour — and iOS's handling of home-screen web apps —
  were not tested (no WebKit or Gecko on this VM, [EVIDENCE-LIMITS.md](EVIDENCE-LIMITS.md) §1).
- **Loopback, not airhorner.com.** The drills serve V2's `dist/` and a mirror of the live
  V1 tree from `http://127.0.0.1:<port>` (a secure context for SW purposes, but not the
  real origin). Real CDN behaviour is represented by copying the measured header
  (`public, max-age=10`), not by using the CDN.
- **No production command was run.** Every `gcloud` / host / purge line is written from
  the host's own documented interface and marked **PRODUCTION ONLY**; none was executed,
  and no credential, DNS record or certificate was touched.
- **The 24-hour throttle is documented, not measured** (§4). A day-old registration could
  not be reproduced here.
- **Drill E's window is the origin's `max-age`**: 10 s today. If V2 ships with longer TTLs
  (for example `immutable` on `/`, which DEPLOY.md forbids but hosts like to apply), the
  window in which a rollback can wedge devices grows with it. That is the one reason to
  check cache headers *before* shipping V2 rather than after.
- **The V1 mirror is an archive, not a build.** It reproduces what the origin serves today
  (verified byte-for-byte, twice); it cannot be regenerated from git, and it will drift if
  anything (including an emergency `sw.js` patch) is ever published to V1.

## 10. Appendix — the V1 artifact manifest (recorded 2026-10-21)

54 files, 2,909,540 bytes, fetched from `https://airhorner.com/` with `curl --compressed`
(see §5 Step 0), each fetched twice with identical hashes. This table is the verification
oracle for a restore: `sha256` is of the file as served (decompressed), `content-type` is
what the origin sends and what a static restore must send again. The archive at
`~/airhorn-v1-artifact/` carries the same rows as `MANIFEST.tsv`, which is what check (a)
below reads; check (b) reads this table. Both exit non-zero on any mismatch.

Both checks below **fail closed**: each runs in its own subshell under `set -euo pipefail`,
asserts the expected number of rows *before* checking anything, and exits non-zero on a
missing file, a bad hash, a truncated manifest or an empty one. Run one of them, not neither.
(A bare `sha256sum -c` whose exit code nobody reads is not a check: it prints FAILED and
carries on, and an empty manifest makes a per-file loop do nothing and "succeed".)

```bash
# (a) inside the archive: SHA256SUMS is what was written when it was made; MANIFEST.tsv is
#     the same data as the table below in path<TAB>sha256<TAB>bytes<TAB>type form.
( set -euo pipefail
  cd ~/airhorn-v1-artifact
  files=54 signers=55
  rows=$(grep -vc '^#' MANIFEST.tsv 2>/dev/null || true)
  [ "$rows" -eq "$files" ] || { echo "MANIFEST.tsv has ${rows:-0} rows, expected $files - do not deploy" >&2; exit 1; }
  listed=$(grep -vc '^#' SHA256SUMS 2>/dev/null || true)
  [ "$listed" -eq "$signers" ] || { echo "SHA256SUMS has ${listed:-0} entries, expected $signers - do not deploy" >&2; exit 1; }
  sha256sum -c --quiet SHA256SUMS || { echo "SHA256SUMS FAILED - do not deploy" >&2; exit 1; }
  awk -F'\t' '!/^#/ && NF>=3 {print $2"\t"$1}' MANIFEST.tsv |
  while IFS=$'\t' read -r want p; do
    got=$(sha256sum "live/$p" 2>/dev/null | cut -d' ' -f1 || true)
    [ "$got" = "$want" ] || { echo "MISMATCH: $p - do not deploy" >&2; exit 1; }
  done
  echo "archive verified: $files live files (+ the rollback overlay)"
)
```

```bash
# (b) from a checkout of this repo, checking the table below against an archive made beside
#     it (the form that does not need MANIFEST.tsv). Run it HERE, not in the archive:
#     ROLLBACK.md lives in the repo and an archive does not carry it. Pass the archive path
#     as $1 if it is not the default.
( set -euo pipefail
  archive="${1:-$HOME/airhorn-v1-artifact}"
  files=54
  rows=$(grep -c '| [0-9a-f]\{64\} |' ROLLBACK.md)
  [ "$rows" -eq "$files" ] || { echo "this table has $rows rows, expected $files" >&2; exit 1; }
  awk -F'|' '{p=$2; h=$3; gsub(/^ +| +$/,"",p); gsub(/^ +| +$/,"",h);
              if (length(h)==64) print p"\t"h}' ROLLBACK.md |
  while IFS=$'\t' read -r p want; do
    got=$(sha256sum "$archive/live/$p" 2>/dev/null | cut -d' ' -f1 || true)
    [ "$got" = "$want" ] || { echo "MISMATCH: $p - do not deploy" >&2; exit 1; }
  done
  echo "table verified: $rows files against $archive"
)
```

The table itself is the reviewable copy of the manifest (54 rows, one per live file); the
archive's `MANIFEST.tsv` is the machine-readable one. If they ever disagree, the archive is
wrong and the table is right — the table was generated from the same two-fetch-verified
mirror the archive holds.

| path | sha256 | bytes | content-type |
| --- | --- | ---: | --- |
| .well-known/assetlinks.json | 8b2e023e951851bb9002f9a0176b2b6b673741284e02b8c9cd4af9d2c05fc2f8 | 300 | application/json |
| favicon.ico | ca9dab9d58f302e503871527001379595b92a8b6796caf18515ca43ad271388d | 3143 | image/x-icon |
| humans.txt | f65ed0376a2348945dd166188608968ae8695f895c94a18d8fabf2773c65fbe2 | 219 | text/plain |
| images/airhorn.svg | 22ff763731cedbe161b555583fe46cd97b262384a403a328d39490e2b5a81636 | 297 | image/svg+xml |
| images/icons/icons-hinted.ttf | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | 0 | application/octet-stream |
| images/icons/icons.eot | 89f26f6675768fedfb9f5980ae887b9482d850fd5dd246efe8d906fc9cc7979d | 3528 | application/vnd.ms-fontobject |
| images/icons/icons.svg | 900fbe934249ad120004bd24adf66aad8817d89586273c0cc50e187bddebb601 | 41 | image/svg+xml |
| images/icons/icons.ttf | d5f0843e95ba84f830b0a012e00272a640dff31175b122786db318fea8f87097 | 3364 | font/ttf |
| images/icons/icons.woff | a9fd3f3a92fff6743aa87e8441ae2d9b232f38230256519622d8e456c7f3d996 | 2292 | font/woff |
| images/icons/icons.woff2 | b194d2a2af64e9b032246b2d7bd9fc0c2bee28d79a48175ce7d69885f0e24363 | 1572 | font/woff2 |
| images/screenshots/1-360x640.png | 488c15bb07df4095163ab056a39c1bb06e607236b8bc26e0ada2fa468a0cfcdd | 34182 | image/png |
| images/screenshots/2-360x640.png | fc2f86213564de2106c1dd22be2576372e305b62da912036ecc421e16c0aedb8 | 15598 | image/png |
| images/touch/Airhorner-maskable.svg | 82b79d258a731f64a623d39e09921958b7ff3305bed0fef5c2a276a82d51da03 | 488 | image/svg+xml |
| images/touch/Airhorner.sketch | c56dde069040a4b3f2b0a18b79988ac1626eeaf1615cbdb8feb1a4412f191888 | 32768 | application/octet-stream |
| images/touch/android-launchericon-144-144.png | 9a7ee4ebc11eb9861bb7d96ad339f5b72b3fc9d30a8abf3d084e9f91782e4110 | 5193 | image/png |
| images/touch/android-launchericon-192-192.png | e5474fc2fb6ce9e4180b9db58da3f5bfb28fc31c8940b10ac7b9cff8a1b02267 | 6936 | image/png |
| images/touch/android-launchericon-48-48.png | fd287a7e1c98a32193e8a1608d05d89bc4fce90eeaaad480a623c16a36f7e2c0 | 1637 | image/png |
| images/touch/android-launchericon-512-512.png | 2f6f36d992d6f0daa8f8eb347704349b41f98dd1c8ea89c110a18638b555e61d | 23848 | image/png |
| images/touch/android-launchericon-72-72.png | 55600958f2eb6d6c59628b2756ecb7b1006c280c39dd9aa3f376ca3ccca7ff04 | 2612 | image/png |
| images/touch/android-launchericon-96-96.png | 9156073e12cc8c9b33bcf4aedc4f2c40e49b4aa94f9b8a6834eab60e62a1f3f0 | 3421 | image/png |
| images/touch/android-maskableicon-144-144.png | 4b85b03a078fd35ad59f92c2d4be0f27a49e9fbcb2f9a0cb4d3a6f1535ff774d | 3937 | image/png |
| images/touch/android-maskableicon-192-192.png | 4f64c65273f579045374050d3a66a3281739fea8476e7ab7e802a3f09fdd1be4 | 5535 | image/png |
| images/touch/android-maskableicon-48-48.png | 5f4c7bdfb957e34fb60a50ce7f43b3a8d7fee5b8ca09acd80a4b5a20e8c56243 | 1061 | image/png |
| images/touch/android-maskableicon-512-512.png | 597de5ac30ad40282b20774f484b702720dbf408b971668b221d864eccfc73e9 | 14100 | image/png |
| images/touch/android-maskableicon-72-72.png | 45832fd044a06ccbad97f930178d18f24003a19ac8645e0a77477972e6611cb8 | 1675 | image/png |
| images/touch/android-maskableicon-96-96.png | a9fb8fcaadced0c2d4dd503b6e80df3cad2776dd79f509496060be6a6d40c10e | 2609 | image/png |
| index.html | cf592cca2ee8bf4877ea28355ae89d4ab4a3cc64d4aa3d4e454f0d124ec9baf7 | 3586 | text/html |
| manifest.json | f1a5284468238e262eeee9c1dc847bf39a3b78b2e67bebff5ca15f9f151751c2 | 2218 | application/json |
| robots.txt | 0221ca33afda3959e81ac377e5aa591667a78ef3c314e1f29fbe53948c12e98a | 78 | text/plain |
| scripts/comlink.es6.min.js | 412047dc6a5afe2c4d546a438329dd1470b3348a946eb032a793da3a09ace7fd | 3141 | application/javascript |
| scripts/comlink.global.js | e18054a05349d6501895fe544853cd213f8ce4970660b2f9b677f78ac09cad98 | 10780 | application/javascript |
| scripts/comlink.global.min.js | c1013a3fa7c3a2e272ec70b711ff063ce2c9142399fcb0921d9d4434af75b564 | 3146 | application/javascript |
| scripts/main.min.js | 6bbe6dee7f09973ea19a41f040f4ebb436e71e2882a5aff31a4dd8c56799298e | 3627 | application/javascript |
| scripts/messagechanneladapter.global.js | d75845f92b6544c0953e2e7f0cfe1439cbc1d62fd58ab8e3bfee8258280f61ce | 3003 | application/javascript |
| scripts/pwacompat.min.js | 690d2f20cecab17573263df73a60476ef82bb17c36ef7b47f703f7290470c008 | 3458 | application/javascript |
| sounds/MP3/Air Horn Sound Effect 02 mono.mp3 | 9320190feb47f6e5ccb8bd7e2912ef9dbe9e6d27c27715c4cde50aeea6945cc6 | 40858 | audio/mpeg |
| sounds/MP3/Air Horn Sound Effect 02.mp3 | 8d32d378c429175442e8bf96179658b86e9a2f3a578c0a5fda1d7021500bc586 | 40858 | audio/mpeg |
| sounds/MP3/Air Horn Sound Effect Long mono.mp3 | a95172f9b33ed0b57cf57529246ec65b3c1184ff513284623fba874109ae8055 | 132809 | audio/mpeg |
| sounds/MP3/Air Horn Sound Effect Long.mp3 | 9726b211a8efc1c668556159781c9fd8dbbdbee44a6f56b341d3c640bc3b6d57 | 132809 | audio/mpeg |
| sounds/MP3/Air Horn Sound Effect Short mono.mp3 | 7eb880465d0bf51cdb89d0e48bf09c2a7d309614169b78a81346d37e40573b23 | 29364 | audio/mpeg |
| sounds/MP3/Air Horn Sound Effect Short.mp3 | e303e5516913f5b087bb534bb7d202c300d7403d7079b9d9c41b3d6398d4508d | 29364 | audio/mpeg |
| sounds/MP3/Air Horn Sound Effect mono.mp3 | 42615846a2e5eb9942b8c5ef62f81b796cc4eabf6063d39586eaa7a87c190b89 | 53397 | audio/mpeg |
| sounds/MP3/Air Horn Sound Effect.mp3 | 818119fc12c4862eec562a2a7c499c3aa515cdf1ac4ff74dcbd218effdd19567 | 53397 | audio/mpeg |
| sounds/WAV/Air Horn Sound Effect 02 mono.wav | 70071635ac810b7e9e22c9a7720af5eea7a91ff3fb024e7f5370c0626f946d6e | 165660 | audio/x-wav |
| sounds/WAV/Air Horn Sound Effect 02.wav | 6f4e7135c51e10fb3b4cb69032e39b95c15254ecfb3782759341fb97b4565ad8 | 165660 | audio/x-wav |
| sounds/WAV/Air Horn Sound Effect Long mono.wav | 5d89c5d35bee4ff913c95257bf51a297b9e18cf005b230ff710aa80241d66c79 | 573188 | audio/x-wav |
| sounds/WAV/Air Horn Sound Effect Long.wav | 9b3c080ef949f2de3c0a0c25d17b1ee9975417a81babd5003791b430bb8d62b8 | 570932 | audio/x-wav |
| sounds/WAV/Air Horn Sound Effect Short mono.wav | cf51c6d0355308180de9899c456417fa404265adb9c7402f0e81abc07743605c | 117172 | audio/x-wav |
| sounds/WAV/Air Horn Sound Effect Short.wav | e3c30f974b61e13bd6e735ffd90badaa633511c663c18a2c5375feaac1d1fe94 | 117172 | audio/x-wav |
| sounds/WAV/Air Horn Sound Effect mono.wav | 814fbfe2b22b7d46cf47122b4307e23c6db46062b01be1e7e4e9e5dc3ea3d080 | 219600 | audio/x-wav |
| sounds/WAV/Air Horn Sound Effect.wav | e1dbd4e016484957558daaf51e5851b233b2b5e960b0629266120c680aed57d5 | 219600 | audio/x-wav |
| sounds/airhorn.mp3 | 8d32d378c429175442e8bf96179658b86e9a2f3a578c0a5fda1d7021500bc586 | 40858 | audio/mpeg |
| styles/main.css | 49573f8efbb3052682fbddfaf1fa6ce016c5f1e594f104c9809dc870cea766ac | 1944 | text/css |
| sw.js | f0fec11cc08e51206257a00fe157e6d7b660b0158580aaa2939d5c874aa56075 | 1505 | application/javascript |

**Total: 54 files, 2909540 bytes.**
