# The trust boundary between `mutation-check` and the code under test

`mutation-check` decides whether a suite catches a mutant. That verdict is worth exactly as much as
the channel it is derived from, so this document enumerates **every channel the code under test can
reach** and says what a forged value on it can and cannot achieve. It exists to stop the next round
of "add a secret" fixes: measured on this harness, a secret is not a boundary (airhorn-dzsi,
airhorn-w488).

Design: airhorn-14ht. Superseded: the single-process driver whose records travelled on the suite's own
stdout (forged on `fleet/812k-guard`: one forged `yieldedToHarness` line plus `process.abort()` scored
`verdict: mutant-caught`, rc 0).

## The shape

```
mutation-check  --fd3 pipe-->  DRIVER (supervisor, test file for the outer runner)
                                    |
                                    |-- stdout/stderr: QUOTED with "  | " before it is re-emitted
                                    |-- fd 3 of the child runner: structured facts (counters)
                                    v
                               child runner  --->  worker process  --->  the suite
```

* The **supervisor** writes every `MUTATION-DRIVER-RECORD` line. It is a different process from the
  suite, and the suite has no handle on the stream it writes to.
* Every byte the suite emits is **quoted** (`  | ` at the start of each line) before it reaches the
  stream the reporter reads records from, so a record-shaped line printed by the suite is **data**.
* The **facts** (did the suite load, did a test start, did one fail) come from the child runner's
  reporter over **fd 3 of the child runner** — a pipe the supervisor owns and the suite's worker does
  not inherit.

## Channel enumeration

| channel | reachable by the suite? | measurement | what a forged value achieves |
|---|---|---|---|
| the RECORD stream (supervisor records) | yes (it can print the shape) | trivially | **nothing**: every line the child emits is quoted by the supervisor before it reaches the record stream; a record shape arrives as data (pinned by *"a record line written by the code under test is INERT"*) |
| the EVENT stream (node's runner counting tests) | **YES - and this is forgeable** | measured: a suite writing v8-serializer `test:start`/`test:fail` frames on its own stdout scores `verdict: mutant-caught` rc 0 with no test ever asserting about the mutant (airhorn-yvwo / airhorn-86wl). node's runner reads test events as frames on the **worker's** stdout, and the suite runs in that worker | a FALSE CATCH: the suite can state that a test failed when none did. This is the same class as a suite whose assertions lie, and it is **not** authenticated by anything in this harness - the worker always owns the frame channel. The answer is corroboration: `--suite-old` runs the same suite against the ORIGINAL file, where a forgery fires too, so it cannot prove a hole |
| its environment (`process.env`) | yes | a suite dumping it sees `NODE_TEST_*` and the run's `MUTATION_*` values | **nothing**: nothing is decided from the environment. The nonce in `MUTATION_RUN_NONCE` only labels the supervisor→parent line; the suite cannot write that line |
| its **exec-time** environment (`/proc/self/environ`) | yes | reviewer proof on 471b2ab1 + reproduced here: a suite read `MUTATION_RUN_NONCE` and `MUTATION_SUITE_CHANNEL` out of proc **after** `process.env` was scrubbed | **nothing any more**: knowing the nonce and the fd number buys no write access (next row). This is why no design here may rest on an environment secret |
| the facts pipe (child runner fd 3) | **no** | a suite writing to `Number(process.env.MUTATION_SUITE_CHANNEL)` dies `EINVAL` — the worker does not inherit the runner's extra fds | the whole design rests here: verdict facts cannot be stated by the code under test |
| the supervisor's own stdout | **no** (different process) | the suite is spawned with `stdio: ['ignore','pipe','pipe','pipe']` and its bytes are quoted by the supervisor | a forged record would need code in the supervisor's process, which the suite does not have |
| argv (`/proc/self/cmdline`) | yes | readable | **nothing**: no path, nonce or decision is passed on the child's argv |
| files (any path) | yes | same uid | **nothing**: there is no record file, no lock, no marker. The previous record-file design was removed for exactly this reason (airhorn-y3d6) |
| cwd | yes | writable | **nothing**: nothing is read from the cwd to decide a verdict |
| inherited fds other than 0/1/2 | **no** | `EINVAL` measurement above | nothing to write |
| sockets | yes (it can open its own) | n/a | **nothing**: the supervisor reads no socket |
| the parent's exit status | only by exiting | the supervisor propagates the child's code | a suite that exits 0 while a test failed cannot: the runner's counters come from the runner, not the exit code |
| the child's process itself (signals, `process.abort`) | yes | measured: an abort in the child is now refused as `threw-outside-a-test` | **nothing**: a crash is *evidence* now, and it is observed from outside — including abort, OOM and hard kills that the old in-process design could not record at all |

## KNOWN-LIMITS, stated rather than implied

1. **The event stream is the suite's own self-report and can be forged.** See the row above: v8-serializer
   frames on the worker's stdout become "test events". What the supervisor makes unforgeable is the
   RECORD stream and the identity of the writer; what it cannot authenticate is the truth of what the
   suite says about its own execution. A first version of this document claimed otherwise and was
   measured false within the hour (airhorn-yvwo, airhorn-86wl). Treat `mutant-caught` as "the suite
   reported a failure on the mutant", and use `--suite-old` when the difference matters.
2. **An in-process swallow is invisible.** With the suite in its own process there is no in-process
   monitor to see an `uncaughtException`/`unhandledRejection` before the suite's own handler exits 0.
   Such a run is indistinguishable from a passing suite: it scores `fix-does-not-close` (rc 2), never
   `mutant-caught`. That is a refusal to call the check working — not a false catch — and a forger
   gains nothing from it.
3. **A crash that lands while a test is in flight is refused rather than counted.** If the child
   runner reports a file-level failure, the run is `threw-outside-a-test` even when a test also
   failed, because whether the in-flight test "asserted about the mutant" or merely died with the run
   depends on timing (measured both ways in the same suite).
4. **The supervisor is trusted.** Its wiring is the boundary: a defect there is refused as
   `never-ran`/`report-not-trustworthy` rather than judged (pinned in
   `SUPPRESSION, end to end: strips are no-ops now ... a supervisor defect is refused not judged`).
