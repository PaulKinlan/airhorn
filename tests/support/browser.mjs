/*
 * tests/support/browser.mjs — the suites' entry point to the one Chrome launch
 * path (airhorn-2po9).
 *
 * This module used to BE that path. It now lives in tools/lib/chrome.mjs,
 * because the eight tools had their own copies and the drift was paid for one
 * merge at a time. What stays here is the import path: fourteen suites and two
 * tools name `tests/support/browser.mjs`, and churning them buys nothing.
 *
 * It re-exports, it does not wrap: launchBrowser is launchChrome, with the same
 * options (autoplay, webmcp, label, timeoutMs, discoveryMs) and the same handle,
 * so a suite's behaviour and its failure messages are unchanged. The history
 * that used to be documented here — the flag family, the rejected shared-Chrome
 * mode, the airhorn-4yhb/9nea/acex/gau8 teardowns — is documented at the top of
 * tools/lib/chrome.mjs, where the code that enforces it lives.
 */
export { chromeBin, killTree, sweepProfile, launchChrome, connectPage } from '../../tools/lib/chrome.mjs';
export { launchChrome as launchBrowser } from '../../tools/lib/chrome.mjs';
