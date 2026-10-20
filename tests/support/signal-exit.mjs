/*
 * tests/support/signal-exit.mjs — one bound-kill handler for every suite and tool
 * that owns a headless browser (airhorn-4vfn).
 *
 * A bound-kill (fleet-gate sends SIGTERM, then SIGKILL after its grace bound)
 * bypasses the try/finally that normally closes the browser, so a suite or tool
 * that only cleans up there leaks the whole chrome tree and its /tmp profile
 * (airhorn-1l0a, airhorn-w0ys). Four copies of the same handler - with the same
 * once-only guard, the same code arithmetic and the same "await cleanup, but do
 * not outlive the grace bound" race - is four places for that fix to rot.
 *
 * Usage: register the browser somewhere the cleanup can see, then install:
 *
 *   let liveBrowser = null;
 *   installSignalExit(async () => { const b = liveBrowser; liveBrowser = null; await b?.close(); });
 *   ...
 *   liveBrowser = await launchBrowser(...);   // cleared again in run()'s finally
 *
 * The cleanup runs at most once, however many signals arrive; its promise is
 * raced against `graceMs` so a wedged close cannot survive the grace bound; and
 * the process then exits with the signal's own code (128 + n), which is what a
 * bound-kill's exit status should read as.
 */

const SIGNALS = [['SIGTERM', 15], ['SIGINT', 2]];

export function installSignalExit(cleanup, { graceMs = 2000 } = {}) {
  let handled = false;
  // A cleanup failure must never stop the exit: the process is being killed and
  // the browser tree matters more than the error.
  const run = () => Promise.resolve().then(cleanup).catch(() => {});
  const installed = [];
  for (const [signal, code] of SIGNALS) {
    const handler = () => {
      if (handled) return;
      handled = true;
      Promise.race([run(), new Promise((resolve) => setTimeout(resolve, graceMs))])
        .then(() => process.exit(128 + code));
    };
    process.on(signal, handler);
    installed.push([signal, handler]);
  }
  // Returned so a long-lived caller can hand the process back to its default
  // behaviour; suite processes simply never call it.
  return () => {
    for (const [signal, handler] of installed) process.removeListener(signal, handler);
  };
}
