#!/usr/bin/env bash
# tools/fast-gate.sh — airhorn's FAST tier: run the suites that cover what a change can affect,
# and FAIL LOUDLY on a changed file that maps to none (~/fleet/docs/speed.md R2/R5/R14).
#
# Output contract — these exact lines are parsed by ~/fleet/remote/check-coverage.py:
#   fast-gate: running: <suite>
#   fast-gate: passed: <suite>
#   fast-gate: failed: <suite>
#   fast-gate: unmapped: <path>          (fail-loud; the process exits 1)
# Do not reformat those lines. Additional loud lines that are NOT in the contract:
#   fast-gate: pending: <suite>          (declared by a `~` row, file not landed yet; skipped, not counted)
#   fast-gate: unmapped-suite: <suite>   (suite in the tree but not reachable from the map; exit 1)
# The gate builds dist/ before running (browser suites serve it); a build failure exits 1.
#
# Usage:
#   bash tools/fast-gate.sh                     # changed paths vs the merge-base with origin/master
#   bash tools/fast-gate.sh --changed src/a.js  # repeatable; bypasses git entirely
#   bash tools/fast-gate.sh --list              # print the suites it WOULD run, run nothing
#   bash tools/fast-gate.sh --base <ref>        # compare against another base
#   FAST_GATE_JOBS=2 bash tools/fast-gate.sh    # cap parallel suites
#
# Exit codes: 0 = every selected suite passed (or nothing was affected); 1 = a suite failed, a mapped
# suite is missing, or a changed file is unmapped. ANY non-zero is "unknown", never "green".
set -uo pipefail

HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
MAP="$HERE/suite-map.tsv"
CONF="$HERE/gate.conf"

[ -f "$MAP" ] || { echo "fast-gate: no $MAP — the map IS the gate; refusing to guess" >&2; exit 1; }
# An explicitly exported FAST_GATE_RUNNER wins over gate.conf's.
_ENV_FAST=${FAST_GATE_RUNNER-}
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
[ -n "$_ENV_FAST" ] && FAST_GATE_RUNNER=$_ENV_FAST
FAST_GATE_RUNNER=${FAST_GATE_RUNNER:-node --test}
JOBS=${FAST_GATE_JOBS:-4}
# Suites report in two tiers (airhorn-n00). node:test suites already give per-case
# names through TAP; the assert-script suites narrate and exit, so they are run
# directly with a preload hook that records their narration as timed cases and
# writes a machine-readable result. No suite is rewritten for this: the hook reads
# what the suite already prints, and `##case## <name>` is an optional convention.
HOOK="$HERE/../tests/support/report-hook.mjs"
RESULTS_DIR=${AIRHORN_RESULTS_DIR:-/tmp/airhorn-test-results}
tier_of() {
  case $1 in
    *.test.js|*.test.ts) echo node-test ;;
    *)                   echo script ;;
  esac
}
runner_for() {
  case $(tier_of "$1") in
    node-test) echo "$FAST_GATE_RUNNER" ;;
    script)    echo "node --import $HOOK" ;;
  esac
}

LIST=0; BASE="${FAST_GATE_BASE:-}"; EXPLICIT=()
while [ $# -gt 0 ]; do
  case $1 in
    --list)    LIST=1; shift ;;
    --changed) EXPLICIT+=("${2:?--changed needs a path}"); shift 2 ;;
    --base)    BASE="${2:?--base needs a ref}"; shift 2 ;;
    *)         echo "fast-gate: unknown argument '$1'" >&2; exit 2 ;;
  esac
done

# --- the base: origin/master (this repo's default), then main variants, then HEAD~1. Never "everything".
if [ "${#EXPLICIT[@]}" -eq 0 ]; then
  if [ -z "$BASE" ]; then
    for b in origin/master master origin/main main; do
      git -C "$ROOT" rev-parse --verify --quiet "$b" >/dev/null 2>&1 && { BASE=$b; break; }
    done
  fi
  [ -n "$BASE" ] || { echo "fast-gate: no base ref (no origin/master, no main) and no --changed given" >&2; exit 1; }
  MB=$(git -C "$ROOT" merge-base "$BASE" HEAD) || { echo "fast-gate: cannot merge-base $BASE..HEAD" >&2; exit 1; }
  # Committed, uncommitted and untracked all count. Over-inclusion is deliberate: a selector that MISSES
  # a file you just wrote is the defect this script exists to prevent.
  mapfile -t CHANGED < <( { git -C "$ROOT" diff --name-only "$MB"..HEAD
                            git -C "$ROOT" diff --name-only
                            git -C "$ROOT" ls-files --others --exclude-standard; } 2>/dev/null \
                          | sed '/^$/d' | sort -u )
else
  CHANGED=("${EXPLICIT[@]}")
fi

is_exempt() { # $1 = path ; true iff an `!` row matches it
  local pat
  while IFS=$'\t' read -r pat _; do
    # NOTE: the pattern side of `[[ ]]` must stay UNQUOTED or it is compared as a literal string.
    case $pat in \!*) [ -n "${pat#!}" ] || continue; [[ $1 == ${pat#!} ]] && return 0 ;; esac
  done < "$MAP"
  return 1
}

suites_for() { # $1 = path -> newline-separated suites (empty = unmapped)
  local pat rest
  # A changed suite maps to itself (both spellings of the suite directory, js/mjs/ts).
  case $1 in tests/*.test.js|tests/*.test.mjs|tests/*.test.ts|test/*.test.js|test/*.test.mjs|test/*.test.ts) echo "$1"; return ;; esac
  # ACCUMULATE every matching row, do not stop at the first (fleet-w7so): rows are additive, the caller
  # de-duplicates, so naming a suite twice is harmless — but silently dropping a row's coverage is not.
  # `~` rows are PENDING declarations and map no files (see is_pending).
  while IFS=$'\t' read -r pat rest; do
    case $pat in ''|\#*|\!*|~*) continue ;; esac
    if [[ $1 == $pat ]]; then
      printf '%s\n' $rest          # word-split on purpose: one row names several suites
    fi
  done < "$MAP"
  return
}

is_pending() { # $1 = suite path ; true iff a `~` row DECLARES it (arriving with a sibling branch)
  local pat rest s   # local s: the inner loop must NOT clobber the caller's iteration variable
  while IFS=$'	' read -r pat rest; do
    case $pat in ~*) ;; *) continue ;; esac
    for s in $rest; do [ "$s" = "$1" ] && return 0; done
  done < "$MAP"
  return 1
}

map_reaches() { # $1 = suite path ; true iff a NON-exemption row names it (plain or `~`)
  local pat rest s   # local s: see is_pending - this bug once appended the wrong suite to the FAIL list
  while IFS=$'\t' read -r pat rest; do
    case $pat in ''|\#*|\!*) continue ;; esac
    for s in $rest; do [ "$s" = "$1" ] && return 0; done
  done < "$MAP"
  return 1
}

UNMAPPED=(); EXEMPT_COUNT=0; SELECTED=()
for f in ${CHANGED[@]+"${CHANGED[@]}"}; do
  # A deleted SUITE selects nothing - unless a PLAIN map row still names it.
  # A row that survives its suite is a STALE MAP and must keep failing the
  # gate right here ('missing: ...'), not silently later (airhorn-vpb): this
  # skip exists so a suite deleted in the same commit that removes its row is
  # not punished as 'missing', and nothing more. A '~'-pending declaration
  # counts as the row being correctly absent (the MISSING check allows it).
  # Deleted NON-suite paths keep mapping normally: a dynamic import can
  # survive the build, so the suites a deleted source file covered must still
  # run and fail.
  case $f in
    tests/*.test.js|tests/*.test.mjs|tests/*.test.ts|test/*.test.js|test/*.test.mjs|test/*.test.ts)
      if [ ! -f "$ROOT/$f" ]; then
        if map_reaches "$f" && ! is_pending "$f"; then
          : # stale plain row: fall through, suites_for maps the path to
            # itself and the MISSING check below fails the gate
        else
          continue
        fi
      fi ;;
  esac
  got=$(suites_for "$f")
  if [ -n "$got" ]; then
    while IFS= read -r s; do [ -n "$s" ] && SELECTED+=("$s"); done <<<"$got"
  elif is_exempt "$f"; then
    EXEMPT_COUNT=$((EXEMPT_COUNT + 1))
  else
    UNMAPPED+=("$f")
  fi
done

# --- fail loudly on anything unmapped, BEFORE running a subset that would look green ------------------
if [ "${#UNMAPPED[@]}" -gt 0 ]; then
  mapfile -t _unmapped_sorted < <(printf '%s\n' "${UNMAPPED[@]}" | sort -u)
  for f in "${_unmapped_sorted[@]}"; do [ -n "$f" ] && echo "fast-gate: unmapped: $f"; done
  echo "fast-gate: FAIL - ${#UNMAPPED[@]} changed file(s) map to no suite in tools/suite-map.tsv." >&2
  echo "fast-gate: add a row to tools/suite-map.tsv naming EVERY suite that covers the file, or - if" >&2
  echo "fast-gate: the file genuinely has no suite - add an exemption and say why in the comment." >&2
  exit 1
fi

# --- reverse check (fleet-1n0z mode a, other direction): every suite PRESENT in the tree must be -----
# --- reachable from the map (a row naming it, or an explicit `!` ignore), or the gate fails. --------
# Without this, a second suite covering src/main.js that forgot its map row silently never runs for
# the code it covers, while the gate still prints a positive suite count.
TREE_SUITE_NOT_REACHABLE=()
for s in tests/*.test.js tests/*.test.mjs tests/*.test.ts test/*.test.js test/*.test.mjs test/*.test.ts; do
  [ -f "$ROOT/$s" ] || continue          # unmatched globs stay literal; skip them
  if is_exempt "$s" || map_reaches "$s"; then continue; fi
  TREE_SUITE_NOT_REACHABLE+=("$s")
done
if [ "${#TREE_SUITE_NOT_REACHABLE[@]}" -gt 0 ]; then
  for s in "${TREE_SUITE_NOT_REACHABLE[@]}"; do echo "fast-gate: unmapped-suite: $s"; done
  echo "fast-gate: FAIL - ${#TREE_SUITE_NOT_REACHABLE[@]} suite(s) in the tree are not reachable from" >&2
  echo "fast-gate: tools/suite-map.tsv, so changes to the files they cover would never select them." >&2
  echo "fast-gate: add a row naming the suite (every suite needs one, e.g. its own self-row), or an" >&2
  echo "fast-gate: '!<suite>' exemption with a reason if it genuinely must not run in this gate." >&2
  exit 1
fi

mapfile -t SELECTED < <(printf '%s\n' ${SELECTED[@]+"${SELECTED[@]}"} | sed '/^$/d' | sort -u)

if [ "${#SELECTED[@]}" -eq 0 ]; then
  if [ "${#CHANGED[@]}" -eq 0 ]; then
    echo "fast-gate: no changed files"
  else
    echo "fast-gate: PASS (0 suite(s), ${#CHANGED[@]} changed file(s), all ${EXEMPT_COUNT} exempt)"
  fi
  exit 0
fi

if [ "$LIST" -eq 1 ]; then
  printf '%s\n' "${SELECTED[@]}"
  exit 0
fi

# --- split selected suites: RUN (exists) vs PENDING (declared by a `~` row, not landed yet) ----------
# A selected suite whose file is missing is a STALE map (fail) unless a `~` row declares it as pending
# (arriving with a sibling branch) - then it is skipped loudly and simply not counted.
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
RUN=(); PENDING=(); MISSING=()
for s in "${SELECTED[@]}"; do
  if [ -f "$ROOT/$s" ]; then RUN+=("$s");
  elif is_pending "$s"; then PENDING+=("$s"); printf 'fast-gate: pending: %s\n' "$s";
  else MISSING+=("$s"); fi
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  printf 'fast-gate: missing: %s\n' "${MISSING[@]}"
  echo "fast-gate: FAIL - ${#MISSING[@]} suite(s) named in tools/suite-map.tsv do not exist; the map is" >&2
  echo "fast-gate: stale (a renamed or deleted suite reads as green forever otherwise). Fix the map," >&2
  echo "fast-gate: or mark the suite as '~'-pending if it arrives with a sibling branch." >&2
  exit 1
fi

if [ "${#RUN[@]}" -eq 0 ]; then
  echo "fast-gate: PASS (0 suite(s), ${#CHANGED[@]} changed file(s), all pending)"
  exit 0
fi

# --- build once: browser suites serve dist/ (a11y, sw-offline); the build is ~0.3s --------------------
mkdir -p "$RESULTS_DIR"
echo "fast-gate: building dist (browser suites serve it)"
if ! (cd "$ROOT" && npm run build --silent) >"$TMP/build.log" 2>&1; then
  echo "fast-gate: failed: build"
  sed 's/^/    /' "$TMP/build.log" 2>/dev/null | tail -20
  echo "fast-gate: FAIL - build failed; browser suites cannot run." >&2
  exit 1
fi

printf 'fast-gate: running: %s\n' "${RUN[@]}"
n=0
for s in "${RUN[@]}"; do
  key=$(printf '%s' "$s" | tr '/.' '__')
  ( cd "$ROOT" && AIRHORN_RESULTS_DIR="$RESULTS_DIR" $(runner_for "$s") "$s" >"$TMP/$key.log" 2>&1; echo $? >"$TMP/$key.rc" ) &
  n=$((n + 1))
  if [ "$n" -ge "$JOBS" ]; then wait -n; n=$((n - 1)); fi
done
wait

# Report what each suite actually did, not just that it exited: for node:test the
# TAP summary, for script-tier suites the hook's own line (which names the step a
# failure was attributed to). "no result" is reported as such - a suite that dies
# before reporting must never read as a pass.
# Returns non-zero when the suite produced no valid result, so the caller can fail
# the gate. A missing result is a reporting regression, not a pass (airhorn-yy1): a
# suite that exits 0 without saying what it ran proves nothing.
report_cases() { # $1 = suite, $2 = log
  case $(tier_of "$1") in
    node-test)
      pass=$(sed -nE 's/^# pass ([0-9]+).*/\1/p' "$2" | tail -1)
      fail=$(sed -nE 's/^# fail ([0-9]+).*/\1/p' "$2" | tail -1)
      if [ -n "$pass" ]; then
        echo "fast-gate: cases: $1 :: node:test pass=${pass} fail=${fail:-0}"
        if [ "${fail:-0}" != 0 ]; then
          sed -nE 's/^not ok [0-9]+ - (.*)$/fast-gate:   failing: \1/p' "$2" | head -5
        fi
        return 0
      fi
      echo "fast-gate: cases: $1 :: no TAP summary (suite exited without reporting)"
      return 1
      ;;
    script)
      line=$(grep -m1 '^##CASES## ' "$2" 2>/dev/null | sed 's/^##CASES## //')
      if [ -n "$line" ]; then
        echo "fast-gate: cases: $1 :: $line"
        return 0
      fi
      echo "fast-gate: cases: $1 :: no result (suite exited without reporting)"
      return 1
      ;;
  esac
  return 0
}

rc=0
for s in "${RUN[@]}"; do
  key=$(printf '%s' "$s" | tr '/.' '__')
  suite_rc=$(cat "$TMP/$key.rc" 2>/dev/null)
  cases_out=$(report_cases "$s" "$TMP/$key.log")
  cases_rc=$?
  printf '%s\n' "$cases_out" | tee -a "$RESULTS_DIR/summary.txt"
  if [ "$suite_rc" = 0 ] && [ "$cases_rc" = 0 ]; then
    echo "fast-gate: passed: $s"
  elif [ "$suite_rc" = 0 ]; then
    # exit 0 but nothing reported: the suite cannot prove what it ran.
    echo "fast-gate: failed: $s (exit 0 but no result; reporting is broken)"
    echo "fast-gate: a selected suite must report its cases; silence is not a pass" >&2
    rc=1
  else
    echo "fast-gate: failed: $s"
    sed 's/^/    /' "$TMP/$key.log" 2>/dev/null | tail -40
    rc=1
  fi
done
[ "$rc" -eq 0 ] && echo "fast-gate: PASS (${#RUN[@]} suite(s), ${#CHANGED[@]} changed file(s))" \
                || echo "fast-gate: FAIL (see the suite logs above)" >&2
exit $rc
