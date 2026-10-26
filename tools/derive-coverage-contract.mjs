#!/usr/bin/env node
/**
 * tools/derive-coverage-contract.mjs — derive .fleet/coverage-contract.json from tools/suite-map.tsv.
 * Single source of truth for file-to-suite mapping (airhorn-y7mx).
 *
 * Usage:
 *   node tools/derive-coverage-contract.mjs             # updates .fleet/coverage-contract.json
 *   node tools/derive-coverage-contract.mjs --check     # verifies .fleet/coverage-contract.json is fresh (exit 0/1)
 *   node tools/derive-coverage-contract.mjs --stdout    # prints generated json to stdout
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
  const fileExists = existsFn || fileExistsOpt || ((relPath) => fs.existsSync(path.join(root, relPath)));

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
export function validateSuiteMap(tsvText, { root = DEFAULT_ROOT, existsFn, fileExists: fileExistsOpt } = {}) {
  const fileExists = existsFn || fileExistsOpt || ((relPath) => fs.existsSync(path.join(root, relPath)));
  const pendingDeclared = extractPendingSuites(tsvText);
  const violations = [];

  for (const line of tsvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    const pattern = parts[0] ? parts[0].trim() : '';
    if (!pattern) continue;

    const suiteTokens = parts.slice(1).join(' ').trim().split(/\s+/).filter(Boolean);

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
            message: `Exemption path does not exist on disk: ${pattern}`,
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
            message: `Mapped path does not exist on disk: ${pattern}`,
          });
        }
      }
    }

    // 3 & 4. Suite side validation
    for (const token of suiteTokens) {
      if (token.includes('*') || token.includes('?') || token.includes('[')) {
        violations.push({
          type: 'glob_suite_token',
          token,
          pattern,
          message: `Suite token contains wildcard metacharacters: ${token} (referenced by ${pattern})`,
        });
        continue;
      }

      if (isPendingSuite(token, pendingDeclared, fileExists)) {
        continue;
      }

      if (!fileExists(token)) {
        violations.push({
          type: 'missing_suite',
          token,
          pattern,
          message: `Suite does not exist on disk: ${token} (referenced by ${pattern})`,
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
 * and absent from disk).
 */
export function isPendingSuite(suite, pendingDeclared, fileExists) {
  return (suite.startsWith('test/') || pendingDeclared.has(suite)) && !fileExists(suite);
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
  const fileExists = existsFn || fileExistsOpt || ((relPath) => fs.existsSync(path.join(root, relPath)));
  const pendingDeclared = extractPendingSuites(tsvText);

  const contract = {};
  for (const line of tsvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    const pat = parts[0] ? parts[0].trim() : '';
    if (!pat || pat.startsWith('!') || pat.startsWith('~')) continue;
    const suites = parts.slice(1).join(' ').trim().split(/\s+/).filter(Boolean);
    const activeSuites = suites.filter((s) => !isPendingSuite(s, pendingDeclared, fileExists));
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
