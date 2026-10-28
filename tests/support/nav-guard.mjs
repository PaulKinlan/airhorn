/*
 * tests/support/nav-guard.mjs — navigate to the app and wait for the FRESH
 * document to boot (airhorn-1x2d, airhorn-ie0b, airhorn-xl1t).
 *
 * Page.navigate resolves when the browser ACCEPTS the navigation, not when the
 * new document commits (airhorn-ie0b, airhorn-byl0), and the suites here
 * navigate to the SAME url - so where the previous document is itself a booted
 * app page, it defines window.__airhorn too and a bare boot wait passes
 * INSTANTLY on it. The probe that follows then lands in the fresh document
 * mid-parse, where the DOM the case queries does not exist yet, and the case
 * fails with a null dereference that says nothing about the app (Case 7 lost a
 * green run this way at 47% steal).
 *
 * So: mark the outgoing document, so the marker's absence can only mean a
 * document that started after the marker was set; require the boot signal too,
 * so the wait cannot end mid-parse (window.__airhorn comes from the deferred
 * bundle, which cannot have run before the parse completes). In resilience-ui
 * exactly one navigation needs it - Case 6, which leaves the booted Case 5 page;
 * Case 8 does the same thing by hand with its own marker, and the rest of the
 * suite's navigations start from documents that cannot answer the bare wait, so
 * they are deliberately left alone (airhorn-1x2d review).
 *
 * Why this is a module rather than a closure in the suite that uses it: the
 * guard exists for its FAILURE paths, and a real CDP surface will not refuse a
 * Runtime.evaluate on demand. The only way to exercise them is to call these
 * lines with a transport that fails on purpose - which is what
 * tests/nav-guard.test.mjs does, including a mutated copy of this file that
 * shows the previous fail-open version lets the wait resolve on the OUTGOING
 * document. A copy of the closure pasted into a scratch script (the shape the
 * first evidence for airhorn-xl1t took) proves something about the copy, and
 * cannot notice this file rotting.
 *
 * The same hazard exists when the PAGE navigates itself (airhorn-ajzf): Case
 * 6's service-worker update ends with the page reloading itself on
 * controllerchange (index.html), a navigation the suite does not issue, so
 * there is no Page.navigate to mark before. createReloadFresh splits the guard
 * into its two halves so the marker can be written before the update is
 * TRIGGERED - the reload needs the new worker body published, installed,
 * activated and claiming, so nothing can race the marker onto the wrong
 * document - and the wait can run at the point the reload is expected.
 */

/** The app's own boot marker: defined only once the deferred bundle has run. */
export const FRESH_BOOT = 'typeof window.__airhorn !== "undefined"';

/** Write the outgoing-document marker into the CURRENT document. */
const MARK_OUTGOING = 'window.__outgoingDocument = true; 1';

/**
 * The one wait both guards end on: a document that never carried the marker
 * (window properties do not survive a navigation, so only a document that
 * started after the mark can satisfy it) AND that has run the boot signal.
 */
const freshWait = (booted) => `!window.__outgoingDocument && (${booted})`;

/**
 * A read of the current document that retries transient CDP failures and is
 * then FATAL. Whether the outgoing document booted - or was marked - decides
 * what the guard does next, and UNKNOWN must never be read as "not booted": a
 * transient evaluate failure there would skip the marker, and the wait would
 * then be answered by the unmarked previous document - i.e. silently restore
 * the race this helper exists to remove (airhorn-xl1t). So reads are retried
 * (a CDP blip is not a test failure) and then FATAL (a page we cannot read is
 * not a page we can prove unmarked). `action` is what the caller was about to
 * do unguarded ('navigate' / 'wait for the reload').
 */
const createOutgoingReader = ({ evaluate, attempts, retryDelayMs }) =>
  async (label, expression, what, action) => {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await evaluate(expression);
      } catch (err) {
        lastError = err;
        if (attempt + 1 < attempts && retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
      }
    }
    throw new Error(`${label}: could not ${what} (${lastError && lastError.message}) - refusing to ${action}, `
      + 'because an unreadable document is not an unbooted one');
  };

/**
 * Build the navigate helper for one suite's CDP transport.
 *
 * @param {object} transport
 * @param {(expression: string) => Promise<any>} transport.evaluate
 *   read the CURRENT document (the suite's bounded Runtime.evaluate)
 * @param {(method: string, params?: object) => Promise<any>} transport.send
 *   raw CDP command (the suite's bounded command sender)
 * @param {(expression: string, timeoutMs: number, label: string) => Promise<any>} transport.waitUntil
 *   bounded poll (support/poll.mjs policy, owned by the suite)
 * @param {number} transport.port the port the app is served from
 * @param {number} transport.timeoutMs the suite's one wait policy
 * @param {number} [transport.attempts] reads of the outgoing document before refusing
 * @param {number} [transport.retryDelayMs] gap between those reads
 * @returns {(label: string, booted?: string) => Promise<void>}
 *   navigate to the app and resolve only once a document that started after the
 *   outgoing one has run the boot signal - or throw, naming the case.
 */
export const createNavigateFresh = ({
  evaluate,
  send,
  waitUntil,
  port,
  timeoutMs,
  attempts = 3,
  retryDelayMs = 50,
}) => {
  const readOutgoing = createOutgoingReader({ evaluate, attempts, retryDelayMs });

  // booted is the case's own post-boot signal (Case 8 waits for __airhornBooted,
  // not the app marker); the read that decides whether to mark the outgoing
  // document always uses the app marker, because that is what a previous app page
  // defines - a case whose signal differs still has to be told apart from the
  // document it is leaving.
  return async (label, booted = FRESH_BOOT) => {
    if (await readOutgoing(label, FRESH_BOOT, 'read the outgoing document', 'navigate')) {
      const marked = await readOutgoing(label, MARK_OUTGOING, 'mark the outgoing document', 'navigate');
      if (!marked) throw new Error(`${label}: could not mark the outgoing document before navigating`);
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    // If the navigation commits BETWEEN the marker write and this command's
    // arrival in the new document, the marker lands on the fresh page and this
    // wait cannot be satisfied until it times out - loud, and named, rather than
    // a wait answered by the document we are leaving.
    await waitUntil(freshWait(booted), timeoutMs,
      `${label}: a fresh document to commit and boot`);
  };
};

/**
 * Build the reload guard for one suite's CDP transport (airhorn-ajzf): the
 * same outgoing-document marker as createNavigateFresh, split into its two
 * halves because the reload is issued by the PAGE, not the suite - there is no
 * Page.navigate whose acceptance could order the marker write.
 *
 * The caller MUST call markOutgoing() while no reload can be in flight (in
 * Case 6: before the v2 worker body is published, since the reload needs that
 * body installed, activated and claiming), and waitFresh() where the reloaded
 * document is expected. A bare boot wait there can be answered by the stale
 * pre-update document - and every assertion after it then reads that document,
 * green without testing the post-update page at all.
 *
 * @param {object} transport
 * @param {(expression: string) => Promise<any>} transport.evaluate
 * @param {(expression: string, timeoutMs: number, label: string) => Promise<any>} transport.waitUntil
 * @param {number} transport.timeoutMs the suite's one wait policy
 * @param {number} [transport.attempts] reads of the outgoing document before refusing
 * @param {number} [transport.retryDelayMs] gap between those reads
 */
export const createReloadFresh = ({
  evaluate,
  waitUntil,
  timeoutMs,
  attempts = 3,
  retryDelayMs = 50,
}) => {
  const readOutgoing = createOutgoingReader({ evaluate, attempts, retryDelayMs });
  return {
    // Mark the CURRENT document as the one the page-initiated reload replaces.
    // No booted check: the caller has just proved the boot, and marking an
    // unbooted document would be harmless anyway - waitFresh requires the boot
    // signal regardless.
    markOutgoing: async (label) => {
      const marked = await readOutgoing(label, MARK_OUTGOING, 'mark the outgoing document', 'wait for the reload');
      if (!marked) throw new Error(`${label}: could not mark the outgoing document before the reload`);
    },
    // Resolve only once a document that started after markOutgoing() has run
    // the boot signal; if the page never reloads (the update is reverted, the
    // controllerchange handler lost), this times out RED naming the case -
    // the stale document cannot answer it.
    waitFresh: (label, booted = FRESH_BOOT) =>
      waitUntil(freshWait(booted), timeoutMs,
        `${label}: the reloaded document to commit and boot`),
  };
};
