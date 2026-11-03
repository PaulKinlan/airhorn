#!/usr/bin/env node
/*
 * tools/mutation-check.mjs — apply a mutation, PROVE it applied, then judge the tests.
 *
 * Why this exists (airhorn-f41e): an assertion-honesty sweep is only as good as its
 * mutation step, and a sweep that cannot tell "the mutant applied" from "nothing
 * changed" reports holes that are not there. Seven of the last sixteen findings on this
 * repo were falsified exactly that way: the "mutation" edited the TEST rather than the
 * product, or the write silently did not land, and the suite passed because nothing had
 * been mutated at all. So every step here is checked and the tool refuses rather than
 * guesses:
 *
 *   1. the target must be PRODUCT code (tests/ is refused unless --allow-test-mutation,
 *      because a test edit is not a product mutation and must never count as one);
 *   2. `--from` must occur EXACTLY once (zero = the mutation does not apply; more =
 *      ambiguous, so a different occurrence may have been hit);
 *   3. after writing, the file is re-read and must differ from the original AND contain
 *      `--to` - the compare-and-discard guard: a mutant that did not land is an error,
 *      never a result;
 *   4. the original is restored in a finally block and the restore is verified;
 *   5. the verdict is the triad, not a boolean:
 *        hole-proven        OLD suite passes the mutant, NEW suite fails it
 *        not-reproducible   OLD suite already fails the mutant (the guard is elsewhere)
 *        fix-does-not-close NEW suite still passes the mutant (the new check is blind)
 *
 * Usage:
 *   node tools/mutation-check.mjs --file src/badge.js --from "a" --to "b" \
 *     --suite tests/multitab.test.mjs [--suite-old /tmp/old-suite.mjs] \
 *     [--build "npx --no-install vite build"] [--allow-test-mutation] [--dry-run]
 *
 * Exit: 0 hole-proven, 1 not-reproducible, 2 fix-does-not-close, 3 refused/error.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCT_PREFIXES_TO_REFUSE = ['tests/', 'test/'];

/** A mutation target must be product code: a test edit is not a product mutation. */
export function mutationTargetProblem(relPath, { allowTestMutation = false } = {}) {
  if (allowTestMutation) return null;
  const normalised = relPath.split(path.sep).join('/').replace(/^\.\//, '');
  const refused = PRODUCT_PREFIXES_TO_REFUSE.find((prefix) => normalised.startsWith(prefix));
  if (refused) {
    return `${relPath} is a TEST file, so mutating it proves nothing about the product (use --allow-test-mutation only when the test IS the subject)`;
  }
  return null;
}

/**
 * Apply one exact replacement. Returns { ok, content } or { ok: false, error } - it never
 * guesses which occurrence was meant, and it refuses a no-op mutation outright.
 */
export function applyMutation(original, from, to) {
  if (typeof original !== 'string') return { ok: false, error: 'the target was not read as text' };
  if (!from) return { ok: false, error: '--from is empty: a mutation needs exact text to replace' };
  if (from === to) return { ok: false, error: '--from and --to are identical: that is a no-op, not a mutation' };

  const occurrences = original.split(from).length - 1;
  if (occurrences === 0) {
    return { ok: false, error: 'the --from text does not occur in the target: the mutation does not apply' };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      error: `the --from text occurs ${occurrences} times: it must be unique, or a different occurrence than the one you meant may be mutated`,
    };
  }

  const mutated = original.replace(from, to);
  if (mutated === original) return { ok: false, error: 'the replacement produced an identical file: the mutation did not land' };
  return { ok: true, content: mutated };
}

/**
 * The compare-and-discard guard. `to` may be omitted when the mutation DELETES text; the
 * only non-negotiable is that the on-disk bytes change and are not the original.
 */
export function mutationApplied({ original, onDisk, to }) {
  if (typeof onDisk !== 'string') return { applied: false, reason: 'the file could not be read back after writing' };
  if (onDisk === original) return { applied: false, reason: 'the file on disk is identical to the original: the write did not land' };
  if (to && !onDisk.includes(to)) {
    return { applied: false, reason: 'the file on disk does not contain the mutant text: something rewrote it (a build hook, an editor, a formatter)' };
  }
  return { applied: true };
}

export function restoreVerified({ original, onDisk }) {
  if (typeof onDisk !== 'string') return false;
  return onDisk === original;
}

/**
 * A suite that FAILED TO RUN is not a suite that caught the mutant (review finding
 * airhorn-cmr1: `--suite tests/does-not-exist.test.mjs` scored "mutant-caught" exit 0,
 * because node exits non-zero when it cannot load the file - the tool read that as "the
 * suite fails the mutant", which is the exact confusion between "the check fired" and "the
 * check never ran" this tool exists to prevent).
 *
 * Two answers, both named:
 *   suitePresenceProblem  the file is not there at all;
 *   suiteLoadProblem      node's own stderr says it could not load/parse the file.
 * Anything else - a genuine assertion failure, a timeout inside a test - stays a failure.
 */
export function suitePresenceProblem(suite, cwd) {
  const resolved = path.resolve(cwd, suite);
  if (!fs.existsSync(resolved)) {
    return `the suite ${suite} does not exist (${resolved}) - nothing was measured, so a non-zero exit from node's loader must not count as the suite catching the mutant`;
  }
  return null;
}

const LOAD_FAILURES = [
  [/Cannot find module/, 'the module could not be found'],
  [/ERR_MODULE_NOT_FOUND/, 'a module could not be resolved'],
  [/ERR_UNSUPPORTED_DIR_IMPORT/, 'a directory was imported as a module'],
  [/SyntaxError:/, 'the file does not parse'],
];

export function suiteLoadProblem(stderr) {
  const text = String(stderr || '');
  for (const [pattern, reason] of LOAD_FAILURES) {
    if (pattern.test(text)) {
      return `could not run (${reason}) - a suite that never loaded proves nothing about the mutant`;
    }
  }
  return null;
}

/**
 * The triad. `oldRc` is the pre-change suite against the mutant, `newRc` the current one;
 * null means "not measured", which is never a pass.
 */
export function verdictFor({ oldRc, newRc }) {
  if (newRc === null) {
    return { verdict: 'unmeasured', exit: 3, why: 'the suite was never run against the mutant; a missing measurement is not a result' };
  }
  if (newRc === 0) {
    return { verdict: 'fix-does-not-close', exit: 2, why: 'the NEW suite still passes the mutant, so the new check does not catch it' };
  }
  if (oldRc === null) {
    return { verdict: 'mutant-caught', exit: 0, why: 'the suite fails the mutant; run --suite-old to say whether the hole was ever real' };
  }
  if (oldRc !== 0) {
    return { verdict: 'not-reproducible', exit: 1, why: 'the OLD suite already fails the mutant, so the guard exists somewhere in the suite already' };
  }
  return { verdict: 'hole-proven', exit: 0, why: 'the OLD suite passes the mutant and the NEW suite fails it' };
}

function parseArgs(argv) {
  const args = { allowTestMutation: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--allow-test-mutation') { args.allowTestMutation = true; continue; }
    if (flag === '--dry-run') { args.dryRun = true; continue; }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === '--file') args.file = value;
    else if (flag === '--from') args.from = value;
    else if (flag === '--to') args.to = value;
    else if (flag === '--suite') args.suite = value;
    else if (flag === '--suite-old') args.suiteOld = value;
    else if (flag === '--build') args.build = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

function run(command, shellArgs, cwd, { captureStderr = false } = {}) {
  const result = spawnSync(command, shellArgs, {
    cwd,
    stdio: captureStderr ? ['ignore', 'inherit', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  if (captureStderr && result.stderr) process.stderr.write(result.stderr);
  return { rc: result.status === null ? 1 : result.status, stderr: result.stderr || '' };
}

/** Run a suite and say both what it exited with and whether it ran at all. */
function runSuite(suite, cwd, label) {
  const presence = suitePresenceProblem(suite, cwd);
  if (presence) return { problem: presence };
  const ran = run(process.execPath, [suite], cwd, { captureStderr: true });
  const loadProblem = suiteLoadProblem(ran.stderr);
  if (loadProblem) return { problem: `${label} ${loadProblem}` };
  return { rc: ran.rc };
}

export function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`mutation-check: ${error.message}`);
    return 3;
  }

  if (!args.file || !args.from || args.suite === undefined) {
    console.error('mutation-check: --file, --from and --suite are required (see the header comment)');
    return 3;
  }
  const targetProblem = mutationTargetProblem(args.file, { allowTestMutation: args.allowTestMutation });
  if (targetProblem) {
    console.error(`mutation-check: refusing: ${targetProblem}`);
    return 3;
  }

  const absolute = path.resolve(cwd, args.file);
  const original = fs.readFileSync(absolute, 'utf8');
  const applied = applyMutation(original, args.from, args.to ?? '');
  if (!applied.ok) {
    console.error(`mutation-check: refusing: ${applied.error}`);
    return 3;
  }

  let mutantRc = 3;
  let baselineRc = null;
  try {
    fs.writeFileSync(absolute, applied.content);
    const check = mutationApplied({ original, onDisk: fs.readFileSync(absolute, 'utf8'), to: args.to });
    if (!check.applied) {
      console.error(`mutation-check: refusing: ${check.reason}`);
      mutantRc = 3;
      return 3;
    }
    console.log(`mutant applied to ${args.file} (${applied.content.length - original.length >= 0 ? '+' : ''}${applied.content.length - original.length} bytes), verified on disk`);

    if (args.build) {
      console.log(`building: ${args.build}`);
      const buildRc = run('bash', ['-lc', args.build], cwd).rc;
      if (buildRc !== 0) {
        console.error(`mutation-check: the build failed (rc=${buildRc}) - a mutant that does not build proves nothing`);
        mutantRc = 3;
        return 3;
      }
    }

    // A suite that could not run is UNMEASURED, never "caught the mutant" (airhorn-cmr1).
    if (args.suiteOld) {
      const baseline = runSuite(args.suiteOld, cwd, 'the OLD suite');
      if (baseline.problem) {
        console.error(`mutation-check: refusing: ${baseline.problem}`);
        mutantRc = 3;
        return 3;
      }
      baselineRc = baseline.rc;
    }
    const judged = runSuite(args.suite, cwd, 'the suite');
    if (judged.problem) {
      console.error(`mutation-check: refusing: ${judged.problem}`);
      mutantRc = 3;
      return 3;
    }
    mutantRc = judged.rc;
  } finally {
    fs.writeFileSync(absolute, original);
    const restored = restoreVerified({ original, onDisk: fs.readFileSync(absolute, 'utf8') });
    console.log(`restored ${args.file}: ${restored ? 'verified' : 'NOT VERIFIED - check the file by hand'}`);
    if (!restored) mutantRc = 3;
  }

  const result = verdictFor({ oldRc: args.suiteOld ? baselineRc : null, newRc: mutantRc === 3 ? null : mutantRc });
  console.log(`verdict: ${result.verdict} (${result.why})`);
  if (!args.suiteOld) {
    console.log('note: --suite-old was not given, so "mutant-caught" cannot say whether the hole was ever real (that is what "hole-proven" is for)');
  }
  return result.exit === 3 && mutantRc !== 3 ? 3 : result.exit;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
