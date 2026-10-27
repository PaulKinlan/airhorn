#!/usr/bin/env bash
# tools/fast-gate.sh — airhorn's FAST tier: run the suites that cover what a change can affect,
# and FAIL LOUDLY on a changed file that maps to none (~/fleet/docs/speed.md R2/R5/R14).
#
# Output contract — these exact lines are parsed by ~/fleet/remote/producer-verdict.py:
# (the machine declaration that names them is tools/check.conf; the pin that keeps the two
# in step is tests/gate-smoke.test.js 'the fleet contract recognises every rc-0 verdict line
# the gate emits' — airhorn-3dph)
#   fast-gate: running: <suite>
#   fast-gate: passed: <suite>
#   fast-gate: failed: <suite>
#   fast-gate: unmapped: <path>          (fail-loud; the process exits 1)
# Do not reformat those lines. Additional loud lines that are NOT in the contract:
#   fast-gate: pending: <suite>          (declared by a `~` row, file not landed yet; skipped, not counted)
#   fast-gate: unmapped-suite: <suite>   (suite in the tree but not reachable from the map; exit 1)
#   fast-gate: zero-suite: <path>        (changed file that selected nothing when 0 suites ran,
#                                         suffixed with why: exempt or deleted suite; exit 1 unless
#                                         FAST_GATE_ALLOW_ZERO=1, which prints ZERO-SUITE PASS)
# The gate builds dist/ before running (browser suites serve it); a build failure exits 1.
#
# Usage:
#   bash tools/fast-gate.sh                     # changed paths vs the merge-base with origin/master
#   bash tools/fast-gate.sh --changed src/a.js  # repeatable; bypasses git entirely
#   bash tools/fast-gate.sh --list              # print the suites it WOULD run, run nothing
#   bash tools/fast-gate.sh --base <ref>        # compare against another base
#   FAST_GATE_JOBS=1 bash tools/fast-gate.sh    # serial: one suite at a time
#                                                # (fallback when gate.conf sets none: one per core)
#   FAST_GATE_ALLOW_ZERO=1 bash tools/fast-gate.sh  # bless a suite-free change (every ignored file:
#                                                #   an exemption row or a deleted suite)
#
# Exit codes: 0 = every selected suite passed (or nothing was affected, or a zero-execution verdict
# was explicitly acknowledged with FAST_GATE_ALLOW_ZERO=1: every changed file exempt or a deleted
# suite, or every selected suite '~'-pending); 1 = a suite failed, a mapped suite is missing, a changed file is
# unmapped, a non-empty change selected ZERO suites without the acknowledgement, or every selected
# suite is '~'-pending (nothing executed) without the acknowledgement.
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
# Parallelism FALLBACK: one suite per core. This value only applies to a tree
# with no tools/gate.conf - this repo pins FAST_GATE_JOBS=1 there on purpose,
# because its browser suites each launch a headless Chrome and the fleet rule is
# one at a time per VM (see gate.conf). The fallback used to be a flat 4, which
# is arbitrary: on a 2-core host that is twice the CPUs, and it is not a number
# any measurement ever chose. A CPU-bound suite set should size to the cores it
# has; a repo whose suites are not CPU-bound (or that must not run two browsers)
# states its own value in gate.conf, as this one does.
# NOTE for whoever reaches for parallelism to make a wide change pass: a flat
# TIME bound on a serial gate is a function of how many suites were selected, so
# raising parallelism trades bound-timeout for a rule violation. Measured on
# 2026-10-25: the full suite is serial and its 268 s total is the sum of its
# suites (multitab 22.8 s, shortcuts 17.9 s, resilience-ui 16.9 s, sw-failover
# 16.0 s ...), i.e. the work is additive and a wide blast radius needs a bound
# derived from the selection, not a parallel scheduler (airhorn-kbhg).
CORES=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
case $CORES in ''|*[!0-9]*|0) CORES=4 ;; esac
JOBS=${FAST_GATE_JOBS:-$CORES}
case $JOBS in ''|*[!0-9]*|0) JOBS=$CORES ;; esac
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

# Read MAP once into memory:
MAP_ROWS_PAT=()
MAP_ROWS_REST=()
declare -A PENDING_SET=()
declare -A REACHABLE_SET=()
EXEMPT_PATTERNS=()

while IFS=$'\t' read -r pat rest || [ -n "$pat" ]; do
  case $pat in ''|\#*) continue ;; esac
  MAP_ROWS_PAT+=("$pat")
  MAP_ROWS_REST+=("$rest")
  case $pat in
    ~*)
      for s in $rest; do PENDING_SET["$s"]=1; REACHABLE_SET["$s"]=1; done ;;
    \!*)
      [ -n "${pat#!}" ] && EXEMPT_PATTERNS+=("${pat#!}") ;;
    *)
      for s in $rest; do REACHABLE_SET["$s"]=1; done ;;
  esac
done < "$MAP"

is_exempt() { # $1 = path ; true iff an `!` row matches it
  local pat
  for pat in ${EXEMPT_PATTERNS[@]+"${EXEMPT_PATTERNS[@]}"}; do
    # NOTE: the pattern side of `[[ ]]` must stay UNQUOTED or it is compared as a literal string.
    [[ $1 == $pat ]] && return 0
  done
  return 1
}

suites_for() { # $1 = path -> newline-separated suites (empty = unmapped)
  local i pat
  # A changed suite maps to itself (both spellings of the suite directory, js/mjs/ts).
  case $1 in tests/*.test.js|tests/*.test.mjs|tests/*.test.ts|test/*.test.js|test/*.test.mjs|test/*.test.ts) echo "$1"; return ;; esac
  # ACCUMULATE every matching row, do not stop at the first (fleet-w7so): rows are additive, the caller
  # de-duplicates, so naming a suite twice is harmless — but silently dropping a row's coverage is not.
  # `~` rows are PENDING declarations and map no files (see is_pending).
  for i in "${!MAP_ROWS_PAT[@]}"; do
    pat="${MAP_ROWS_PAT[$i]}"
    case $pat in \!*|~*) continue ;; esac
    if [[ $1 == $pat ]]; then
      printf '%s\n' ${MAP_ROWS_REST[$i]}          # word-split on purpose: one row names several suites
    fi
  done
  return
}

is_pending() { # $1 = suite path ; true iff a `~` row DECLARES it (arriving with a sibling branch)
  [[ -n "${PENDING_SET[$1]-}" ]]
}

map_reaches() { # $1 = suite path ; true iff a NON-exemption row names it (plain or `~`)
  [[ -n "${REACHABLE_SET[$1]-}" ]]
}

# --- map honesty: validated by derive-coverage-contract.mjs --validate-map ---
if ! node "$HERE/derive-coverage-contract.mjs" --validate-map; then
  echo "fast-gate: FAIL - the map has integrity violations (see errors above)." >&2
  exit 1
fi

UNMAPPED=(); EXEMPT_COUNT=0; DELETED_SUITE_COUNT=0; SELECTED=()
EXEMPT_PATHS=(); DELETED_SUITE_PATHS=()
for f in ${CHANGED[@]+"${CHANGED[@]}"}; do
  # A deleted SUITE selects nothing: there is no file left to run. Staleness
  # is owned by the map-honesty pass above - a row surviving its suite fails
  # there under ANY spelling, so selection need not re-derive it (airhorn-o0u).
  # Deleted NON-suite paths keep mapping normally: a dynamic import can
  # survive the build, so the suites a deleted source file covered must still
  # run and fail.
  case $f in
    tests/*.test.js|tests/*.test.mjs|tests/*.test.ts|test/*.test.js|test/*.test.mjs|test/*.test.ts)
      # Kept in its own bucket, NOT folded into the exempt count: the zero-suite
      # diagnosis below must stay true for every path into it (airhorn-wiq9).
      if [ ! -f "$ROOT/$f" ]; then
        DELETED_SUITE_COUNT=$((DELETED_SUITE_COUNT + 1))
        DELETED_SUITE_PATHS+=("$f")
        continue
      fi ;;
  esac
  got=$(suites_for "$f")
  if [ -n "$got" ]; then
    while IFS= read -r s; do [ -n "$s" ] && SELECTED+=("$s"); done <<<"$got"
  elif is_exempt "$f"; then
    EXEMPT_COUNT=$((EXEMPT_COUNT + 1))
    EXEMPT_PATHS+=("$f")
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

# --list is a QUERY, not a verdict: it prints what WOULD run and exits 0, however empty - the
# zero-suite rule below is about a verdict that reads green, and a listing reads as nothing.
if [ "$LIST" -eq 1 ]; then
  printf '%s\n' "${SELECTED[@]}"
  exit 0
fi

if [ "${#SELECTED[@]}" -eq 0 ]; then
  if [ "${#CHANGED[@]}" -eq 0 ]; then
    echo "fast-gate: no changed files"
    exit 0
  fi
  # A non-empty change that selected NOTHING proves nothing: an over-broad `!` row (or a future
  # map edit exempting a real source path) used to exit 0 here - a green verdict with no suite
  # run (airhorn-n0jd). The exemption rows exist for genuinely suite-free files (docs, assets),
  # so the honest case stays available - but as a deliberate, loud act, not a silent PASS.
  if [ "${FAST_GATE_ALLOW_ZERO:-0}" != "1" ]; then
    # Name each ignored path with the reason it selected nothing. Exempt rows and
    # deleted suites are the only two ways into this block (anything else failed
    # the unmapped pass above); blaming a non-existent '! ' row sends the reader
    # hunting for a map edit that is not there (airhorn-wiq9).
    for f in ${EXEMPT_PATHS[@]+"${EXEMPT_PATHS[@]}"}; do echo "fast-gate: zero-suite: $f (exempt)"; done
    for f in ${DELETED_SUITE_PATHS[@]+"${DELETED_SUITE_PATHS[@]}"}; do echo "fast-gate: zero-suite: $f (deleted suite; selects nothing by design)"; done
    echo "fast-gate: FAIL - ${#CHANGED[@]} changed file(s) selected 0 suite(s): every one is exempt or a" >&2
    echo "fast-gate: deleted suite (a deleted suite has no file left to run), so no suite ran and this" >&2
    echo "fast-gate: verdict cannot be green. If the change truly has no suite to run (docs, assets," >&2
    echo "fast-gate: deleted suites), re-run with FAST_GATE_ALLOW_ZERO=1; otherwise add or fix the map" >&2
    echo "fast-gate: rows these files need." >&2
    exit 1
  fi
  if [ "$DELETED_SUITE_COUNT" -eq 0 ]; then
    # Unchanged pinned line for the exempt-only case: tools/check.conf classifies
    # this exact shape, and it was already true.
    echo "fast-gate: ZERO-SUITE PASS (${#CHANGED[@]} changed file(s), all ${EXEMPT_COUNT} exempt; FAST_GATE_ALLOW_ZERO=1)"
  else
    echo "fast-gate: ZERO-SUITE PASS (${#CHANGED[@]} changed file(s): ${EXEMPT_COUNT} exempt, ${DELETED_SUITE_COUNT} deleted-suite; FAST_GATE_ALLOW_ZERO=1)"
  fi
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
  # Every selected suite is '~'-pending, so ZERO suites executed: the same green-with-no-suites
  # shape airhorn-n0jd closed for '!' rows, reached through a map row instead of a changed path
  # (airhorn-dn7d). A '~' row that never lands (a forgotten sibling branch) would otherwise keep
  # every change to its source permanently green with nothing run. Same rule, same acknowledgement:
  # FAIL unless FAST_GATE_ALLOW_ZERO=1 explicitly blesses the zero-execution verdict.
  if [ "${FAST_GATE_ALLOW_ZERO:-0}" != "1" ]; then
    echo "fast-gate: FAIL - ${#PENDING[@]} selected suite(s) are all '~'-pending, so 0 suite(s) executed." >&2
    echo "fast-gate: a verdict with zero executed suites cannot be green (airhorn-n0jd, airhorn-dn7d); the" >&2
    echo "fast-gate: pending suites are named above. Land the sibling branch that brings them, or - if this" >&2
    echo "fast-gate: change genuinely must execute nothing - re-run with FAST_GATE_ALLOW_ZERO=1." >&2
    exit 1
  fi
  echo "fast-gate: ZERO-SUITE PASS (${#CHANGED[@]} changed file(s), all ${#PENDING[@]} pending; FAST_GATE_ALLOW_ZERO=1)"
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
SUITE_PIDS=()
for s in "${RUN[@]}"; do
  key=$(printf '%s' "$s" | tr '/.' '__')
  ( cd "$ROOT" && AIRHORN_RESULTS_DIR="$RESULTS_DIR" $(runner_for "$s") "$s" >"$TMP/$key.log" 2>&1; echo $? >"$TMP/$key.rc" ) &
  SUITE_PIDS+=($!)
  n=$((n + 1))
  if [ "$n" -ge "$JOBS" ]; then wait -n; n=$((n - 1)); fi
done
# Wait on the suite pids by name: a bare 'wait' would also reap any other
# background job this script ever starts, and an immortal one would hang the gate.
wait "${SUITE_PIDS[@]}"

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

# Report failure diagnostics and preserve the suite log for post-mortem analysis (airhorn-rumq).
# For node:test TAP suites, extracts the full `not ok` YAML failure blocks (including assertion error,
# expected/actual, and stack trace) so assertions buried before trailing passing tests are never lost.
# For script suites or pre-test crashes, prints the output tail (or full log if short).
# Preserves failing suite logs in RESULTS_DIR/failing-suites/ and ~/.fleet/checks/<tree>.fast.failing-suites/.
report_suite_failure() { # $1 = suite, $2 = key, $3 = log
  local s=$1 key=$2 log=$3
  local tap_fails
  tap_fails=$(awk '
    /^not ok / { in_fail=1 }
    in_fail { print; if (/^[ \t]*\.\.\.[ \t]*$/) in_fail=0 }
  ' "$log" 2>/dev/null | head -n 250)

  if [ -n "$tap_fails" ]; then
    echo "fast-gate:   failing case diagnostics for $s:"
    sed 's/^/      /' <<< "$tap_fails"
    local summary
    summary=$(tail -n 15 "$log" 2>/dev/null | grep -E '^# (tests|pass|fail|duration_ms|cancelled|skipped|todo)' || true)
    if [ -n "$summary" ]; then
      echo "fast-gate:   summary for $s:"
      sed 's/^/      /' <<< "$summary"
    fi
  else
    local line_count
    line_count=$(wc -l < "$log" 2>/dev/null || echo 0)
    if [ "$line_count" -le 60 ]; then
      echo "fast-gate:   suite output ($line_count lines):"
      sed 's/^/      /' "$log" 2>/dev/null
    else
      echo "fast-gate:   suite output (tail 50 of $line_count lines):"
      tail -n 50 "$log" 2>/dev/null | sed 's/^/      /'
    fi
  fi

  # Preserve failing suite output in durable locations (size-capped at 512KB)
  local tree dest_dirs=()
  dest_dirs+=("$RESULTS_DIR/failing-suites")
  local checks_dir="${AIRHORN_CHECKS_DIR:-$HOME/.fleet/checks}"
  tree=$(git rev-parse -q --verify 'HEAD^{tree}' 2>/dev/null || true)
  if [ -n "$tree" ] && [ -d "$checks_dir" ]; then
    dest_dirs+=("$checks_dir/$tree.fast.failing-suites")
  fi
  if [ -n "${AIRHORN_FAILING_SUITES_DIR:-}" ]; then
    dest_dirs+=("$AIRHORN_FAILING_SUITES_DIR")
  fi
  for d in "${dest_dirs[@]}"; do
    mkdir -p "$d" 2>/dev/null || true
    tail -c 524288 "$log" > "$d/$key.log" 2>/dev/null || true
    echo "fast-gate: suite log preserved at $d/$key.log"
  done

  # If running under fleet-check and the JSON check record exists, embed failing suite info
  if [ -n "$tree" ] && [ -d "$checks_dir" ]; then
    local rec="$checks_dir/$tree.fast.json"
    if [ -f "$rec" ] && command -v jq >/dev/null 2>&1; then
      local snippet
      snippet=$(awk '
        /^not ok / { in_fail=1 }
        in_fail { print; if (/^[ \t]*\.\.\.[ \t]*$/) in_fail=0 }
      ' "$log" 2>/dev/null | head -n 30)
      [ -n "$snippet" ] || snippet=$(tail -n 25 "$log" 2>/dev/null)
      jq --arg s "$s" --arg p "$checks_dir/$tree.fast.failing-suites/$key.log" --arg snip "$snippet" \
        '.failing_suites = ((.failing_suites // {}) + {($s): {log: $p, snippet: $snip}})' \
        "$rec" > "$rec.tmp.$$" 2>/dev/null && mv -f "$rec.tmp.$$" "$rec" || rm -f "$rec.tmp.$$"
    fi
  fi
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
    report_suite_failure "$s" "$key" "$TMP/$key.log"
    rc=1
  else
    echo "fast-gate: failed: $s"
    report_suite_failure "$s" "$key" "$TMP/$key.log"
    rc=1
  fi
done
[ "$rc" -eq 0 ] && echo "fast-gate: PASS (${#RUN[@]} suite(s), ${#CHANGED[@]} changed file(s))" \
                || echo "fast-gate: FAIL (see the suite logs above)" >&2
exit $rc
