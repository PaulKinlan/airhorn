# Coverage map - the reasons behind the rows

The table of record is tools/suite-map.tsv (one line per row; the union driver merges it
mechanically). This file carries the PROSE: the reason, the incident ids, and the cost
decision for each non-obvious row. Sections are keyed by the row pattern they explain.

## `tools/lib/static-server.mjs`

The implementation needs its OWN row even though the suite-facing re-export
(`tests/support/static-server.mjs`) already carries `@importers` (airhorn-0s4v). The scan
behind `@importers` reads the SUITE files for a reference to the module it is asked about:
the browser suites import `./support/static-server.mjs`, never `tools/lib/static-server.mjs`,
so an `@importers` row on the implementation would derive nothing (or, today, only
tests/test-support.test.js, which imports it directly). One hop through a re-export is
invisible to the scanner, so the three suites that actually drive this server are named here
explicitly. Drift risk is real and accepted for one file: if a fourth suite starts serving
dist/ through `tests/support/static-server.mjs`, it is covered for changes to the RE-EXPORT and
not for changes to the implementation - extend this row when that happens. `tools/lib/**`
still selects tests/test-support.test.js, and rows are additive, so the union is what runs.

## About this map (file header)

tools/suite-map.tsv — the changed-path -> suite map. THE MAP IS THE GATE.
Format: <glob pattern><TAB><space-separated suites covering it>. Rows are ADDITIVE: name EVERY suite
that covers a file. (The singular test/ spellings were removed in airhorn-92mp: they came from a
side branch's layout, test/ never existed on any tracked ref, and the tokens sat behind pending
self-rows doing nothing - vestigial, so gone. If a tree ever carries test/ again, re-add the
spellings THEN, with the pending rows.) Lines starting with # are comments. `!` rows are exemptions (files with no suite) — add one
only with a reason. `~` rows are PENDING suites: declared, possibly arriving with a sibling branch;
while the suite file is absent, selecting it SKIPS with 'fast-gate: pending:' instead of failing,
and once it lands it runs like any other suite. A PLAIN row naming a missing suite is a stale map
and fails the gate. A SUITE NEEDS NO ROW: it maps to itself, so a change to tests/x.test.mjs runs
tests/x.test.mjs (the gate's selection does that for every tests/|test/*.test.{js,mjs,ts} spelling,
at any depth) - airhorn-xh81. The map only places suites over OTHER files. A changed non-suite file
with no row is still 'unmapped:' and fails, and a selection that runs nothing still fails, so the
loud direction is the same as it always was.
CONFLICT HERE? Do not hand-merge it (airhorn-tp3g, airhorn-fp5q). The map is a SET the gate unions at run
time, so a collision is resolved by key, mechanically - and the merge BASE goes in as the third file so a
row, comment or blank line one side DELETED stays deleted (airhorn-famo):
  git show :1:tools/suite-map.tsv > /tmp/base.tsv; git show :2:tools/suite-map.tsv > /tmp/ours.tsv; git show :3:tools/suite-map.tsv > /tmp/theirs.tsv
  node tools/merge-suite-map.mjs --union /tmp/ours.tsv /tmp/theirs.tsv /tmp/base.tsv --write tools/suite-map.tsv
  node tools/derive-coverage-contract.mjs   # the contract is DERIVED: regenerate it, never merge it
  git add tools/suite-map.tsv .fleet/coverage-contract.json   # or the merge cannot continue (airhorn-nn8g)
With the base the merge is ordinary THREE-WAY: removed on one side and untouched on the other is a
deletion and is respected; removed on one side and CHANGED on the other is refused by name. Without a base
nothing can tell an addition from a deletion, so the tool keeps one-side-only rows (and reports them), and
REFUSES a one-side-only SELF-ROW outright - keeping one was how 47 deleted self-rows came back (airhorn-xh81).
The one thing still over-approximated is a TOKEN inside a row both sides keep: an extra suite costs gate time
and can never false-green, and the report names every restored token.
tools/gate.conf's SUITE_TIERS block has the SAME treatment (airhorn-09dr): union with
  node tools/merge-suite-map.mjs --tiers-union /tmp/ours.conf /tmp/theirs.conf --write tools/gate.conf
`git config merge.suite-map-union.driver "node tools/merge-suite-map.mjs --driver %O %A %B"` makes git do the
union for you (.gitattributes has the entry); the tool refuses a disagreement by name instead of choosing.
A row that names ONLY ITSELF (`tests/x.test.mjs -> tests/x.test.mjs`) used to exist to satisfy the
reverse check; since airhorn-xh81 it is a TAUTOLOGY and 47 of them were deleted from the map (the
CSP-era rows included). Do not
add one: the self-mapping is implicit. The single exception is `tests/acceptance.mjs`, whose row stays
because it is not spelled `*.test.*` - the row is what makes it a suite at all, and it is
explicit-only by design (airhorn-i8i, airhorn-w1ow). Such a row is deliberately NOT restated in
.fleet/coverage-contract.json - the oracle skips self-rows, so naming one there reads as "the
contract places this path, the map does not" and fails tests/gate-smoke.test.js (airhorn-x4l).
A doc section whose row disappeared with airhorn-xh81 stays here: it is the record of why that suite
exists, which is still the question a reader arrives with.

`@importers` ROWS (airhorn-ooqm). A shared test helper's suite set is not a list to keep by hand: it
had drifted six times (5t8, ckq, dco, 906, ooqm) because a helper gains a caller and the row keeps its
snapshot, so a change every caller depends on is gated by two suites. A row may therefore say
`@importers` instead of naming suites, and the set is DERIVED AT RUN TIME from every file that
REFERENCES the module - import-shape-agnostic (static from/import, require(), dynamic import(), a
template literal, a computed path.join(dir, 'x.mjs')), because all five shapes are already in this
tree. A new importer is therefore covered with no map edit. `except=<file>` keeps a suite off such a
row deliberately: tests/acceptance.mjs is the explicit-only whole-product pass (airhorn-i8i), and the
tests assert the derived count equals the true reference count (13 for cdp-command-bound.mjs) while
the gate selects that set minus the excepted one (12). The scan lives in
tools/derive-coverage-contract.mjs (`--importers`), so the gate and .fleet/coverage-contract.json
cannot disagree; the contract still has to be re-derived (one command) when the set changes, which
`node tools/derive-coverage-contract.mjs --check` and tests/gate-map.test.js fail loudly on.

## `src/main.js`

THE SPLIT (airhorn-1l04). src/main.js is a composition root now; each concern lives in its own
module and carries the suites that would catch a regression IN THAT CONCERN. The rows below are
the honest owners, which is the whole point: a badge change runs two suites instead of eight.

src/main.js itself is deliberately narrow, and it is the one row where that is a COST decision
rather than a coverage opinion - the same trade as index.html's sw-failover exclusion above.
tests/modules.test.js pins the wiring at the source: every binder is called, with the target and
handles main.js must pass, and no behaviour may creep back in (a regression that drops or
mis-addresses a binding fails there, in ~0.1s, with no browser). What structure cannot see is the
runtime composition contract - the boot marker the watchdog depends on (resilience-ui) and the
WebMCP registration this module performs (webmcp-browser) - so those two run here. Everything
else main.js does is call a module, and that module's row owns the behaviour.

## `src/airhorn.js`

The horn's state (press/release, the pressed claim and its retraction, the tap hint) is asserted
by every suite that says the app works, because it IS the app: a broken pressed state is a broken
page. This row is therefore wide on purpose and is the honest answer, not a leftover - the win of
the split is that a change to a CONCERN no longer lands here. multitab is deliberately absent,
exactly as it is on every other source row: the per-file suites already assert pressed-state
honesty, and its cross-tab story is badge.js's to own (see that row).

## `src/input.js`

Pointer + keyboard semantics (P0 airhorn-slmt / airhorn-ay73). The suites that press the horn with
REAL input events and assert what a hold does: horn.test.js pins the right-click and release
guards, keyboard the hold/Escape/blur retire, screenreader the AX state while held, a11y and
visual-overrides the keyboard path, reflow-zoom the pointer press.

## `src/badge.js`

The badge is app-wide state across tabs, and multitab is its only owner: it asserts the shared
total (4 blasts in two tabs read 4), the fresh-tab derive and the acknowledge-on-look. Nothing
else in the tree tests those, which is why multitab is named here and on no other source row.
webmcp-browser asserts the other entry point - a tool call badges with a real number.

## `src/install.js`

The install affordance: a11y asserts the accepted/cancelled announcement through the app's one
voice, keyboard the focus restoration, resilience-ui the blocked-CSS honest control, reflow-zoom
that the affordance stays on-screen and topmost.

## `src/launch.js`

Deep links and launches: shortcuts is THE #instant suite (load, hashchange, the launch-queue
repeat press and the cold-launch dedupe), multitab asserts the launch-time badge acknowledge.

## `src/status.js`

The connection notice. Five suites each assert the same copy in their own scenario: screenreader
through the AX tree, keyboard through the offline flip without a focus move, multitab once per
open tab, resilience-ui on drop/restore, visual-overrides that the caption tier actually paints.

## `src/analytics.js`

gtag is only present when a page loads the analytics snippet, and no browser suite asserts an
analytics call. tests/modules.test.js unit-tests trackEvent in both directions instead.

## `index.html`

sw-failover is NOT on the index.html row (airhorn-iwf): it is the worker's
end-to-end failure story (public/sw.js: lie-fi, quota-denied upgrade), the page's
markup is already asserted by horn, a11y and resilience-ui, and putting the
14s SW-update suite on the most frequently edited file left a worst-case fast
gate at ~60s with no headroom. Since the split it is not on a src/ row either,
because no page module owns worker code - the registration handler lived in
index.html and now lives in public/sw-register.js (airhorn-xnd1), and
resilience-ui asserts the copy that handler authors.

The page DOES author one thing sw-failover asserted - the lost-upgrade
announcement, in the registration handler next to #app-status (public/
sw-register.js since airhorn-xnd1) - so leaving it to sw-failover made a one-line
edit to that branch green on this row and red only in a suite the row no longer
selected (airhorn-906).
resilience-ui, which runs here, now asserts that branch itself (case 11), so
dropping sw-failover from this row does not drop its coverage. Keep it that
way: move the branch, or add a suite - never a comment claiming a suite you
stopped running covers it.

## `server.ts`

server.ts (dev server, TypeScript outside the bundle graph) is covered by the
tools smoke suite's esbuild parse (airhorn-1ye) and by the health suite, which
drives the real deno server's /health endpoint on an ephemeral port (airhorn-uexx).

## `deno.lock`

deno.lock pins what the deno server imports (jsr:@std/http, the serveDir dep);
the suite that actually boots the server under deno is its honest coverage.

## `tools/*`

tools/* is covered by a REAL smoke suite: the gate's own selection contract
plus syntax checks of the scripts it names (airhorn-1ye).

## `tools/guarded-call.mjs`

tools/guarded-call.mjs turns "the suite really calls the tested enforcer, and
nothing can swallow its throw" into a question about the syntax tree
(airhorn-6829). Its hostile worlds - deleted, commented, stringified, shadowed,
conditional, try/catch and .catch() - are pinned by its own browser-free unit
suite, on top of the tools/* row above. Selected: no browser suites.

## `tools/audio-parity.mjs`

The audio-parity measurement rules (pitch verdict, band, candidate distance) are proven
browser-free by their own suite, so a change to the decision selects it as well
(airhorn-nxuv.3): the tool needs Chrome, the RULE does not.

## `tools/cache-growth.mjs`

The two tools that drive a browser for minutes and are SIGTERMed by the gate's
bound: their handler is behaviour, so a change to either runs the guard that
kills them mid-run and checks the tree is empty afterwards (airhorn-aaxm,
airhorn-cyga). ~0.5 s for both tools.

## `tools/derive-coverage-contract.mjs`

tools/derive-coverage-contract.mjs is covered by its own unit suite as well
as the tools/* gate-smoke check (airhorn-1qw6).

## `tools/landings.mjs`

tools/landings.mjs answers "was this landing gated?" from the merge commit record instead of the
pruned verdict cache (airhorn-32wa, ADR 0002). Its parse/classify rules and its git walk are pinned
by their own hermetic suite - the fixtures are message shapes real history contains, and the read
path runs against a throwaway repo, so a change to either rule selects the suite that can fail.

## `tools/mutation-check.mjs`

tools/mutation-check.mjs is the guard every sweep's mutation step runs through, so its
own behaviour (does the --from apply? did the write land? is the target product code?) is
covered by its own unit suite, which needs no map row now that a suite maps to itself (airhorn-f41e,
airhorn-xh81).

## `tools/lib/suite-mode-reporter.mjs`

The reporter decides whether a TEST failed or the file did, so a change to it is gated on the
suite that exercises the container, same-name collision and spelling worlds (airhorn-u1v2).

## `tools/lib/**`

tools/lib/** is the shared runtime the tools import (reap.mjs is the profile
marker sweep). It is NOT matched by `tools/*`, which does not cross a slash, so
a change to it used to select zero suites - a shared helper with no owner.
tests/test-support.test.js drives it directly (marker hit and marker miss).

## `tools/lib/update-outcome.mjs`

The update-outcome rule (airhorn-nxuv.6): a rejected reg.update() must fail the audit as
itself, so a change to the rule is gated on the suite that proves all three outcomes.

## `tools/install-https-proof.mjs`

The two tools whose LAUNCH behaviour has its own regression guard (a refused launch must leave
no profile; a browser that cannot start must fail the audit) are driven by test-support, on
top of the gate-smoke row every tools/* file already selects (airhorn-w1wh review).

## `public/sw.js`

The SW/offline suite covers the PWA surface (it verifies sw caching + manifest contents in dist)
AND the worker's cache-integrity behaviour (a corrupt entry must be evicted and healed, never
served - airhorn-un5; merged into it in airhorn-iwf so one worker change pays one Chromium launch,
not two). It is gated on the worker itself - not on index.html, whose markup the a11y suite
already covers, because that would double the gate on the most frequently edited file for no
extra signal.

## `public/styles/**`

The stylesheet is behaviour, not decoration: the a11y suite pins computed
styles and the horn's >=3:1 boundary ring, the keyboard suite asserts the
focus rings it paints are a visible 3:1 indicator (airhorn-bjk1), and
visual-overrides (airhorn-1jrc) pins forced-colors and reduced-motion;
reflow-zoom (airhorn-xaxg) pins no horizontal overflow at 320px / 200% text,
horn pressability, and reachable affordances. Leaving public/styles/** to
the !public/** exemption meant a focus-ring change landed with zero coverage.

## `public/csp files`

The three files that used to be inline in index.html (airhorn-xnd1, decision airhorn-ao23):
boot-watchdog.js, sw-register.js and async-css.js. They are mapped by BEHAVIOUR, not by
proximity to the page - shipping one of them broken is what the CSP makes possible, because
a blocked inline handler or script fails silently.

- resilience-ui drives all three in a browser: the watchdog's banner, grace and late-retire
  (cases 1, 2, 3, 8, 9), the registration and lost-upgrade notices (cases 6, 10, 11), and the
  blocked-stylesheet fallback (case 7). It reads the watchdog's grace constant out of
  dist/boot-watchdog.js rather than a copy.
- csp.test.js is the browser-free artifact pin: the document has no inline script and no on*
  attribute, the loader is the script immediately after the link, the three files exist in the
  build, and the worker precaches each with a build digest.
- csp-enforced.test.mjs serves dist/ with the shipped _headers applied and proves the page
  boots under the enforced policy - sheet swapped and applying, horn decoding, zero
  violations, an inline-script probe refused by name, the watchdog revealing on a blocked
  bundle, and (the negative control) a loader that never swaps leaving media at print.

index.html keeps csp.test.js (the document-level facts) rather than the browser suite: the
page row is the most frequently edited one, and the behaviour it can break is the loader's
ordering, which the browser-free pin already asserts.

## `.fleet/coverage-contract.json`

It is derived from this file via tools/derive-coverage-contract.mjs
for the fleet's independent coverage oracle, which cannot read this tsv (airhorn-pwe, airhorn-y7mx).
The two are kept in step by tests/gate-smoke.test.js, which requires the committed contract
to be identical to the generated output.

## `tests/gate-map.test.js`

The fast half's own coverage is now implicit (airhorn-gkqu, airhorn-xh81): the suite maps to itself, so
a change to it runs it, and its row is gone. It also carries the pin that no OTHER row in the map names
only itself.

## `tests/lost-upgrade-copy.test.mjs`

The lost-upgrade enforcer is pure: its own test runs browser-free on changes
to itself or its support module (airhorn-6829).

## `tests/nav-guard.test.mjs`

The navigation guard's failure paths, browser-free (airhorn-xl1t): a change to the
test must run it, and the suite that uses the guard is on the support row below.
Cost: ~3s and no browser - it is on the support row, so every support/** change
pays it (paid deliberately: the guard's fail-open case is unreachable from a
browser, so nothing else can gate it).

## `tests/health.test.mjs`

health (airhorn-uexx) spawns the real deno server; PORT=0 keeps it off any fixed port.

## `tests/multitab.test.mjs`

multitab (airhorn-dae) is deliberately NOT on the behaviour-wide source rows: it
is the whole-app two-tab coherence story (two Chromium tabs + an SW update), ~10s,
and putting it on index.html or src/airhorn.js would re-pay that on the
most-edited files for signal the per-file suites already carry - the same
cost decision as keeping sw-failover off index.html (airhorn-iwf). A change
to the suite runs the suite; the cross-tab assertions travel with it.
It IS on src/badge.js (airhorn-1l04), which is the exception that proves the
rule: nothing else in the tree asserts the shared cross-tab count, so leaving it
off there would have left that module ungated rather than cheaper.

## `tests/modules.test.js`

The split's structural suite (airhorn-1l04): the module graph, the composition
root's wiring, and the exported entry points. Browser-free, ~0.1s, and named on
every module row so the split's shape cannot rot back into one module.

## `README.md`

The README's Deno recipe is documented BEHAVIOUR, not prose: tests/docs-recipe.test.mjs
runs the exact command README.md prints, so a permission server.ts grows (or a flag the
docs lose) turns the gate red instead of shipping inert instructions (airhorn-x86p).
Prose is still exempt below; this prose is the operator's command line.

## `docs/runbooks/DEPLOY.md`

The same holds for the deployment runbook after airhorn-alze moved it under
docs/runbooks/: it carries the STAMPED `deno run ... server.ts` recipe that
tests/docs-recipe.test.mjs executes, so a change to it must run that suite rather
than fall through to the `!*.md` exemption below (a row always beats an exemption).

## `docs/webmcp-tools.md`

The webmcp evidence map cites node --test case names; a rename in a suite leaves the doc naming a case that no
longer exists (airhorn-5t0y). The drift is doc-vs-suite text, which only a text check can see - see ADR 0001 for
why that is a doc pin, not a claim about behaviour.

## `docs/runbooks/**`

Every other runbook too: the suite also asserts that a fenced recipe does not
name a repo path that does not exist, which is what airhorn-alze's move broke in
two recipes (airhorn-2jwe, airhorn-fs8s). Static, ~5 ms.

## `!*.md`

Static assets and prose carry no behaviour; no suite covers them.

## `!preview/**`

Generated preview-evidence artifacts (screenshots, captured JSON) carry no
behaviour; no suite covers them (airhorn-8uu, airhorn-c4n). The map carried this
row twice, so the move produced two sections with the same text; the rows are
deduped and the sections merged (airhorn-zd9g) - the union driver treated the
duplicate as a set anyway, so the gate's selection is unchanged.

## `tests/acceptance.mjs`

The whole-product acceptance pass (npm run test:acceptance) launches its own browser and
drives the built app end to end; it is deliberately explicit-only, so it is **not** mapped to
sources - that would run it on nearly every change (airhorn-i8i). But it must be gated when the
pass *itself* changes: exempting the file entirely left edits to it with no coverage at all
("0 suite(s), all exempt" - airhorn-up2), which is how the fallback item got in unseen.

## `tests/support/browser.mjs`

Shared browser-test support code (the quiescence probe, the gate's report hook) is imported
by suites, not a suite itself, so exempting it left a hole: a change to *only*
tests/support/** ran zero suites and the gate still reported PASS. Map it to EVERY suite
that runs through the hook - the runner injects it into every script-tier (.mjs) suite, so
the row must track that set, not a snapshot of it (airhorn-5t8: resilience-ui and
sw-failover were missing; airhorn-10q for quiescence.mjs, airhorn-n00 for the report hook).
The support modules' own failure paths are unit-provable without a headless browser: a
stub CHROME_BIN plus a real silent DevTools peer for the launcher (airhorn-4yhb), and a
stand-in process for the shared bound-kill handler (airhorn-4vfn). Mapped specifically so
that a change to either module runs its own suite as well as the nine suites that launch
through them, and so the suite runs when it is the only thing that changed.

## `tests/support/report-hook.mjs`

Per-module rows, DERIVED (airhorn-x3f1): the generic tests/support/** row charged
ALL 20 suites - 12 of them serial browser passes - for a one-line change to a pure
helper like poll.mjs, which only 7 suites import. Each module now names @importers,
so a helper's change runs exactly its importers and a NEW support module with no row still fails loudly
- as `fast-gate: unmapped:` on the change that touches it, since a support module is a changed path
with no row rather than a suite (airhorn-xh81).
report-hook.mjs is the one exception: it is RUNNER-INJECTED (node --import) into
every script-tier suite, no file imports it, so @importers would see nothing.
Its row lists the script tier explicitly - and tests/gate-map.test.js's airhorn-dco
pin derives that exact set from the tree per run, so drift fails loudly there.

## `public/_headers`

Cloudflare Pages hosting (airhorn-9dal, fleet-fpr18). The site is a static Vite build, so the
hosting config and its deploy workflow are pinned by one browser-free suite: it asserts the config
is minimal and points at dist/, that the workflow carries the two secrets by name, and it RUNS the
workflow's credential guard to prove the no-secret path fails by name before anything is built.

The CSP ships here too (airhorn-xnd1), so two more suites are on the row: csp.test.js pins the
policy directive by directive, the /* all-paths pattern it lives under, and the style hash against
the SERVED document; csp-enforced.test.mjs proves a browser enforces it. pages-config stays the
owner of the five no-risk headers and the deploy path - one owner per fact.

Since airhorn-yxxq the file is also SERVED: tests/csp-boot.test.mjs drives dist/ through the
shared static server (tools/lib/static-server.mjs, the tools/lib/** row; re-exported at
tests/support/static-server.mjs, @importers) with headers: 'auto' applying this very file, and
asserts the page boots under the policy - the difference between "the file says nosniff" and
"the page still boots when the server sends it".
