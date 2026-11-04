// The page authors this notice; resilience-ui supplies the live region's actual text.
// Keep the assertion pure so its failure can be proved without launching a browser.
export const LOST_UPGRADE_COPY = Object.freeze(['The app could not update', 'previous version']);

// Every verdict the enforcer has reached in this process, in call order. This is the
// "it really ran" half of the guard (airhorn-6829): a suite that merely mentions the
// enforcer leaves this empty, and tests/lost-upgrade-copy.test.mjs asserts both shapes.
// It is NOT proof that the verdict was honoured - a caller can still catch the throw
// before this record is read (see the residual in ADR airhorn-rv1k); that is what
// tools/guarded-call.mjs refuses structurally.
const observed = [];

/** Verdicts the enforcer reached: {ran: true, ok, missing?} per call. */
export function lostUpgradeVerdicts() {
  return observed.map((verdict) => ({ ...verdict }));
}

export function assertLostUpgradeNotice(text) {
  for (const copy of LOST_UPGRADE_COPY) {
    if (!text.includes(copy)) {
      observed.push({ ran: true, ok: false, missing: copy });
      throw new Error(`the lost-upgrade notice is missing "${copy}": ${JSON.stringify(text)}`);
    }
  }
  observed.push({ ran: true, ok: true });
}
