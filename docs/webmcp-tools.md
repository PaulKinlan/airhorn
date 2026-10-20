# WebMCP tool contract

The Air Horner exposes three WebMCP tools so an in-page agent can sound the horn
through the same code path a person uses — the button's `aria-pressed` state, the
`.horning` class and the app badge all stay correct whichever way the horn was
triggered.

This page is the contract for an agent author: names, schemas, return shapes, error
semantics, annotations, availability and how to try it. Every statement here is
backed by the implementation (`src/webmcp.js`, `src/main.js`) or by a test that
fails if it stops being true. The [evidence map](#evidence-map) at the bottom is
the index: if you change the contract, change this page in the same commit, and if
a claim here has no assertion, add one or delete the claim.

The hardened semantics described below (structured refusals, rate limiting,
one-horn-at-a-time) were implemented by `airhorn-9e9`; the two suites that pin them
are `tests/webmcp.test.mjs` and `tests/webmcp-fuzz.test.mjs`.

## Availability

Registration is `registerHornTools(airhorn)` (`src/webmcp.js`). It checks for
`document.modelContext` with a callable `registerTool`:

- **Present** → the three tools are registered, each with an `AbortSignal` so the
  platform can remove them, and the call resolves to
  `{ registered: true, names: ['play_horn', 'stop_horn', 'get_horn_state'], controller }`.
- **Absent** (a browser without WebMCP, a worker, or plain Node) → a no-op that
  resolves to `{ registered: false, names: [], controller: null }`. The horn keeps
  working as a button; nothing throws.
- Aborting `controller` unregisters every tool.

The app registers on the window `load` event, after the `AirHorn` instance exists
(`src/main.js`), and ignores a registration failure
(`registerHornTools(airhorn).catch(...)`) so WebMCP can never break the horn.
Registration is sequential; `names` lists what was actually registered.

There is **no app-level flag or URL hash** for the tools: if the API exists, they are
registered. What you need is a browser that provides `document.modelContext`. In
Chromium that is behind a flag:

```bash
google-chrome --enable-features=WebMCP,WebMCPTesting \
  https://airhorner.com/
# then, from DevTools or any in-page script:
const tools = await document.modelContext.getTools();
const play = tools.find((t) => t.name === 'play_horn');
await document.modelContext.executeTool(play, { loop: true });
```

`WebMCPTesting` is what makes `getTools()`/`executeTool()` available to a script;
`tests/webmcp-browser.test.mjs` launches Chromium with exactly
`--enable-features=WebMCP,WebMCPTesting`, records whether it got the `native`
`document.modelContext` or had to install a spec-shaped `stand-in` (because the API
was absent), and asserts the same contract either way. A run on this VM
(2026-10-20) reported `source: native` on Chrome 155.

Browsers/apps that expose the API but no `document.modelContext.registerTool` are
treated as "absent" — the check is on the method, not the object
(`is a silent no-op where WebMCP is unavailable`).

## The three tools

| tool | args | success result | annotation |
| --- | --- | --- | --- |
| `play_horn` | `{ loop?: boolean }` | `{ playing: true, loop: boolean }` | `readOnlyHint: false` |
| `stop_horn` | none (any input is ignored) | `{ playing, loop: false }` — `playing` is false once the horn is silent | `readOnlyHint: false` |
| `get_horn_state` | none (any input is ignored) | `{ playing, loop, hasAudioContext }` | `readOnlyHint: true` |

`readOnlyHint` is the only annotation published: `play_horn` and `stop_horn` change
state, `get_horn_state` does not. Nothing here claims `untrustedContentHint` or a
"consequential" hint — the tools do not set one.

### `play_horn`

```json
{
  "type": "object",
  "properties": {
    "loop": {
      "type": "boolean",
      "description": "Keep the horn sounding until stop_horn is called. Defaults to false: a single blast."
    }
  },
  "additionalProperties": false
}
```

- `loop` omitted or `false` → a single blast; `loop: true` → sustains until
  `stop_horn`.
- **A call replaces anything already sounding.** The horn is one instrument: if it is
  already playing, `play_horn` stops it first and starts the new blast, so repeated
  or concurrent calls leave exactly one playback running.
- **Calls are rate limited** to 20 admitted starts per rolling 1000 ms
  (`DEFAULT_RATE_LIMIT`). Beyond that the call is refused with `rate_limited` and
  nothing changes.
- **Starts are serialised** and **bounded**: if a start has not reported back within
  5000 ms (`DEFAULT_START_TIMEOUT_MS`) the call is abandoned *and* the horn is
  stopped, so a stuck audio graph cannot leave a delayed blast or wedge the tool.
- Returns `{ playing: true, loop }` only when this call actually started the horn.
  Otherwise it returns a [refusal](#refusals).

### `stop_horn`

Takes no arguments and returns `{ playing, loop: false }`; `playing` is false once the horn is
silent (it is read back from the horn, not assumed).

It is **always honoured**: it is not queued behind a start, not rate limited, not
cancelled by an aborted call, and not argument-validated — a malformed call still
silences the horn. That is deliberate: silence must be possible no matter what the
caller sent, and `stop_horn` is safe to call when nothing is playing.

### `get_horn_state`

Takes no arguments and returns `{ playing, loop, hasAudioContext }` for the current
instance: `playing` is "is anything sounding right now", `loop` is "is it sustaining"
(`isLooping() && isPlaying()` on the app side), `hasAudioContext` is "can this browser
make sound at all". It is read-only, side-effect free, and answers whatever the caller
sends. If the horn instance itself is broken (an accessor throws), it still resolves,
adding `code: "internal"` and an `error` string so the values are not mistaken for a
healthy state.

## Results, refusals and rejections

**Every call resolves.** A caller that sends nonsense gets a structured refusal, never
an unhandled rejection. The shape is the horn's current state plus a code and a
message:

```json
{ "playing": false, "loop": false, "code": "invalid_input",
  "error": "play_horn: \"loop\" must be a boolean, received a string. Nothing was started." }
```

`playing` and `loop` in a refusal are the horn **as it is right now**, so a refusal can
report `playing: true` — the horn is sounding because of an earlier call; this call
changed nothing. Treat the presence of `code` as the refusal and `playing` as the
current state.

Error messages name the type that was received and **never echo the payload** — a
megabyte of hostile input comes back as a short message, not as a megabyte of echo.

| code | when | what changed |
| --- | --- | --- |
| `invalid_input` | `play_horn` got an `input` that is not an object (a string, number, boolean, array, function), or a `loop` that is present and not a boolean | nothing |
| `rate_limited` | more than 20 admitted starts in the last 1000 ms | nothing |
| `audio_unavailable` | the browser has no Web Audio, so the horn cannot sound | nothing |
| `not_started` | audio is blocked, or a `stop_horn` arrived before the start completed | nothing is playing |
| `timeout` | the start did not report back within the start timeout (5 s by default) | the abandoned start is stopped |
| `internal` | an unexpected failure in the horn, or an unreadable state in `get_horn_state` | nothing guaranteed |

Two behaviours are worth calling out because they are choices, not accidents:

- **Input is validated, never coerced.** `loop: "true"` is *refused*, not treated as
  `false`: an agent that asked for a looping horn must not be told it got one.
- **Extra properties are ignored, not rejected.** `additionalProperties: false` is
  published in the schema, but a caller that sends `{ loop: false, volume: 11 }` gets a
  normal single blast — unknown keys cannot change behaviour and cannot pollute
  prototypes.

The **only** way a call rejects is cancellation: an aborted `AbortSignal` rejects with
`AbortError` (or the signal's own `Error` reason). A call cancelled mid-start is
silenced first, so cancellation cannot leave a looping horn behind.

## Invariants a caller can rely on

- **One horn.** Concurrent and repeated `play_horn` calls never stack playback
  (asserted with a 60-call flood and an interleaved play/stop/state storm).
- **Bounded resources.** Fuzzing the real `Horn` through the tools creates exactly one
  `AudioContext`, fetches the sample once, and leaves no surviving buffer sources or
  oscillators after `stop_horn`.
- **Silence wins.** `stop_horn` resolves and silences even when its own call is
  aborted, even while a start is in flight, and whatever its arguments.

## Evidence map

Every claim above, and the code or test that pins it. Test names are the `node --test`
case names.

| claim | evidence |
| --- | --- |
| the tools drive the same code path as the button (pressed state, `.horning`, app badge) | browser suite: `play_horn` / `stop_horn` sections assert `aria-pressed`, `horning` and the badge calls |
| three tools, in this order, with schemas and annotations | code: `createHornTools` in `src/webmcp.js`; tests: `registers play_horn, stop_horn and get_horn_state when modelContext exists`, `annotations describe which tools mutate state`, `the published schemas and descriptions match what the tools actually do` |
| `loop` defaults to a single blast | `play_horn defaults to a single, non-looping blast`, `missing arguments are a single, non-looping blast`; browser suite's "single blast" section |
| `play_horn` replaces whatever is sounding | `repeated accepted calls supersede each other rather than accumulating`, `a concurrent flood never stacks playback and every call resolves` |
| 20 starts per 1000 ms, and refusals report the current state | `the shipped defaults are the documented ones: 20 starts per second` |
| start timeout abandons **and** silences | `a start that never settles times out as a structured error and is silenced` |
| input validated, not coerced; type named, payload never echoed | `play_horn refuses wrong-typed input with a structured error instead of coercing it`, `a hostile megabyte payload is refused quickly and never echoed back` |
| extra properties ignored, no prototype pollution | `a huge argument object with a valid loop flag is a safe no-op on the extra data`, `unknown properties and prototype-shaped keys cannot change behaviour or pollute` |
| `stop_horn` always silences | `stop_horn silences the horn whatever the caller sends, and state is always readable`, `stop_horn is never rate limited and answers immediately during a play flood`, `stop_horn still silences the horn when its own call is aborted` |
| `stop_horn`/`get_horn_state` take no arguments | `stop_horn and get_horn_state ignore extra properties`, `the published schemas and descriptions match what the tools actually do` |
| `get_horn_state` shape, and its degraded shape | `stop_horn silences the horn whatever the caller sends, and state is always readable`, `a broken horn instance yields structured errors, never rejections` |
| `audio_unavailable` / `not_started` | `reports a structured error instead of throwing without Web Audio`, `invocation before the audio graph is ready still resolves` |
| only cancellation rejects; cancelled mid-start is silenced | `honours a cancelled execution signal`, `an aborted call rejects and never starts the horn`, `a call cancelled mid-start is silenced instead of left looping` |
| no leaks (one `AudioContext`, one fetch, no surviving nodes) | `fuzzing the real Horn leaks no AudioContext, buffer sources or oscillators` |
| no-op and no-throw without the API; abort unregisters | `is a silent no-op where WebMCP is unavailable`, `aborting the registration controller unregisters every tool` |
| the flag and the native/stand-in distinction | `tests/webmcp-browser.test.mjs` (launch args `--enable-features=WebMCP,WebMCPTesting`, logs `source`) |
| registration on `load`, failure ignored | code: `src/main.js` load handler |

## Not claimed

- No `outputSchema` is published; the result shapes above are documentation, not
  machine-readable schema.
- No authentication or origin check: anything running in the page can call the tools.
  They are no more privileged than the page itself.
- The tools do not chain audio or read microphone input; the only state is on/off and
  looping.
- Exact browser versions are not promised — the browser suite records which Chromium
  it ran on, and falls back to a spec-shaped stand-in if `document.modelContext` is
  absent (in which case it is exercising the tool code, not the browser's own
  WebMCP implementation).
