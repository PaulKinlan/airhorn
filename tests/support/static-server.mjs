/*
 * tests/support/static-server.mjs — the suites' entry point to the one static
 * server (airhorn-yxxq). Like tests/support/browser.mjs for the Chrome path,
 * this re-exports; it does not wrap. serveDist is serveDist, with the same
 * options and the same refusal behaviour.
 */
export { serveDist, parsePagesHeaders } from '../../tools/lib/static-server.mjs';
