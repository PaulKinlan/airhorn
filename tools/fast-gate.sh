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
#   fast-gate: derived: <module> -> <n> suite(s)   (an `@importers` row, scanned from the tree NOW)
#   fast-gate: unmapped-suite: <suite>   (suite in the tree but not reachable from the map; exit 1)
#   fast-gate: zero-suite: <path>        (changed file that selected nothing when 0 suites ran,
#                                         suffixed with why: exempt or deleted suite; exit 1 unless
#                                         FAST_GATE_ALLOW_ZERO=1, which prints ZERO-SUITE PASS)
# The gate builds dist/ before running the browser suites that serve it, and only when the build
# decision says a build is needed (no dist/, an unstamped dist/, changed inputs, or changed dist/
# bytes): a build failure exits 1, and a build that changes its own inputs is not stamped.
#
# A map row whose suite column is `@importers` derives its suite set at run time from every file that
# REFERENCES that module (any import shape: static, dynamic import(), require, a computed path.join),
# so a new importer needs no map edit and a stale list cannot silently under-select (airhorn-ooqm).
# `except=<file>` on such a row keeps a suite off it deliberately (tests/acceptance.mjs is
# explicit-only by design, airhorn-i8i). The scan lives in tools/derive-coverage-contract.mjs.
#
# Usage:
#   bash tools/fast-gate.sh                     # changed paths vs the merge-base with origin/master
#   bash tools/fast-gate.sh --changed src/a.js  # repeatable; bypasses git entirely
#   bash tools/fast-gate.sh --list              # print the suites it WOULD run, run nothing
#   bash tools/fast-gate.sh --build-plan --changed <path>  # would this build dist? (never builds)
#   bash tools/fast-gate.sh --base <ref>        # compare against another base
#   bash tools/fast-gate.sh --stamp-dist        # TEST/REPAIR ONLY: stamp whatever is in dist/ as
#                                                # current, without building - it can bless bytes no
#                                                # build produced. Nothing in the fleet path uses it.
#   FAST_GATE_JOBS=1 bash tools/fast-gate.sh    # serial: one suite at a time
#                                                # (fallback when gate.conf sets none: one per core)
#   FAST_GATE_ALLOW_ZERO=1 bash tools/fast-gate.sh  # bless a suite-free change (every ignored file:
#                                                #   an exemption row or a deleted suite)
#
# FAST_GATE_RUNNER is NOT a knob (airhorn-v6th): the runner is pinned by tools/gate.conf. An exported
# FAST_GATE_RUNNER that DIFFERS from the pin exits 1 before anything runs (an export equal to the pin
# is a no-op). It used to win unconditionally, so `FAST_GATE_RUNNER=/tmp/fakerun.sh` turned a RED
# suite into a green verdict with a normal PASS line and no trace, and a leftover `--test-only`
# produced a genuine TAP summary over a SUBSET of cases. Changing the runner is an edit to gate.conf
# - a reviewed, committed diff - or your own gate.conf in your copy of tools/ (how the probes do it).
# FAST_GATE_BASE is refused the same way: '--base <ref>' is the sanctioned spelling for a base.
#
# Exit codes: 0 = every selected suite passed (or nothing was affected, or a zero-execution verdict
# was explicitly acknowledged with FAST_GATE_ALLOW_ZERO=1: every changed file exempt or a deleted
# suite, or every selected suite '~'-pending); 1 = a suite failed, a mapped suite is missing, a changed file is
# unmapped, a non-empty change selected ZERO suites without the acknowledgement, or every selected
# suite is '~'-pending (nothing executed) without the acknowledgement.
set -uo pipefail

HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)
# One temp dir for the whole run, created here so the digest helpers below can capture the
# pipeline's OWN stderr and report it (airhorn-bt55 (a)).
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
MAP="$HERE/suite-map.tsv"
CONF="$HERE/gate.conf"

[ -f "$MAP" ] || { echo "fast-gate: no $MAP — the map IS the gate; refusing to guess" >&2; exit 1; }
# The runner comes from gate.conf ONLY (airhorn-v6th). This knob decides WHAT EXECUTES, so an
# ambient export used to weaken every verdict the fleet takes from this repo (airhorn-bt55 closed
# the same class for FAST_GATE_SKIP_BUILD; GSM_TOOLS_ROOT followed the same rule - honoured only
# under the minted test guard). Here the rule is stricter and cheaper, because nothing in the tree
# exports it (git grep: only tools/fast-gate.sh and tools/gate.conf) and a probe that needs a
# different runner copies tools/ and writes its own gate.conf (tests/gate-smoke.test.js does).
# An export equal to the pin is a no-op; one that differs FAILS, here, before any suite runs, so a
# forged runner cannot green a RED suite and a narrowed one cannot silently skip cases.
_ENV_RUNNER=${FAST_GATE_RUNNER-}
_ENV_BASE=${FAST_GATE_BASE-}
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
FAST_GATE_RUNNER=${FAST_GATE_RUNNER:-node --test}
if [ -n "$_ENV_RUNNER" ] && [ "$_ENV_RUNNER" != "$FAST_GATE_RUNNER" ]; then
  echo "fast-gate: FAIL - FAST_GATE_RUNNER is exported as '$_ENV_RUNNER', but the runner is pinned by" >&2
  echo "fast-gate: $CONF as '$FAST_GATE_RUNNER'. An ambient export must not decide what executes:" >&2
  echo "fast-gate: a forged runner greens a RED suite with a normal PASS line, and a leftover" >&2
  echo "fast-gate: '--test-only' greens a subset of cases (airhorn-v6th). Unset FAST_GATE_RUNNER and" >&2
  echo "fast-gate: re-run; to really change the runner, edit tools/gate.conf in a reviewed diff." >&2
  exit 1
fi
# FAST_GATE_BASE is the same class one knob over, so it is refused the same way (airhorn-v6th):
# the base decides WHAT IS EXAMINED, and a base at or after the change selects no path at all -
# which prints 'fast-gate: no changed files', a line the fleet contract certifies as a no-work
# pass, so an ambient base could green a change nothing ran. '--base <ref>' is the sanctioned
# spelling: it is on the command line, so the choice is in the record instead of inherited.
if [ -n "$_ENV_BASE" ]; then
  echo "fast-gate: FAIL - FAST_GATE_BASE is exported as '$_ENV_BASE'. An ambient base decides what is" >&2
  echo "fast-gate: examined: a base at or after the change selects nothing and prints 'no changed" >&2
  echo "fast-gate: files', which certifies as a no-work pass (airhorn-v6th). Unset FAST_GATE_BASE and" >&2
  echo "fast-gate: re-run, or pass '--base <ref>' on the command line where the choice is recorded." >&2
  exit 1
fi
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

LIST=0; BUILD_PLAN=0; STAMP_DIST=0; BASE=''; EXPLICIT=()
while [ $# -gt 0 ]; do
  case $1 in
    --list)    LIST=1; shift ;;
    --build-plan) BUILD_PLAN=1; shift ;;
    --stamp-dist) STAMP_DIST=1; shift ;;
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

# --stamp-dist records the CURRENT tree and the CURRENT dist/ bytes as a matched pair,
# for repair and for tests. It asserts nothing it cannot see: if either side changes
# afterwards, the next decision rebuilds.
# --- binding dist/ to the tree: a stamp over BOTH sides (airhorn-k8sd) --------------
# The round-3 reviewer's P1a/P1b: a stamp over committed tree entries plus `git status`
# TEXT cannot see a file that is already 'M' and edited again, and a stamp that is not
# bound to the OUTPUT bytes lets an older dist/ be copied in underneath a current stamp.
# So the stamp records two CONTENT digests - the working-tree build inputs, bytes
# exactly as they are on disk (dirty or not), and the built outputs in dist/ - and
# reuse requires both to match. A stale-dist green is worse than a slow gate.
# Cost on this repo: 27 input files (~344K) and 27 output files (~332K), tens of ms.
FP_FILE_NAME='.fast-gate-stamp'

# DOCUMENTED LIMITATION (airhorn-bt55 (b)): the stamp describes ONLY the paths named here. Vite also
# reads .env, .env.local/.env.<mode>, and VITE_*/NODE_ENV from the environment, and node_modules/ -
# none of which are hashed. Today that costs nothing: this repo has no .env* file, the dependency
# tree is pinned by package.json/package-lock.json/deno.lock (which ARE hashed), and VITE_*/NODE_ENV
# change what is built only through the env the gate itself runs with (an ambient VITE_* that changes
# the bundle would not be seen here). If a .env* file ever lands, add it to the list below or the
# stamp will describe a tree that was not the one built. Deliberate, not an oversight.
input_paths() { # existing build-input paths, relative to ROOT
  local p
  for p in src public index.html package.json package-lock.json deno.lock; do
    [ -e "$ROOT/$p" ] && printf '%s\n' "$p"
  done
  for p in "$ROOT"/vite.config.*; do
    [ -e "$p" ] && printf '%s\n' "${p#"$ROOT"/}"
  done
}

digest_fail() { echo "fast-gate: digest: cannot read $1" >&2; return 1; }

content_digest() { # $1 = directory to walk from, rest = paths inside it
  local base=$1; shift
  [ "$#" -gt 0 ] || { echo "empty"; return 0; }
  # A hole in the digest reads as "unchanged", and "unchanged" is REUSE - so an unreadable or
  # symlinked input used to make the stamp blind to it forever instead of failing (airhorn-bt55
  # (a)). Every named path must exist, be readable, and be a real file: the bytes hashed have to
  # be the bytes built, or there is no honest digest to take.
  local p
  for p in "$@"; do
    [ -L "$base/$p" ] && { digest_fail "$p (it is a symlink, so the bytes hashed here are not the bytes built)"; return 1; }
    [ -r "$base/$p" ] || { digest_fail "$p (missing or unreadable)"; return 1; }
  done
  # A symlink ANYWHERE under the hashed paths is the same hole one level down (`find -type f` does
  # not descend it, so its bytes are simply absent from the digest). Name it and refuse.
  local link
  link=$( cd "$base" 2>/dev/null && find "$@" -type l -print 2>/dev/null | LC_ALL=C sort | head -1 )
  [ -n "$link" ] && { digest_fail "$link (it is a symlink, so the bytes hashed here are not the bytes built)"; return 1; }
  local out rc
  : > "$TMP/digest.err"
  out=$( cd "$base" || exit 1
         set -o pipefail
         find "$@" -type f -print0 2>>"$TMP/digest.err" \
           | LC_ALL=C sort -z \
           | xargs -0 -r sha256sum 2>>"$TMP/digest.err" \
           | sha256sum 2>>"$TMP/digest.err" | awk '{print $1}' )
  rc=$?
  if [ "$rc" -ne 0 ]; then
    sed 's/^/fast-gate: digest: /' "$TMP/digest.err" 2>/dev/null >&2
    digest_fail "the build inputs under $base (pipeline exit $rc)"
    return 1
  fi
  printf '%s\n' "$out"
}

inputs_digest() {
  local paths=()
  mapfile -t paths < <(input_paths)
  content_digest "$ROOT" ${paths[@]+"${paths[@]}"}
}

outputs_digest() { # everything in dist/ except the stamp itself
  [ -d "$ROOT/dist" ] || { echo "empty"; return 0; }
  local out rc
  : > "$TMP/digest-out.err"
  out=$( cd "$ROOT/dist" || exit 1
         set -o pipefail
         find . -type f ! -name "$FP_FILE_NAME" -print0 2>>"$TMP/digest-out.err" \
           | LC_ALL=C sort -z \
           | xargs -0 -r sha256sum 2>>"$TMP/digest-out.err" \
           | sha256sum 2>>"$TMP/digest-out.err" | awk '{print $1}' )
  rc=$?
  if [ "$rc" -ne 0 ]; then
    sed 's/^/fast-gate: digest: /' "$TMP/digest-out.err" 2>/dev/null >&2
    digest_fail "dist/ (pipeline exit $rc)"
    return 1
  fi
  printf '%s\n' "$out"
}

read_stamp() { # prints "inputs=<h> outputs=<h>" from the stamp, or nothing
  local f="$ROOT/dist/$FP_FILE_NAME" i='' o=''
  [ -f "$f" ] || return 0
  i=$(awk -F' ' '$1=="inputs"{print $2; exit}' "$f" 2>/dev/null)
  o=$(awk -F' ' '$1=="outputs"{print $2; exit}' "$f" 2>/dev/null)
  [ -n "$i" ] && [ -n "$o" ] && echo "inputs=$i outputs=$o"
  return 0
}

write_stamp() { # [$1 = the PRE-build inputs digest]; without it, digest the inputs now
  # The caller in the build path passes the digest it took BEFORE the build (airhorn-bt55 P1):
  # a stamp must describe the tree the build READ, never the tree it left behind. --stamp-dist
  # passes nothing, because it stamps an existing dist/ without building - test/repair only.
  local want_in=${1:-}
  if [ -z "$want_in" ]; then want_in=$(inputs_digest) || return 1; fi
  mkdir -p "$ROOT/dist"
  local want_out
  want_out=$(outputs_digest) || return 1
  { echo "inputs $want_in"; echo "outputs $want_out"; } > "$ROOT/dist/$FP_FILE_NAME"
}

# --stamp-dist is TEST/REPAIR ONLY (airhorn-bt55 (c)): it stamps whatever is in dist/ as if a build
# had just produced it, WITHOUT building - so it can bless bytes no build ever made, and reuse them
# until an input changes. It exists so the pins can set up a stamped dist/ in milliseconds. It is
# not a way to make a tree green; the gate itself always stamps from a build it just ran.
if [ "$STAMP_DIST" -eq 1 ]; then
  write_stamp || { echo "fast-gate: FAIL - --stamp-dist could not digest dist/ (see above)." >&2; exit 1; }
  echo "fast-gate: stamped dist/ ($(read_stamp))"
  exit 0
fi

# Read MAP once into memory:
MAP_ROWS_PAT=()
MAP_ROWS_REST=()
MAP_ROWS_DERIVED=()
declare -A PENDING_SET=()
declare -A REACHABLE_SET=()
EXEMPT_PATTERNS=()

while IFS=$'\t' read -r pat rest || [ -n "$pat" ]; do
  case $pat in ''|\#*) continue ;; esac
  MAP_ROWS_PAT+=("$pat")
  MAP_ROWS_REST+=("$rest")
  # `@importers` rows DERIVE their suite set from the tree at run time (airhorn-ooqm): the scan is
  # tools/derive-coverage-contract.mjs's, the same one that derives the contract, so a NEW importer
  # is selected with no map edit. Padding the case word lets an exact `@importers` value match too.
  derived_row=""
  case " $rest " in *" @importers "*) derived_row=1 ;; esac
  MAP_ROWS_DERIVED+=("$derived_row")
  case $pat in
    ~*)
      for s in $rest; do PENDING_SET["$s"]=1; REACHABLE_SET["$s"]=1; done ;;
    \!*)
      [ -n "${pat#!}" ] && EXEMPT_PATTERNS+=("${pat#!}") ;;
    *)
      # A derived row's tokens are DIRECTIVES, not suite names; its suites are scanned below only
      # for the paths actually changed (an eager scan would cost every gate run). The reverse
      # reachability check is unaffected: every discovered suite carries its own self-row.
      if [ -z "$derived_row" ]; then
        for s in $rest; do REACHABLE_SET["$s"]=1; done
      fi ;;
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
      if [ -n "${MAP_ROWS_DERIVED[$i]-}" ]; then
        printf '%s\n' "${DERIVED_FOR[$pat]-}"          # scanned once, in derived_suites_for_changed
      else
        printf '%s\n' ${MAP_ROWS_REST[$i]}          # word-split on purpose: one row names several suites
      fi
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

# --- expand every `@importers` row this run actually needs (airhorn-ooqm) --------------------------
# Run-time derivation, not a hand-kept list: a change to a shared helper selects every suite that
# REFERENCES it, so a new importer is covered with no map edit. Scanned only for the changed paths
# that hit such a row, so a gate that never touches a helper pays nothing. Every failure mode is
# loud - a scan error or an EMPTY result would otherwise read as "no suite covers this".
declare -A DERIVED_FOR=()
for f in ${CHANGED[@]+"${CHANGED[@]}"}; do
  for i in "${!MAP_ROWS_PAT[@]}"; do
    [ -n "${MAP_ROWS_DERIVED[$i]-}" ] || continue
    pat="${MAP_ROWS_PAT[$i]}"
    if [ "$f" != "$pat" ] || [ -n "${DERIVED_FOR[$pat]-}" ]; then continue; fi
    excepts=()
    for t in ${MAP_ROWS_REST[$i]}; do case $t in except=*) excepts+=(--except "${t#except=}") ;; esac; done
    if ! derived=$(node "$HERE/derive-coverage-contract.mjs" --importers "$pat" ${excepts[@]+"${excepts[@]}"}); then
      echo "fast-gate: FAIL - the @importers row for $pat could not be scanned (see above)." >&2
      exit 1
    fi
    derived=$(printf '%s\n' "$derived" | sed '/^$/d')
    if [ -z "$derived" ]; then
      echo "fast-gate: FAIL - the @importers row for $pat derives NO suite, so a change to it would run" >&2
      echo "fast-gate: nothing at all. Fix the row or the scan; never let it select an empty set." >&2
      exit 1
    fi
    DERIVED_FOR["$pat"]="$derived"
    # stderr on purpose: --list's stdout is a MACHINE-READABLE suite list (tests parse it), so an
    # informational line there would corrupt the query it is reporting on.
    printf 'fast-gate: derived: %s -> %s suite(s)\n' "$pat" "$(printf '%s\n' "$derived" | wc -l | tr -d ' ')" >&2
  done
done

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

# --- the dist/ build decision, in ONE place (airhorn-k8sd, airhorn-5pqg) -----------
# Two callers ask this question: --build-plan (the millisecond query) and the gate
# itself. A rule that exists twice drifts, so both call build_decision and only the
# printing differs. The freshness arm is the fix for airhorn-k8sd: after rebasing onto
# an advancing master, CHANGED contains only the lane's own delta, so "did this delta
# touch a build input" is the WRONG question - dist/ can be stale while the delta is
# tests-only. Comparing the WORKING-TREE CONTENT DIGESTS of the build inputs and of dist/ against
# the stamp asks the question that actually matters: was dist/ built from the bytes we are about
# to test? (mtimes were the first attempt and were dropped: a checkout rewrites them.)
# Does any selected suite actually READ dist/? A suite that never touches dist/ does
# not care whether it is fresh, so a tree that only selects those must not pay for a
# build (and must not fail for want of one). Conservative on purpose: a suite that
# merely MENTIONS dist/ counts, because gate-smoke spawns the gate in its own pins.
suites_need_dist() {
  # Match the TOKEN `dist`, not the literal "dist/" (airhorn-nh8y): suites build the
  # path as path.join(__dirname, '../dist'), so a slash-only pattern misses them and the
  # gate would keep - or refuse to make - a dist/ they read. Bounded so `distribution`
  # and `distDir` (which contains the token as a prefix only) do not count as a whole
  # word: uppercase D after dist is a different identifier, not a path segment.
  local s
  for s in "$@"; do
    [ -f "$ROOT/$s" ] || continue
    grep -qE '(^|[^[:alnum:]_])dist([^[:alnum:]_]|$)|/dist([/"'\'']|$)' "$ROOT/$s" 2>/dev/null && return 0
    # A suite that spawns the gate can make a child gate serve dist/ even when the
    # suite's own text never names it (the airhorn-0ct pin does exactly that).
    grep -qE 'fast-gate\.sh' "$ROOT/$s" 2>/dev/null && return 0
  done
  return 1
}

build_decision() { # [suite...]; prints "<build|keep> <reason>"; never builds, never exits
  # The suite list is an ARGUMENT so the --build-plan query can ask the question before the
  # gate has split the selection into RUN/PENDING/MISSING (airhorn-ocqw). Absent an argument
  # the gate's own selection is used, exactly as before. suites_need_dist skips files that do
  # not exist, so a list that still contains pending suites answers the same as RUN would.
  local suites=(${1+"$@"})
  if [ "${#suites[@]}" -eq 0 ]; then suites=(${RUN[@]+"${RUN[@]}"}); fi
  if [ "${FAST_GATE_FORCE_BUILD:-0}" = "1" ]; then
    echo "build FAST_GATE_FORCE_BUILD=1"; return
  fi
  if ! suites_need_dist ${suites[@]+"${suites[@]}"}; then
    echo "keep no selected suite reads dist/"; return
  fi
  if [ ! -f "$ROOT/dist/index.html" ]; then
    echo "build no dist/index.html to reuse"; return
  fi
  local stamp want_in want_out
  stamp=$(read_stamp)
  if [ -z "$stamp" ]; then
    echo "build dist/ carries no stamp, so its bytes are unverified"; return
  fi
  want_in=$(inputs_digest)
  want_out=$(outputs_digest)
  # The stamp always carries "inputs=... outputs=...", so `${stamp#*inputs=}` can never equal a bare
  # digest - that half of this test was dead and only made the live half look redundant
  # (airhorn-bt55 (d)). One test, the one that works.
  if [[ " $stamp " != *" inputs=$want_in "* ]]; then
    echo "build the working-tree build inputs changed (stamp $stamp, now inputs=$want_in)"; return
  fi
  if [[ " $stamp " != *" outputs=$want_out "* ]]; then
    echo "build the bytes in dist/ changed since the stamp (now outputs=$want_out)"; return
  fi
  echo "keep dist/ is stamped for these inputs and these output bytes (inputs=$want_in)"
}
# --- `--build-plan` is a QUERY, not a verdict: answer BEFORE any verdict exit (airhorn-ocqw) ---------
# It used to sit at the bottom of the script, after the unmapped and zero-suite exits, so the two
# changes a human is most likely to ask about - an exempt-only change and an unmapped one - exited
# before the question was answered. The answer now names WHY the selection is empty (the exemption
# row, the unmapped path, the deleted suite), so the query always reports something actionable.
# READ-ONLY: build_decision only inspects (no build, no fetch, no stamp write), and this block exits
# before the build section - `--stamp-dist` is the only flag that ever writes, and it is not reached.
build_plan_answer() {
  local _decision
  if [ "${#CHANGED[@]}" -eq 0 ]; then
    echo "fast-gate: build-plan: no changed files (nothing to decide)"
    return 0
  fi
  # SELECTED, not RUN: this runs before the pending/missing split, and suites_need_dist ignores
  # suites that are not on disk, so the answer is the same one the gate would act on.
  _decision=$(build_decision ${SELECTED[@]+"${SELECTED[@]}"})
  echo "fast-gate: build-plan: ${_decision%% *} (${_decision#* })"
  local f
  for f in ${UNMAPPED[@]+"${UNMAPPED[@]}"}; do
    echo "fast-gate: build-plan: unmapped: $f (no row and no exemption - the real gate FAILS this change; nothing is selected for it)"
  done
  for f in ${EXEMPT_PATHS[@]+"${EXEMPT_PATHS[@]}"}; do
    echo "fast-gate: build-plan: exempt: $f (matched a '!' row - no suite covers it, so it selects nothing)"
  done
  for f in ${DELETED_SUITE_PATHS[@]+"${DELETED_SUITE_PATHS[@]}"}; do
    echo "fast-gate: build-plan: deleted-suite: $f (no file left to run, so it selects nothing)"
  done
  return 0
}

if [ "$BUILD_PLAN" -eq 1 ]; then
  build_plan_answer
  exit 0
fi

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


# --- build once: the browser suites serve dist/ (a11y, sw-offline). ---------
# The first measurement of `npm run build` on a loaded 2-core VM was 48 s wall; the author's own
# timing of the settled script is 0.6-1.2 s (vite bundle + copy, `npm run` startup included). Even at
# the higher figure it is most of a fast gate for a change that cannot affect the bundle. So build
# only when something the build READS changed (airhorn-onz0b, sanctioned by coord as docs/speed.md
# R2); a tools/, tests/ or docs-only change reuses the dist/ already on disk, and the browser suites
# serve the same bytes they would have got. FAST_GATE_FORCE_BUILD=1 overrides.
mkdir -p "$RESULTS_DIR"
_decision=$(build_decision)
if [ "${_decision%% *}" = "keep" ]; then
  echo "fast-gate: keeping dist/ (${_decision#* })"
else
  echo "fast-gate: building dist (${_decision#* })"
fi
if [ "${_decision%% *}" != "keep" ]; then
  # The stamp must describe the tree the build READ, not the tree it left behind (airhorn-bt55 P1).
  # write_stamp used to re-digest the inputs AFTER the build, so a build that modifies its own inputs
  # (a codegen step, a formatter, a lockfile touch) stamped POST-build bytes over a dist/ built from
  # PRE-build ones - and the next run reused it: a stale-dist green, which this file's own rule says
  # is worse than a slow gate. So take the digest BEFORE, and if the build moved the inputs, write NO
  # stamp at all: nothing describes these bytes, and the next run rebuilds.
  pre_in=$(inputs_digest) || pre_in=''
  if ! (cd "$ROOT" && npm run build --silent) >"$TMP/build.log" 2>&1; then
    echo "fast-gate: failed: build"
    sed 's/^/    /' "$TMP/build.log" 2>/dev/null | tail -20
    echo "fast-gate: FAIL - build failed; browser suites cannot run." >&2
    exit 1
  fi
  post_in=$(inputs_digest) || post_in=''
  if [ -z "$pre_in" ]; then
    echo "fast-gate: not stamping dist/: the pre-build input digest could not be taken, so no stamp describes these bytes; the next run rebuilds" >&2
  elif [ "$post_in" != "$pre_in" ]; then
    echo "fast-gate: not stamping dist/: the build changed its own inputs (before=$pre_in after=${post_in:-unreadable}), so no stamp describes a dist/ built from these bytes; the next run rebuilds" >&2
  elif ! write_stamp "$pre_in"; then
    echo "fast-gate: not stamping dist/: the built bytes could not be digested (see above); the next run rebuilds" >&2
  fi
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

  # Preserve failing suite output in durable locations (size-capped at 512KB).
  # If a check record exists, scope the log name with the record's attempt timestamp (airhorn-4o5m)
  # so a re-gate of the same tree does not overwrite the log cited by earlier rotated records.
  local tree dest_dirs=()
  dest_dirs+=("$RESULTS_DIR/failing-suites")
  local checks_dir="${AIRHORN_CHECKS_DIR:-$HOME/.fleet/checks}"
  tree=$(git rev-parse -q --verify 'HEAD^{tree}' 2>/dev/null || true)
  local rec="" attempt_suffix=""
  if [ -n "$tree" ] && [ -d "$checks_dir" ]; then
    dest_dirs+=("$checks_dir/$tree.fast.failing-suites")
    rec="$checks_dir/$tree.fast.json"
    if [ -f "$rec" ] && command -v jq >/dev/null 2>&1; then
      local rec_at
      rec_at=$(jq -r '.at // empty' "$rec" 2>/dev/null || true)
      if [ -n "$rec_at" ]; then
        attempt_suffix=".$(printf '%s' "$rec_at" | tr -dc '0-9A-Za-z')"
      fi
    fi
  fi
  if [ -n "${AIRHORN_FAILING_SUITES_DIR:-}" ]; then
    dest_dirs+=("$AIRHORN_FAILING_SUITES_DIR")
  fi

  for d in "${dest_dirs[@]}"; do
    mkdir -p "$d" 2>/dev/null || true
    local target_file="$d/$key.log"
    if [ "$d" = "$checks_dir/$tree.fast.failing-suites" ] && [ -n "$attempt_suffix" ]; then
      target_file="$d/$key$attempt_suffix.log"
    fi
    rm -f "$target_file" 2>/dev/null || true
    if tail -c 524288 "$log" > "$target_file" 2>/dev/null && [ -s "$target_file" ]; then
      echo "fast-gate: suite log preserved at $target_file"
      if [ "$target_file" != "$d/$key.log" ]; then
        rm -f "$d/$key.log" 2>/dev/null || true
        cp -f "$target_file" "$d/$key.log" 2>/dev/null || true
      fi
    else
      echo "fast-gate: warning: suite log could not be preserved at $target_file" >&2
    fi
  done

  # If running under fleet-check and the JSON check record exists, embed failing suite info.
  # Only cite the preserved log path if the file was actually written to disk (airhorn-xw3i).
  if [ -n "$rec" ] && [ -f "$rec" ] && command -v jq >/dev/null 2>&1; then
    local snippet
    snippet=$(awk '
      /^not ok / { in_fail=1 }
      in_fail { print; if (/^[ \t]*\.\.\.[ \t]*$/) in_fail=0 }
    ' "$log" 2>/dev/null | head -n 30)
    [ -n "$snippet" ] || snippet=$(tail -n 25 "$log" 2>/dev/null)
    local cited_path="$checks_dir/$tree.fast.failing-suites/$key${attempt_suffix:-}.log"
    if [ -s "$cited_path" ]; then
      jq --arg s "$s" --arg p "$cited_path" --arg snip "$snippet" \
        '.failing_suites = ((.failing_suites // {}) + {($s): {log: $p, snippet: $snip}})' \
        "$rec" > "$rec.tmp.$$" 2>/dev/null && mv -f "$rec.tmp.$$" "$rec" || rm -f "$rec.tmp.$$"
    else
      jq --arg s "$s" --arg snip "$snippet" \
        '.failing_suites = ((.failing_suites // {}) + {($s): {snippet: $snip}})' \
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
