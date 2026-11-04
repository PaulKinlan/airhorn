import fs from 'node:fs';

// The page authors this notice; resilience-ui supplies the live region's actual text.
// Keep the assertion cheap so its failure can be proved without launching a browser.
export const LOST_UPGRADE_COPY = Object.freeze(['The app could not update', 'previous version']);

// Captured at load time so a caller cannot neuter the backstop later (airhorn-f96y).
const exitProcess = process.exit.bind(process);

// Every verdict the enforcer has reached in this process, in call order: the
// "it really ran" half of the guard (airhorn-6829).
const observed = [];

/** Verdicts the enforcer reached: {ran: true, ok, missing?} per call. */
export function lostUpgradeVerdicts() {
  return observed.map((verdict) => ({ ...verdict }));
}

/**
 * Assert that `text` is the lost-upgrade notice. Cooperative callers get a throw
 * with a stack they can report; callers that CATCH it - try/catch, a wrapper, a
 * `.catch(() => {})`, a shadowing local function - still cannot honour the
 * failure, because the exit is already scheduled and a caught throw cannot cancel
 * it (airhorn-f96y, airhorn-nqje).
 *
 * Why not a bare throw: an assertion whose honesty depends on the caller's
 * cooperation is a rule about the caller's text, and three text rules in a row
 * were defeated by text. A scheduled non-zero exit is the one failure a caller in
 * this process cannot swallow, which is what makes "the call ran and its verdict
 * was honoured" a measured fact rather than an inferred one.
 */
export function assertLostUpgradeNotice(text) {
  for (const copy of LOST_UPGRADE_COPY) {
    if (!text.includes(copy)) {
      const message = `the lost-upgrade notice is missing "${copy}": ${JSON.stringify(text)}`;
      observed.push({ ran: true, ok: false, missing: copy });
      // Written straight to fd 2: stderr is a pipe under the test runner, where
      // console.error's write can be lost when the process exits immediately.
      queueMicrotask(() => {
        try {
          fs.writeSync(2, `${message}\n`);
        } finally {
          exitProcess(1);
        }
      });
      throw new Error(message);
    }
  }
  observed.push({ ran: true, ok: true });
}
