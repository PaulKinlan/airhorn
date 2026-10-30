#!/usr/bin/env node
/**
 * tools/derive-coverage-contract.mjs — derive .fleet/coverage-contract.json from tools/suite-map.tsv.
 * Single source of truth for file-to-suite mapping (airhorn-y7mx).
 *
 * It also owns the IMPORT SCAN behind `@importers` map rows (airhorn-ooqm): a shared test helper's
 * suite set is derived from the tree at run time instead of being hand-listed, so a new importer is
 * covered with no map edit and a stale list cannot silently under-select.
 *
 * Usage:
 *   node tools/derive-coverage-contract.mjs             # updates .fleet/coverage-contract.json
 *   node tools/derive-coverage-contract.mjs --check     # verifies .fleet/coverage-contract.json is fresh (exit 0/1)
 *   node tools/derive-coverage-contract.mjs --stdout    # prints generated json to stdout
 *   node tools/derive-coverage-contract.mjs --importers <module> [--except <file>]...
 *                                                       # the suites that REFERENCE <module>, one per line
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Converts a glob pattern (supporting * and **) to a RegExp.
 */
export function globToRegex(glob) {
  let reStr = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        reStr += '(?:.+/)?';
        i += 3;
      } else {
        reStr += '.*';
        i += 2;
      }
    } else if (c === '*') {
      reStr += '[^/]*';
      i += 1;
    } else if (c === '?') {
      reStr += '[^/]';
      i += 1;
    } else if (c === '[') {
      const closingIdx = glob.indexOf(']', i + 1);
      if (closingIdx !== -1) {
        let inner = glob.slice(i + 1, closingIdx);
        let negated = false;
        if (inner.startsWith('!') || inner.startsWith('^')) {
          negated = true;
          inner = inner.slice(1);
        }
        let classPattern = '';
        for (let j = 0; j < inner.length; j++) {
          const ch = inner[j];
          if (ch === '-' && j > 0 && j < inner.length - 1) {
            classPattern += '-';
          } else if ('\\^$-[]'.includes(ch)) {
            classPattern += '\\' + ch;
          } else {
            classPattern += ch;
          }
        }
        if (negated) {
          reStr += '[^/' + classPattern + ']';
        } else {
          reStr += '[' + classPattern.replace(/\//g, '') + ']';
        }
        i = closingIdx + 1;
      } else {
        reStr += '\\[';
        i += 1;
      }
    } else if ('+?.()|^$[]{}'.includes(c)) {
      reStr += '\\' + c;
      i += 1;
    } else {
      reStr += c;
      i += 1;
    }
  }
  reStr += '$';
  return new RegExp(reStr);
}

/**
 * The default presence predicate: a root-relative path is present only if it is a
 * REGULAR FILE (a symlink to one counts, `statSync` follows it).
 *
 * `fs.existsSync` also answers true for a directory, and that was a hole in the
 * validator itself: a row naming `src/lib`, or a suite column naming a directory,
 * validated as "exists on disk" while selecting nothing - a silent hole in the map,
 * which is the one thing this tool exists to catch. An empty path resolves to the
 * root directory and passed for the same reason, so a bare `!` or `~` row exempted
 * or deferred nothing and said nothing (airhorn-nxuv.21).
 */
const fileAt = (root) => (relPath) => {
  try {
    return fs.statSync(path.join(root, relPath)).isFile();
  } catch {
    return false;
  }
};

/**
 * "Is there anything at this path at all" - file, directory or symlink.
 *
 * The pending rule needs this and not `fileAt`: a suite is PENDING when it is
 * declared (or written with the `test/` spelling) and has not landed yet. A path
 * that exists as a DIRECTORY has landed as something, and it is not a suite, so
 * treating it as "absent" would let `~phantom<TAB>tests` (or a `test/`-prefixed
 * directory) skip validation and vanish from the derived contract - the same
 * silent hole the file-only presence check closed for plain rows
 * (airhorn-nxuv.21 review, P1).
 */
const existsAt = (root) => (relPath) => {
  try {
    fs.statSync(path.join(root, relPath));
    return true;
  } catch {
    return false;
  }
};

/**
 * Why a path is not usable, for the violation message: "does not exist" must never
 * be said about something that is right there as a directory.
 */
function presenceProblem(root, relPath) {
  try {
    return fs.statSync(path.join(root, relPath)).isDirectory()
      ? 'is a directory, not a file'
      : 'is not a regular file';
  } catch {
    return 'does not exist on disk';
  }
}

/**
 * Checks whether a glob pattern matches at least one file on disk.
 */
export function globMatchesAny(pattern, { root = DEFAULT_ROOT, existsFn, fileExists: fileExistsOpt } = {}) {
  const fileExists = existsFn || fileExistsOpt || fileAt(root);

  if (!pattern.includes('*') && !pattern.includes('?') && !pattern.includes('[')) {
    return fileExists(pattern);
  }

  const baseDirPart = pattern.split(/[*?[]/)[0];
  const lastSlash = baseDirPart.lastIndexOf('/');
  const baseDir = lastSlash >= 0 ? baseDirPart.slice(0, lastSlash) : '';

  const dirOnDisk = baseDir ? path.join(root, baseDir) : root;

  let stat;
  try {
    stat = fs.statSync(dirOnDisk);
  } catch {
    return false;
  }
  if (!stat.isDirectory()) {
    return false;
  }

  const regex = globToRegex(pattern);

  function walk(currentDir, relPrefix) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const ent of entries) {
      const childRel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (walk(path.join(currentDir, ent.name), childRel)) {
          return true;
        }
      } else {
        if (regex.test(childRel)) {
          return true;
        }
      }
    }
    return false;
  }

  return walk(dirOnDisk, baseDir);
}

/**
 * Validates suite-map integrity across all 4 violation classes:
 * 1. zero_match_glob: Pattern contains wildcards but matches 0 files under root.
 * 2. missing_literal: Plain pattern path does not exist on disk (! and ~ rows skipped).
 * 3. glob_suite_token: Suite token contains wildcard metacharacters (*, ?, [).
 * 4. missing_suite: Suite file is missing from disk and not declared pending.
 *
 * Returns Array<{ type: string, token: string, pattern?: string, message: string }>
 */
export function validateSuiteMap(tsvText, { root = DEFAULT_ROOT, existsFn, fileExists: fileExistsOpt, pathExists: pathExistsOpt } = {}) {
  const fileExists = existsFn || fileExistsOpt || fileAt(root);
  const pathExists = pathExistsOpt || existsFn || fileExistsOpt || existsAt(root);
  const pendingDeclared = extractPendingSuites(tsvText);
  const violations = [];

  for (const line of tsvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    const pattern = parts[0] ? parts[0].trim() : '';
    if (!pattern) continue;

    // A bare marker is not a row. '!' or '~' with no path after it exempts or defers
    // nothing, and it used to validate as fine because the empty path resolved to the
    // root DIRECTORY and `fs.existsSync(root)` is true (airhorn-nxuv.21).
    if (pattern === '!' || pattern === '~') {
      violations.push({
        type: 'empty_pattern',
        token: pattern,
        pattern,
        message: `Row is only the '${pattern}' marker, with no path after it: it exempts/defers nothing`,
      });
      continue;
    }

    const suiteTokens = parts.slice(1).join(' ').trim().split(/\s+/).filter(Boolean);

    // Directive tokens are not suite paths: `@importers` makes the suite set a RUN-TIME scan of the
    // tree (airhorn-ooqm), and `except=<file>` names a suite deliberately kept off such a row.
    const directives = suiteTokens.filter(isDirective);
    const listedTokens = suiteTokens.filter((t) => !isDirective(t));
    if (directives.includes('@importers')) {
      if (pattern.startsWith('~') || pattern.startsWith('!')) {
        violations.push({
          type: 'derived_row_kind',
          token: pattern,
          pattern,
          message: `@importers is only valid on a plain row, not on '${pattern[0]}' (${pattern})`,
        });
      }
      if (!fileExists(pattern)) {
        violations.push({
          type: 'missing_literal',
          token: pattern,
          pattern,
          message: `@importers row names a module that ${presenceProblem(root, pattern)}: ${pattern}`,
        });
      }
      for (const d of directives.filter((t) => t.startsWith('except='))) {
        const target = d.slice('except='.length);
        if (!fileExists(target)) {
          violations.push({
            type: 'missing_suite',
            token: target,
            pattern,
            message: `except= names a suite that ${presenceProblem(root, target)}: ${target} (referenced by ${pattern})`,
          });
        }
      }
      // A derived row that scans to NOTHING is a silent hole: the module exists, no suite references
      // it, so a change to it would select no suite at all. Fail loudly here instead.
      if (importersOf(pattern, { root, fileExists }).length === 0) {
        violations.push({
          type: 'no_importers',
          token: pattern,
          pattern,
          message: `@importers row derives an EMPTY suite set - no suite references ${pattern}`,
        });
      }
    }

    // 1 & 2. Pattern side validation
    if (pattern.startsWith('~')) {
      // Pending declaration: allowed to be absent until landed
    } else if (pattern.startsWith('!')) {
      const cleanPat = pattern.slice(1);
      const isGlob = cleanPat.includes('*') || cleanPat.includes('?') || cleanPat.includes('[');
      if (isGlob) {
        if (!globMatchesAny(cleanPat, { root, existsFn, fileExists })) {
          violations.push({
            type: 'zero_match_glob',
            token: pattern,
            pattern,
            message: `Exemption glob pattern matches zero files on disk: ${pattern}`,
          });
        }
      } else {
        if (!fileExists(cleanPat)) {
          violations.push({
            type: 'missing_literal',
            token: pattern,
            pattern,
            message: `Exemption path ${presenceProblem(root, cleanPat)}: ${pattern}`,
          });
        }
      }
    } else {
      const isGlob = pattern.includes('*') || pattern.includes('?') || pattern.includes('[');
      if (isGlob) {
        if (!globMatchesAny(pattern, { root, existsFn, fileExists })) {
          violations.push({
            type: 'zero_match_glob',
            token: pattern,
            pattern,
            message: `Mapped glob pattern matches zero files on disk: ${pattern}`,
          });
        }
      } else {
        if (!fileExists(pattern)) {
          violations.push({
            type: 'missing_literal',
            token: pattern,
            pattern,
            message: `Mapped path ${presenceProblem(root, pattern)}: ${pattern}`,
          });
        }
      }
    }

    // 3 & 4. Suite side validation
    for (const token of listedTokens) {
      if (token.includes('*') || token.includes('?') || token.includes('[')) {
        violations.push({
          type: 'glob_suite_token',
          token,
          pattern,
          message: `Suite token contains wildcard metacharacters: ${token} (referenced by ${pattern})`,
        });
        continue;
      }

      if (isPendingSuite(token, pendingDeclared, fileExists, pathExists)) {
        continue;
      }

      if (!fileExists(token)) {
        violations.push({
          type: 'missing_suite',
          token,
          pattern,
          message: `Suite ${presenceProblem(root, token)}: ${token} (referenced by ${pattern})`,
        });
      }
    }
  }

  return violations;
}

/**
 * Extracts all suite paths declared pending via ~ rows.
 */
export function extractPendingSuites(tsvText) {
  const pendingDeclared = new Set();
  for (const line of tsvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    const pat = parts[0] ? parts[0].trim() : '';
    if (pat.startsWith('~')) {
      const suiteTokens = parts.slice(1).join(' ').trim().split(/\s+/).filter(Boolean);
      for (const s of suiteTokens) {
        pendingDeclared.add(s);
      }
    }
  }
  return pendingDeclared;
}

/**
 * Checks whether a suite is currently pending: declared as `~...` (or written with
 * the `test/` spelling) AND not on disk at all.
 *
 * `pathExists` is deliberately separate from `fileExists`: a DIRECTORY at the suite
 * path is not a pending suite, it is a suite path that is not a file, and the
 * caller must report it as such. It defaults to `fileExists` so the exported
 * signature keeps working for callers that have only one predicate.
 */
export function isPendingSuite(suite, pendingDeclared, fileExists, pathExists = fileExists) {
  return (suite.startsWith('test/') || pendingDeclared.has(suite)) && !pathExists(suite);
}

// --- `@importers` rows: the suite set is DERIVED from the tree, not hand-listed (airhorn-ooqm) ----
//
// Hand-listing a shared helper's importers had already recurred six times (airhorn-5t8, -ckq, -dco,
// -906, -ooqm): a helper gains a caller, the row keeps its snapshot, and a change every caller depends
// on is gated by two suites. A row may therefore say `@importers` instead of naming suites, and the
// set is computed here - at gate run time AND when the contract is derived, from ONE implementation.
//
// The scan is import-shape-agnostic on purpose - it does not require one syntactically static import.
// Every MODULE-RESOLUTION construct counts: `from '...'`, `import '...'`, `import('...')`,
// `require('...')`, and a COMPUTED reference through path.join/path.resolve/pathToFileURL/new URL/
// require.resolve (`path.join(import.meta.dirname, 'helper.mjs')`). All of those shapes are already in
// this tree, and the first attempt at this bead only understood the static one - which is how it missed
// the computed reference in tests/test-support.test.js and read as a pass.
//
// A bare quoted path with no resolution construct around it is NOT a dependency: a suite that merely
// names the file (a fixture string, a map row, this scanner's own assertions) does not import it, and
// counting those would make the gate's selection depend on who is talking about the helper. The scan
// is textual, so a string literal that literally SPELLS a resolution construct still counts - the
// contrived case, and it errs toward over-selection, which costs time instead of hiding a suite.

const normRel = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Tokens of a row's suite column that are DIRECTIVES, not suite paths. */
const isDirective = (tok) => tok.startsWith('@') || tok.startsWith('except=');

/**
 * Every file in the tree that could BE a suite: `*.test.{js,mjs,ts}` under tests/ or test/, plus any
 * file the map already names in a suite column (tests/acceptance.mjs is a suite that matches no
 * test-file pattern, and is explicit-only by design - airhorn-i8i).
 */
export function suiteFiles(tsvText, { root = DEFAULT_ROOT, fileExists: fileExistsOpt } = {}) {
  const fileExists = fileExistsOpt || fileAt(root);
  const named = new Set();
  for (const line of tsvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    for (const tok of parts.slice(1).join(' ').trim().split(/\s+/).filter(Boolean)) {
      if (!isDirective(tok)) named.add(normRel(tok));
    }
  }
  const out = new Set();
  const walk = (dirRel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, dirRel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const rel = normRel(path.posix.join(dirRel, ent.name));
      if (ent.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!/\.(mjs|js|ts)$/.test(ent.name)) continue;
      if (/\.test\.(mjs|js|ts)$/.test(ent.name) || (named.has(rel) && fileExists(rel))) out.add(rel);
    }
  };
  walk('tests');
  walk('test');
  return [...out].sort();
}

/**
 * The suites that reference `modulePath`, in any import shape. `except` names suites that are
 * deliberately not on the row (the explicit-only acceptance pass).
 */
/**
 * Drops COMMENT text before the scan: prose that happens to spell a resolution construct (`//
 * (tests/x.test.js: path.join(dir, 'helper.mjs'))`) is not a dependency. Line-based on purpose - a
 * regex strip of `/* ... *\/` would eat real code the first time a string literal contained `/*`.
 */
const codeOnly = (text) => {
  const out = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) {
        inBlock = false;
        out.push(line.slice(line.indexOf('*/') + 2));
      }
      continue;
    }
    if (trimmed.startsWith('/*')) {
      inBlock = !trimmed.includes('*/');
      continue;
    }
    if (trimmed.startsWith('//')) continue;
    out.push(line);
  }
  return out.join('\n');
};

export function importersOf(modulePath, { root = DEFAULT_ROOT, tsvText, except = [], fileExists } = {}) {
  const tsv = tsvText ?? fs.readFileSync(path.join(root, 'tools', 'suite-map.tsv'), 'utf8');
  const target = normRel(modulePath);
  const base = path.posix.basename(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A module-resolution construct, then - within one statement - a literal that spells the basename.
  // Each alternative ends at the OPENING quote of the literal, so `[^'"`\n]*<basename>` finishes it.
  // `import` requires whitespace or `(` after it, so the identifier `importersOf(` is not a match -
  // the first version of this scanner counted this very test file that way.
  const Q = "['\"`]";
  const resolution = [
    `\\bfrom\\s*${Q}`,                                    // import { x } from './h.mjs', export ... from
    `\\bimport\\s+${Q}`,                                  // import './h.mjs' (side effect)
    `\\bimport\\s*\\(\\s*${Q}`,                        // await import('./h.mjs')
    `\\brequire\\s*\\(\\s*${Q}`,                       // require('./h.mjs')
    `\\b(?:path\\.join|path\\.resolve|require\\.resolve|createRequire)\\s*\\([^;\\n]{0,160}?${Q}`,
    `\\bpathToFileURL\\s*\\([^;\\n]{0,160}?${Q}`,
    `\\bnew URL\\s*\\([^;\\n]{0,160}?${Q}`,
  ].join('|');
  const reference = new RegExp(`(?:${resolution})[^'"\`\\n]*${base}`);
  const skip = new Set([target, ...except.map(normRel)]);
  const found = [];
  for (const suite of suiteFiles(tsv, { root, fileExists })) {
    if (skip.has(suite)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(root, suite), 'utf8');
    } catch {
      continue;
    }
    if (reference.test(codeOnly(text))) found.push(suite);
  }
  return found.sort();
}

/**
 * Expands a row's suite column: `@importers` rows are scanned, plain rows are returned as written.
 * Returns { derived, except, suites }.
 */
export function expandRow(pattern, rest, options = {}) {
  const tokens = (rest || '').trim().split(/\s+/).filter(Boolean);
  const derived = tokens.includes('@importers');
  const except = tokens.filter((t) => t.startsWith('except=')).map((t) => normRel(t.slice('except='.length)));
  if (!derived) return { derived: false, except, suites: tokens.filter((t) => !isDirective(t)) };
  return { derived: true, except, suites: importersOf(pattern, { ...options, except }) };
}

/**
 * Derives the coverage contract object from the TSV content.
 * - Filters out comments (#) and empty lines
 * - Excludes exemption rows (!), pending suite rows (~), and self-rows
 * - Filters out pending suites declared via ~ rows until they exist on disk (airhorn-u42y, airhorn-x0xr)
 * - Resolves file presence against repo root regardless of process.cwd() (airhorn-xxqq)
 * - Deduplicates suites while preserving order
 * - Accumulates multiple rows for the same pattern additively
 */
export function deriveCoverageContract(tsvText, { root = DEFAULT_ROOT, existsFn, fileExists: fileExistsOpt, pathExists: pathExistsOpt } = {}) {
  const fileExists = existsFn || fileExistsOpt || fileAt(root);
  const pathExists = pathExistsOpt || existsFn || fileExistsOpt || existsAt(root);
  const pendingDeclared = extractPendingSuites(tsvText);

  const contract = {};
  for (const line of tsvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    const pat = parts[0] ? parts[0].trim() : '';
    if (!pat || pat.startsWith('!') || pat.startsWith('~')) continue;
    const { suites } = expandRow(pat, parts.slice(1).join(' '), { root, fileExists });
    const activeSuites = suites.filter((s) => !isPendingSuite(s, pendingDeclared, fileExists, pathExists));
    if (activeSuites.length > 0 && activeSuites.every((s) => s === pat)) continue;
    if (activeSuites.length > 0) {
      if (!contract[pat]) {
        contract[pat] = [];
      }
      for (const s of activeSuites) {
        if (!contract[pat].includes(s)) {
          contract[pat].push(s);
        }
      }
    }
  }
  return contract;
}

/**
 * Derives the map opinion as a Map of pattern -> Set of active suites,
 * normalizing wildcard patterns (/** -> /*).
 */
export function deriveMapOpinion(tsvText, options = {}) {
  const contract = deriveCoverageContract(tsvText, options);
  const out = new Map();
  for (const [pattern, suites] of Object.entries(contract)) {
    const key = pattern.replace(/\/\*\*$/, '/*');
    out.set(key, new Set(suites));
  }
  return out;
}

export function formatCoverageContract(contract) {
  return JSON.stringify(contract, null, 1) + '\n';
}

// root/existsFn are injectable so the freshness GUARD can be tested for real: a
// test can point --check at a temp root and still resolve mapped paths against
// this checkout, instead of asserting that two different strings differ, which is
// true by construction and exercises nothing (airhorn-bja9). The CLI passes
// neither, so production behaviour is unchanged.
export function main(args = process.argv.slice(2), { root = DEFAULT_ROOT, existsFn, fileExists } = {}) {
  const tsvPath = path.join(root, 'tools', 'suite-map.tsv');
  const contractPath = path.join(root, '.fleet', 'coverage-contract.json');

  const tsvText = fs.readFileSync(tsvPath, 'utf8');

  // `--importers <module> [--except <file>]...` is the QUERY tools/fast-gate.sh uses to expand an
  // `@importers` row at run time: the gate asks, this scans. One implementation, so the query and
  // the contract cannot disagree (airhorn-ooqm).
  if (args.includes('--importers')) {
    const i = args.indexOf('--importers');
    const modulePath = args[i + 1];
    if (!modulePath) {
      console.error('--importers needs a module path');
      return 2;
    }
    const except = args.reduce((acc, a, idx) => (a === '--except' && args[idx + 1] ? acc.concat(args[idx + 1]) : acc), []);
    for (const suite of importersOf(modulePath, { root, tsvText, except, fileExists })) {
      process.stdout.write(`${suite}\n`);
    }
    return 0;
  }

  if (args.includes('--stdout')) {
    const derived = deriveCoverageContract(tsvText, { root, existsFn, fileExists });
    const formatted = formatCoverageContract(derived);
    process.stdout.write(formatted);
    return 0;
  }

  if (args.includes('--validate-map')) {
    const violations = validateSuiteMap(tsvText, { root, existsFn, fileExists });
    if (violations.length > 0) {
      for (const v of violations) {
        console.error(`FAIL: suite-map: [${v.type}] ${v.message}`);
      }
      return 1;
    }
    return 0;
  }

  const violations = validateSuiteMap(tsvText, { root, existsFn, fileExists });
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`FAIL: suite-map: [${v.type}] ${v.message}`);
    }
    return 1;
  }

  const derived = deriveCoverageContract(tsvText, { root, existsFn, fileExists });
  const formatted = formatCoverageContract(derived);

  if (args.includes('--check')) {
    let current = '';
    try {
      current = fs.readFileSync(contractPath, 'utf8');
    } catch (err) {
      console.error(`Coverage contract not found at ${contractPath}: ${err.message}`);
      return 1;
    }
    if (current !== formatted) {
      console.error('FAIL: .fleet/coverage-contract.json is out of date with tools/suite-map.tsv.');
      console.error('Run "node tools/derive-coverage-contract.mjs" to regenerate it.');
      return 1;
    }
    return 0;
  }

  fs.writeFileSync(contractPath, formatted, 'utf8');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const exitCode = main();
  process.exit(exitCode);
}
