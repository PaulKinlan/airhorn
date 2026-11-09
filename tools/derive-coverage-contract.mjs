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
 * Checks whether a glob pattern matches at least one file on disk.
 */
export function globMatchesAny(pattern, { root = DEFAULT_ROOT, existsFn, fileExists: fileExistsOpt } = {}) {
  // The default is the SAME predicate the validator uses, not fs.existsSync (airhorn-xs2m,
  // P2 from the review of this branch): the function's own contract is "matches at least
  // one FILE on disk", and existsSync answers true for a DIRECTORY - so a direct caller of
  // this exported helper still counted a symlink to a directory, exactly the false green
  // the walk fix below closed for the validator. existsSync now appears nowhere on this
  // path: a caller that wants different semantics passes its own predicate.
  const fileExists = existsFn || fileExistsOpt || ((relPath) => defaultFileIsRegular(root, relPath));

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
        // A dirent that is not a directory is not evidence of a FILE: withFileTypes
        // reports a symlink as a symlink, so a symlink -> EMPTY DIRECTORY and a symlink
        // LOOP both matched the pattern by name alone and the glob validated clean while
        // selecting nothing (airhorn-nxuv.21). The name match has to be confirmed by the
        // same presence predicate a literal path uses - master's defaultFileIsRegular when
        // it is the default (isFile, so a symlink to a real file still passes, a symlink to
        // a directory does not, and a loop throws -> false), or the caller's injected
        // predicate when the caller supplied one.
        if (regex.test(childRel) && fileExists(childRel)) {
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
 * 2. missing_literal: Plain pattern path is not a regular file on disk (! and ~ rows skipped).
 * 3. glob_suite_token: Suite token contains wildcard metacharacters (*, ?, [).
 * 4. missing_suite: Suite file is missing from disk and not declared pending.
 *
 * Returns Array<{ type: string, token: string, pattern?: string, message: string }>
 */

/*
 * The default existence check must mean "a regular FILE is there", not
 * "something is there": existsSync passes for directories, and path.join(root, '')
 * resolves to root itself, so a row naming a directory - or a bare '!' row whose
 * literal is empty - validated clean while watching nothing (the tools/
 * assertion-honesty sweep). statSync().isFile() also fails a symlink TO A
 * DIRECTORY (the target is not a file), while a symlink to a real file still
 * passes. describeNonFile says WHAT is there instead, for the violation message;
 * both are exported so the fixture harness drives the real predicates.
 */
export const defaultFileIsRegular = (root, relPath) => {
  if (!relPath) return false;
  try {
    return fs.statSync(path.join(root, relPath)).isFile();
  } catch {
    return false;
  }
};

/*
 * What a path on disk IS, as a value logic can branch on. 'pending' means
 * "not created yet"; a path that EXISTS but is not a regular file is a
 * different world - it must surface as a violation, never read as pending
 * (the tools/ sweep residual: with an isFile-style existence check a
 * directory at a test/-spelled suite path read 'not a file' -> 'pending' and
 * validated clean).
 */
export const pathKind = (root, relPath) => {
  if (!relPath) return 'empty'; // path.join(root, '') resolves to the root itself
  const full = path.join(root, relPath);
  let lst;
  try {
    lst = fs.lstatSync(full);
  } catch {
    return 'missing';
  }
  if (lst.isSymbolicLink()) {
    let target;
    try {
      target = fs.statSync(full);
    } catch {
      return 'symlink-broken';
    }
    if (target.isFile()) return 'file';
    return target.isDirectory() ? 'symlink-to-directory' : 'symlink-to-nonfile';
  }
  if (lst.isFile()) return 'file';
  if (lst.isDirectory()) return 'directory';
  return 'other-nonfile';
};

export const describeNonFile = (root, relPath) => {
  switch (pathKind(root, relPath)) {
    case 'empty': return 'an empty path (path.join(root, \'\') resolves to the root itself)';
    case 'missing': return 'missing from disk';
    case 'symlink-to-directory': return 'a symlink to a directory, not a file';
    case 'symlink-to-nonfile': return 'a symlink to a non-file';
    case 'symlink-broken': return 'a symlink whose target does not resolve';
    case 'directory': return 'a directory, not a file';
    case 'other-nonfile': return 'a non-regular file (socket/fifo/device)';
    default: return 'present';
  }
};

export function validateSuiteMap(tsvText, { root = DEFAULT_ROOT, existsFn, fileExists: fileExistsOpt } = {}) {
  const usingDefault = !existsFn && !fileExistsOpt;
  const fileExists = existsFn || fileExistsOpt || ((relPath) => defaultFileIsRegular(root, relPath));
  // What the thing on disk IS, when the real-disk checker is the one that ran
  // (an injected predicate has no disk to describe).
  const what = (relPath) => (usingDefault ? ` (${describeNonFile(root, relPath)})` : '');
  // The pending carve-out distinguishes 'not created yet' from 'exists but is
  // not a file' only when the real-disk checker can say which (the sweep
  // residual: a directory at a test/-spelled suite path must be a violation,
  // not a silent pending).
  const pathKindOf = usingDefault ? (relPath) => pathKind(root, relPath) : undefined;
  const pendingDeclared = extractPendingSuites(tsvText);
  const violations = [];

  for (const line of tsvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    const pattern = parts[0] ? parts[0].trim() : '';
    if (!pattern) continue;

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
          message: `@importers row names a module that is not a regular file on disk: ${pattern}${what(pattern)}`,
        });
      }
      for (const d of directives.filter((t) => t.startsWith('except='))) {
        const target = d.slice('except='.length);
        if (!fileExists(target)) {
          violations.push({
            type: 'missing_suite',
            token: target,
            pattern,
            message: `except= names a suite that is not a regular file on disk: ${target} (referenced by ${pattern})${what(target)}`,
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
            message: `Exemption path is not a regular file on disk: ${pattern}${what(cleanPat)}`,
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
            message: `Mapped path is not a regular file on disk: ${pattern}${what(pattern)}`,
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

      if (isPendingSuite(token, pendingDeclared, fileExists, pathKindOf)) {
        continue;
      }

      if (!fileExists(token)) {
        violations.push({
          type: 'missing_suite',
          token,
          pattern,
          message: `Suite is not a regular file on disk: ${token} (referenced by ${pattern})${what(token)}`,
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
 * Checks whether a suite is currently pending (declared pending or test/ spelling,
 * and absent from disk). The carve-out covers "not created yet", NEVER "exists
 * but is not a file": when the caller can supply pathKindOf (the real-disk
 * checker can), a path present as a directory / symlink-to-directory is NOT
 * pending - it falls through to the existence violation, named for what it is.
 * Without a pathKindOf (an injected boolean predicate carries no type
 * information) the honest fallback is the old boolean-only rule.
 */
export function isPendingSuite(suite, pendingDeclared, fileExists, pathKindOf) {
  if (fileExists(suite)) return false; // a regular file: active, not pending
  if (!(suite.startsWith('test/') || pendingDeclared.has(suite))) return false;
  if (pathKindOf && pathKindOf(suite) !== 'missing') return false; // present but wrong-typed
  return true;
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
  // Same existence notion as validation (cc-derive): a regular FILE, so a map row
  // naming a directory (or symlink-to-one) is never collected as a suite file.
  const fileExists = fileExistsOpt || ((relPath) => defaultFileIsRegular(root, relPath));
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
    } catch (err) {
      // A MISSING directory is legitimate (a root may have no tests/ at all); an
      // EXISTING but unreadable one is a broken tree (airhorn-31ep): the old blanket
      // swallow dropped the whole subtree from the scan with no error - the same
      // silent-green direction the row-4 fix closed one function down.
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return;
      throw new Error(`suite scan could not read directory '${dirRel}': ${String((err && err.message) || err)} - a subtree vanished from the coverage scan; refuse rather than report coverage it never derived`);
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
    `\\bfrom\\s*${Q}`,                                    // import { x } from MODULE, export ... from
    `\\bimport\\s+${Q}`,                                  // import MODULE (side effect)
    `\\bimport\\s*\\(\\s*${Q}`,                        // await import(MODULE)
    `\\brequire\\s*\\(\\s*${Q}`,                       // require(MODULE)
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
    } catch (err) {
      // A LISTED suite that cannot be read is a broken tree, not a skippable row
      // (tools/ sweep row 4): the silent continue produced an @importers row that
      // quietly dropped the suite - a derivation that claims coverage it did not scan.
      throw new Error(`@importers scan of '${target}' could not read listed suite '${suite}': ${String((err && err.message) || err)} - a suite the map names must be readable, or the derivation reports coverage it never scanned`);
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
export function deriveCoverageContract(tsvText, { root = DEFAULT_ROOT, existsFn, fileExists: fileExistsOpt } = {}) {
  // Same existence notion as validation (cc-derive): a regular FILE. With the old
  // existsSync default a directory read as 'present', so a directory row was
  // DERIVED into a clean-looking contract while --validate-map rejected the same
  // row - and with a bare isFile swap a test/-spelled directory would instead
  // read as 'pending' and be silently dropped, so pathKindOf rides along exactly
  // as in validateSuiteMap: wrong-typed-but-present is NOT pending, it stays in
  // the derived contract as written, for validation to name.
  const usingDefault = !existsFn && !fileExistsOpt;
  const fileExists = existsFn || fileExistsOpt || ((relPath) => defaultFileIsRegular(root, relPath));
  const pathKindOf = usingDefault ? (relPath) => pathKind(root, relPath) : undefined;
  const pendingDeclared = extractPendingSuites(tsvText);

  const contract = {};
  for (const line of tsvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    const pat = parts[0] ? parts[0].trim() : '';
    if (!pat || pat.startsWith('!') || pat.startsWith('~')) continue;
    const { suites } = expandRow(pat, parts.slice(1).join(' '), { root, fileExists });
    const activeSuites = suites.filter((s) => !isPendingSuite(s, pendingDeclared, fileExists, pathKindOf));
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

  // One report, three gates: --stdout, the default write, and --check all refuse
  // an invalid map identically. (--stdout used to skip validation entirely, so a
  // map --validate-map rejects still produced a clean-looking contract - the
  // cc-derive asymmetry.)
  const reportMapViolations = () => {
    const violations = validateSuiteMap(tsvText, { root, existsFn, fileExists });
    for (const v of violations) {
      console.error(`FAIL: suite-map: [${v.type}] ${v.message}`);
    }
    return violations;
  };

  if (args.includes('--stdout')) {
    if (reportMapViolations().length > 0) return 1;
    const derived = deriveCoverageContract(tsvText, { root, existsFn, fileExists });
    const formatted = formatCoverageContract(derived);
    process.stdout.write(formatted);
    return 0;
  }

  if (args.includes('--validate-map')) {
    return reportMapViolations().length > 0 ? 1 : 0;
  }

  if (reportMapViolations().length > 0) return 1;

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
