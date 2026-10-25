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

export function main(args = process.argv.slice(2)) {
  const root = DEFAULT_ROOT;
  const tsvPath = path.join(root, 'tools', 'suite-map.tsv');
  const contractPath = path.join(root, '.fleet', 'coverage-contract.json');

  const tsvText = fs.readFileSync(tsvPath, 'utf8');
  const derived = deriveCoverageContract(tsvText, { root });
  const formatted = formatCoverageContract(derived);

  if (args.includes('--stdout')) {
    process.stdout.write(formatted);
    return 0;
  }

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
