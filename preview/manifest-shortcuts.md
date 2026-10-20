# Manifest shortcut verification (`/#instant`)

`public/manifest.json` advertises one shortcut: **Instant Blast** → `/#instant`
(`scope: /`, `launch_handler.client_mode: focus-existing`). The promise is that the
deep link loads the app, sounds the horn immediately, and leaves a URL worth sharing.
This file records what was measured, with the exact URL and the observed behaviour.

Reproduce: `npm run build && node tests/shortcuts.test.mjs` — the suite is the
executable form of this table (it fails if any row stops holding).

Measured on 2026-10-20 in headless Chromium 155 on this VM, served from `dist/` by a
local static server. Audio is measured, not inferred: an injected probe reroutes every
`connect()` aimed at the `AudioContext` destination through a pass-through analyser
(`node -> analyser -> destination`), so **peak** is the signal at the destination's
input — after the app's own gain stage — and **ctx** is the browser's own
`AudioContext.state`.

That tap position is itself checked, both ways, before anything is trusted: a graph
muted to zero at the output must measure `peak 0`, and the same graph at unity must
measure `peak > 0.3` (`checkProbeIntegrity`). With the earlier tap on the *source's*
output the muted control measured 0.7 and the check failed — an upstream tap cannot
tell a blasting app from a muted one (review finding `airhorn-aos`).

## The promise, in the context it is made

Launching an installed app from its shortcut is a user gesture, so the "it blasts"
cases run with `--autoplay-policy=no-user-gesture-required`.

| URL | expected | observed | verdict |
| --- | --- | --- | --- |
| `/#instant`, cold load | loads, blasts, keeps the hash | booted, `aria-pressed=true`, `.horning`, `starts=1`, **peak 0.678**, ctx `running`, hash still `#instant` | ✅ |
| the same URL reloaded | blasts again (it is shareable) | `starts=1` in the new document, **peak 0.678**, lit | ✅ |
| the same URL navigated to again | no second blast | `starts` unchanged, `aria-pressed=false`, nothing playing | ✅ (see finding 1) |
| `/#nonsense` | loads, does nothing | booted, `starts=0`, `aria-pressed=false`; a press afterwards plays (**peak 0.678**) | ✅ |
| `/#instant` then `/` | no stray blast, no stuck UI | new document, `starts=0`, `aria-pressed=false`; a press afterwards plays | ✅ |
| `/#instant`, offline (cold) | worker serves the shell and the sample | `onLine=false`, `controlled=true`, booted, `starts=1`, **peak 0.678**, `usingFallback=false` (real mp3 from the precache) | ✅ |
| `/#nonsense`, offline | loads, does nothing, horn still works | booted, `starts=0`, at rest; a press afterwards plays (**peak 0.678**) | ✅ |
| in-app `location.hash='#instant'` | blasts (a link inside the app works) | `starts=1`, playing | ✅ |

## The same deep link in an ordinary tab

Chrome refuses to start audio without a gesture. A shared `/#instant` link pasted into
a tab cannot blast — and the only thing that would make that a defect is the page
claiming otherwise.

| observation | before the fix | after the fix |
| --- | --- | --- |
| `aria-pressed` / `.horning` | `true` / present | `false` / absent |
| `__airhorn.isPlaying()` | `true` | `false` |
| `AudioContext.state` | `suspended` | `suspended` |
| sources scheduled | **1** (a delayed blast waiting for the next gesture anywhere on the page) | **0** |
| measured peak | 0.000 (silent) | 0.000 (silent) |
| first real press afterwards | plays (peak 0.678) — but the page had been lying until then | plays (peak 0.678) |

The two changes behind the right-hand column are small and both in the start path:

- `src/horn.js` — `Horn.start()` returns `false` when the context is still
  `suspended` after the resume attempt, instead of scheduling a source into a graph
  that cannot run. That removes the delayed blast as well as the false report.
- `src/main.js` — `AirHorn.start()` keeps its optimistic pressed state (a press must
  feel instant) but takes it back when the start resolves `false` and nothing is
  playing.

Because the WebMCP `play_horn` tool goes through the same `AirHorn.start()`, a blocked
context now yields its documented `not_started` refusal (`{playing: false, code:
"not_started"}`) rather than `{playing: true}` while silent.

## Findings this produced (not defects of the shortcut itself)

1. **A repeat launch does nothing.** With `launch_handler.client_mode:
   focus-existing`, launching the shortcut while a window is already on `/#instant`
   reuses that window and navigates it to the URL it is already on, which is a no-op:
   no load, no `hashchange`, no blast (`starts` unchanged, horn at rest). One blast
   per document. Options: accept and document, or `client_mode: navigate-existing`
   (re-navigates the existing window — behaviour for an identical URL still needs
   measuring), or drop `launch_handler` so every launch opens a fresh window.
2. **No affordance when audio is blocked.** The page is now honest but silent; it
   does not tell the user to touch the horn. A one-line visible hint (or an
   announcement when a start is refused for `suspended`) would turn a dead-feeling
   deep link into an obvious one.
