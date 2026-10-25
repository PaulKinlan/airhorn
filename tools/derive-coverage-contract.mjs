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

/**
 * Derives the coverage contract object from the TSV content.
 * - Filters out comments (#) and empty lines
 * - Excludes exemption rows (!), pending suite rows (~), and self-rows
 * - Filters out pending suite spellings (test/)
 * - Deduplicates suites while preserving order
 * - Accumulates multiple rows for the same pattern additively
 */
export function deriveCoverageContract(tsvText) {
  const contract = {};
  for (const line of tsvText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [pattern, suitesStr = ''] = trimmed.split('\t');
    const pat = pattern ? pattern.trim() : '';
    if (!pat || pat.startsWith('!') || pat.startsWith('~')) continue;
    const suites = suitesStr.trim().split(/\s+/).filter(Boolean);
    const nonPending = suites.filter((s) => !s.startsWith('test/'));
    if (nonPending.length > 0 && nonPending.every((s) => s === pat)) continue;
    if (nonPending.length > 0) {
      if (!contract[pat]) {
        contract[pat] = [];
      }
      for (const s of nonPending) {
        if (!contract[pat].includes(s)) {
          contract[pat].push(s);
        }
      }
    }
  }
  return contract;
}

export function formatCoverageContract(contract) {
  return JSON.stringify(contract, null, 1) + '\n';
}

export function main(args = process.argv.slice(2)) {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tsvPath = path.join(root, 'tools', 'suite-map.tsv');
  const contractPath = path.join(root, '.fleet', 'coverage-contract.json');

  const tsvText = fs.readFileSync(tsvPath, 'utf8');
  const derived = deriveCoverageContract(tsvText);
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
