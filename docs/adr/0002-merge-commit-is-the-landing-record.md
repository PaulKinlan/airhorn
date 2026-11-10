# 0002 — The merge commit is the landing record

- **Status:** accepted (2026-11-10)
- **Bead:** airhorn-32wa

## Context

The weekly review is asked to separate "verified by the gate" from "verified by focused evidence after
landing", and it could not: for the 37 merges in the week to 2026-11-01, `fleet-check --status --fast
<merge-tip>` answered PASS for 4, FAIL for 3, INTERRUPTED for 2, and NONE/UNKNOWN for 18 — because the
verdict cache is keyed by **tree**, and its records and logs are pruned. The oldest surviving fast-gate
log was 2026-10-27. An absence in that cache means **no record was kept**, not "never verified", and the
two are indistinguishable from the cache alone.

Reading that as "18 landings were never gated" would be a false accusation; reading it as "fine" would be
a false clearance. Both come from asking the wrong store.

## Decision

The record is the **merge commit message**, and it already exists. `fleet-land-message` writes, on every
landing:

```
REVIEW
PASS (verdict: PASS-with-notes) for commit 1b4b651 by airhorn-rev-f8ow at ... [reviewer zai/glm-5.3-flash; ...]

GATE
PASS (full gate) for tree 3da95967... (cached for commit 54fd6ad) in 329s run by merger at ...
Log /home/exedev/.fleet/checks/3da95967....log
```

A commit is immutable and travels with every clone, so this is durable where the cache is transient. It
names **the tree the gate ran on**, which is what makes the verdict a statement about the landed content
rather than about some other checkout.

`tools/landings.mjs` reads it back and classifies each first-parent fleet landing:

| state | meaning |
| --- | --- |
| `gated` | PASS recorded for this commit's own tree — the run describes the landed content. |
| `gated-in-batch` | no own verdict (a batch's inner merges carry the generator's "no cached verdict yet" placeholder), but a newer landing recorded PASS on its own tree and this commit is one of its ancestors — the union the batch gated contained this content. The covering commit is printed. |
| `gated-other-tree` | PASS is recorded, for a **different** tree: the evidence is real but does not answer for this landing. A record anomaly, not a clearance. |
| `gate-failed` | a non-PASS verdict is recorded. |
| `ungated` | no gate evidence at all — the truthful answer, not an inference. |

Review evidence is reported beside it (`review-pass`, `review-pass-with-notes`, `review-fail`,
`no-review`) because a landing can have one dimension without the other, and `no-review` is exactly the
"focused evidence instead of a review" case the weekly question is about.

## Why not a new ledger

A `.fleet/landings.jsonl` written at landing time would need a step that can be skipped, a follow-up
commit that changes the trunk tip after the merge, and a merge-conflict story for every concurrent
landing — to record something the merge commit already contains. A second store can also disagree with
git, which is the defect class of ADR 0001: a record that is not the thing itself.

## Measured

- Whole trunk (`node tools/landings.mjs`, 2026-10-18 to 2026-11-09): 231 fleet landings —
  `gated 145`, `gated-in-batch 86`, `gated-other-tree 0`, `gate-failed 0`, `ungated 0`.
- Week 2026-10-26 to 2026-11-01: 33 fleet landings — `gated 7`, `gated-in-batch 26`, `ungated 0`;
  review: `review-pass 11`, `review-pass-with-notes 3`, `no-review 19`. The 19 are landings from before
  the generator wrote REVIEW blocks (free-text merge messages, 2026-10-19 to 2026-11-02) — a real,
  named gap in review evidence, not a missing gate.

So the week was gated. The record could not say so because nobody read the commit; it was being asked of
a cache that had already forgotten.

## Consequences

- "Was this landing gated?" is answered from git with no cache, no new process and no new file:
  `node tools/landings.mjs --since <date> --until <date>`.
- `--require-gate` makes the question a check (`exit 1` when any landing has no usable evidence), usable
  by a review lane on one landing (`--bead <id>`) or by a weekly sweep.
- The tool is **on-demand**, not on the landing path: it reads history and adds no time to the fast or
  full gate (the `airhorn-zach` decision applies the same rule to `mutation-check`).
- What it cannot prove is recorded in its header: it reads what the landing lane **recorded**, so it
  proves the record exists and names the landed tree, not that the gate was honest; `gated-in-batch`
  cannot see a revert between the covered merge and the covering gate, which is why the covering commit
  is printed.
- A message with no GATE block at all (`form: absent`) and a batch placeholder (`form: placeholder`) are
  reported as different absences: only the second means "the union gate result belongs on a later
  commit".
