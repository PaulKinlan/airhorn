# 0001 — Pin delegation, never a suite's prose

- **Status:** accepted (2026-11-07)
- **Bead:** airhorn-rv1k (the decision), airhorn-6829 (the change it records)

## Context

A check that cannot fail the way it claims is our most expensive defect class, and one instance cost three rewrites.
`tests/gate-map.test.js` used to assert that `tests/resilience-ui.test.mjs`'s **source text** contained two copies of the
lost-upgrade notice, standing in for "the suite asserts the page's copy". Every round was defeated by text: the
substring in a comment, in `console.log("...")`, inside `if (false)`, and inside a `catch` all satisfied it.

That is the failed shape this record prevents: **a comment, or a string in a support file, silently changing a verdict.**
The check read the suite's prose as if it were the suite's behaviour, so the cheapest way to make it green was to write
words, and the cheapest way to make it lie was to delete the behaviour and keep the words.

A text rule over a suite's source cannot establish a dynamic fact. Any rule about what a file *says* is satisfied by
saying it.

## Decision

1. The prose scan is gone. `tests/gate-map.test.js` no longer reads `tests/resilience-ui.test.mjs` for the notice
   strings; the only remaining text read there is `index.html`, which genuinely *authors* the copy.
2. The gate pins **delegation**: `tests/gate-map.test.js:255` requires the suite to call
   `assertLostUpgradeNotice` from `./support/lost-upgrade-copy.mjs` (`assertGuardedCall`, `tools/guarded-call.mjs`).
   That is a statement about a call expression, not about what the file says around it.
3. The enforcement is a **pure support enforcer**: `assertLostUpgradeNotice` records its verdict and schedules a
   non-zero exit that a caller cannot swallow — a caught throw, a wrapper, a `.catch(() => {})` and a stubbed
   `process.exit` all still fail (`airhorn-f96y`, `airhorn-nqje`).
4. The enforcer is pinned by a **browser-free mutant test**, `tests/lost-upgrade-copy.test.mjs` (11 cases), which runs
   the swallowing shapes in child processes and proves they cannot make a failing notice green. It costs no browser.

So the gate answers "is the enforcement still wired in?" and the mutant test answers "can the enforcement be evaded?" —
two questions, each with a check that can fail for the reason it names. Neither reads the suite's prose.

## Consequences

- Deleting or weakening the delegation pin fails `gate-map` by name; making the enforcer swallowable fails
  `lost-upgrade-copy.test.mjs` by name. Both failures are reproducible without a browser, so they run on every change.
- A lane can no longer make the check green by writing words: there is no substring to satisfy. Adding a comment
  changes nothing; adding a *call* is what the pin looks for, and a call that is commented out is not a call.
- **Deliberately NOT checked (the residual):** whether the expected copy still matches the page at run time. The gate
  reads `index.html` for the two strings and trusts `LOST_UPGRADE_COPY`; if a literal drifted from the page's live text
  while both still contained the old words, only the browser suite would catch it. A prose scan did not catch that
  either — it checked that the suite *mentioned* the copy, not that the page agreed with it — so this is not a
  regression, it is the honest boundary. Moving it needs the browser assertion itself, once, in the suite that already
  runs it.
- Nor does anything mechanically stop someone *re-adding* a prose scan beside the pin. It would be useless rather than
  harmful, and the guard against it is this record plus review, not a lint: a second text rule policing text rules
  would be the same mistake twice.

## Alternatives rejected

- **Keep the prose scan, tighten the syntax** — three rounds, each evadable; a text rule cannot establish a dynamic fact.
- **Static analysis of the suite's call (comment-stripped match or AST)** — proves a call expression exists, not that its
  verdict is honoured; a caller that catches defeats it, which is exactly what `airhorn-f96y` measured.
- **A bare `throw` in the enforcer** — honesty depended on the caller's cooperation; `try/catch` and `.catch()` are the
  normal ways to call a support file.
- **Mutation-test the browser suite in the gate** — sound, and it would close the residual above, but it costs browser
  runs on every change; the fast gate's budget (`docs/speed.md`) does not allow it.
- **Move the whole check into the browser suite** — then the fast gate could not see the regression at all, and the
  notice would rot until someone ran the slow suite.
