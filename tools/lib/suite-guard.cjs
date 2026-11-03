/*
 * tools/lib/suite-guard.cjs — loaded with --require into the SUITE's process by
 * tools/mutation-check.mjs (airhorn-ba6d).
 *
 * The mutation checker needs to tell "the suite ran and caught the mutant" from "the suite never
 * ran". Exit codes cannot tell them apart: node exits non-zero when a test fails AND when the
 * file throws while being loaded, so a suite whose import crashes was scored as a caught mutant.
 * Matching error strings did not work either - four markers covered missing modules and parse
 * errors, and an import that throws "boom" slipped straight through.
 *
 * So the failure MODE is recorded instead: anything thrown outside a test (an uncaught exception
 * or an unhandled rejection) exits with a reserved code that says "nothing was measured". A real
 * assertion failure inside a test is reported by node:test itself and keeps its own exit code, so
 * the two stay distinguishable without reading prose.
 */
const NOT_MEASURED = 97;

const die = (kind, error) => {
  const detail = error && error.stack ? error.stack : String(error);
  process.stderr.write(
    `mutation-check: the suite threw outside any test (${kind}) - nothing was measured, so this is not a caught mutant:\n${detail}\n`,
  );
  process.exit(NOT_MEASURED);
};

process.once('uncaughtException', (error) => die('uncaught exception', error));
process.once('unhandledRejection', (error) => die('unhandled rejection', error));

module.exports = { NOT_MEASURED };
