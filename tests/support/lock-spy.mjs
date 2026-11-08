// The multitab lock spy, as ONE source used two ways: the browser gets it through
// tabInstrumentation (interpolated as installLockSpySource) and the node pin drives the
// same function against a fake window (tests/lock-spy.test.js). It must stay
// SELF-CONTAINED: the page side receives the function's source, so no closure references.

export function installLockSpy(window) {
  const locks = window.navigator && window.navigator.locks;
  const request = locks && locks.request;
  if (!request) return;
  locks.request = function (name, ...rest) {
    const cb = rest[rest.length - 1];
    if (typeof cb !== 'function') return request.call(this, name, ...rest);
    const wrapped = (...args) => {
      window.__heldLocks.push(name);
      const release = () => {
        const at = window.__heldLocks.lastIndexOf(name);
        if (at >= 0) window.__heldLocks.splice(at, 1);
      };
      let result;
      try {
        result = cb(...args);
      } catch (err) {
        release();
        throw err;
      }
      // Web Locks holds the lock until the callback's RETURNED PROMISE settles, not when
      // the callback returns: an async body that awaits and THEN writes is still inside
      // the lock. Bookkeeping that releases at return records that write as unlocked -
      // the airhorn-gk2p false accusation, which can make a genuine concurrency violation
      // look fine. Mirror the real semantics: release at settle for a thenable body.
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(release);
      }
      release();
      return result;
    };
    rest[rest.length - 1] = wrapped;
    return request.call(this, name, ...rest);
  };
}

export const installLockSpySource = `(${installLockSpy.toString()})(window);`;
