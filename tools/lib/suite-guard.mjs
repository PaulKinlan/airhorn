/*
 * tools/lib/suite-guard.mjs — the in-process sentinel for the suite's OWN process.
 *
 * Loaded ONLY where the suite executes: the supervisor spawns the child runner with
 * `--import <this file>`, and node --test propagates execArgv into the per-file process it
 * spawns (measured: the guard's argv is the suite's path, and nowhere else in the chain loads
 * it). This is the layer the pre-supervisor driver used to own, re-created at arm's length
 * (airhorn-5wns, the re-target of airhorn-5qdd onto the airhorn-14ht supervisor design).
 *
 * TRUST: this process is the suite's, so NOTHING it writes is a fact — every byte it emits
 * reaches the parent as quoted data, and any fd it can reach, the suite can reach too. What
 * this file can do that the suite cannot undo after the fact is DIE NON-CLEAN: the sentinel
 * refuses by SIGKILLing its own process, and the supervisor classifies a suite process that
 * did not finish cleanly as a refusal (rc 3), never a verdict. A forger gains nothing: the
 * manipulation it wants to hide IS the death.
 *
 * What is watched (both rejection and uncaught channels, the airhorn-5qdd pair):
 *   - REGISTRATION SAMPLING: the sentinel rejection listener is installed by this preload,
 *     before node:test and the suite exist, so nothing can be ahead of it honestly. Every
 *     foreign unhandledRejection registration is sampled one captured nextTick later —
 *     nextTick drains before promise microtasks, so a rejection registered in the same
 *     synchronous block as its swallow cannot be delivered before the sample. If the
 *     sentinel is not first at the sample, something ran ahead of it at least once: refuse.
 *     (The uncaught channel needs no sampling: node emits 'uncaughtExceptionMonitor' before
 *     every listener and before a capture callback, so a prepend/prependOnce/self-removing
 *     swallow sits downstream of it.)
 *   - STRIP: removing the sentinel, the monitor handler, or this watcher itself (airhorn-gb9y:
 *     an instrument that can be deleted silently is weaker than the instruments it extends)
 *     refuses immediately — a rejection channel that has been cleared cannot be trusted again.
 *
 * Honest churn is not manipulation: node:test's own harness listener registers by APPEND
 * (measured: lazily, via the suite's first test() call, and it never displaces a listener
 * installed at preload), and a suite listener appended behind the sentinel never runs ahead
 * of it — the sentinel records nothing and the parent sees an ordinary run. Only precedence
 * (being AHEAD) or a strip refuses.
 *
 * KNOWN-LIMIT, stated rather than implied: this code runs at the same uid as the suite and
 * loads before it, so it can be patched only by code that runs before the suite AND survives
 * the captured-reference discipline below — which nothing in the run does. A suite that
 * SIGKILLs itself scores the same refusal it would earn by manipulation (outside view: a
 * non-clean death), so faking the sentinel's refusal buys nothing.
 */
const kill = process.kill.bind(process);
const nextTick = process.nextTick.bind(process);
const listenerList = process.listeners.bind(process);

const sentinel = () => {
  // The honest path: a rejection that reaches this listener happened outside any test, and the
  // parent's outside view already refuses a non-clean run. The sentinel does not need to write
  // anything — being FIRST is the invariant everything else in this file protects.
};

const onMonitor = () => refuse();
const onNewListener = (name, fn) => {
  if (name === 'unhandledRejection' && fn !== sentinel) {
    nextTick(() => {
      if (listenerList('unhandledRejection').indexOf(sentinel) !== 0) refuse();
    });
  }
};
const onRemoveListener = (name, fn) => {
  if ((name === 'unhandledRejection' && fn === sentinel)
    || (name === 'uncaughtExceptionMonitor' && fn === onMonitor)
    || (name === 'newListener' && fn === onNewListener)
    || (name === 'removeListener' && fn === onRemoveListener)) {
    refuse();
  }
};

let refused = false;
function refuse() {
  if (refused) return;
  refused = true;
  // No JS runs after SIGKILL, so no exit listener, swallow or rescue callback can turn this
  // into the clean exit the laundering shapes need. The parent sees a suite process that did
  // not finish cleanly and refuses by name — the one fact this process can state.
  kill(process.pid, 'SIGKILL');
}

process.on('unhandledRejection', sentinel);
process.on('uncaughtExceptionMonitor', onMonitor);
process.on('newListener', onNewListener);
process.on('removeListener', onRemoveListener);
