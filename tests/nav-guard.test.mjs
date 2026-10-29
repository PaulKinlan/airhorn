/*
 * tests/nav-guard.test.mjs — the fresh-document navigation guard's failure
 * paths, browser-free (airhorn-xl1t).
 *
 * The guard in tests/support/nav-guard.mjs exists to stop a wait from being
 * answered by the document the case is NAVIGATING AWAY FROM. On a real browser
 * that race is a question of timing, so the interesting cases - the boot check
 * failing transiently, failing permanently, or the marker write failing - can
 * only be produced by a transport that fails on demand. Hence a simulated page
 * timeline (acceptance / commit / boot as three separate moments) rather than
 * headless Chrome: ~ms instead of a gate slot.
 *
 * The last case is a MUTATION check: the shipped source is re-imported with the
 * "refusing to navigate" throw replaced by `return false` - the fail-open read
 * airhorn-xl1t reported - and the same scenario must then resolve the wait on
 * the OUTGOING document. That is what makes the other cases load-bearing: they
 * would all pass against a guard that silently does nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNavigateFresh, createReloadFresh, FRESH_BOOT } from './support/nav-guard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const guardPath = path.join(here, 'support', 'nav-guard.mjs');
const MARK_OUTGOING = 'window.__outgoingDocument = true; 1';
const PORT = 8080;

/*
 * A page timeline in virtual milliseconds.
 *
 *   now 0        outgoing document (generation 0); it may or may not have booted
 *   send('Page.navigate') resolves on ACCEPTANCE - the browser has queued the
 *                document, nothing has committed
 *   +commitMs    the new document commits (generation 1); the suite's next
 *                evaluate now runs in it, its DOM barely exists
 *   +bootMs      the deferred bundle has run: window.__airhorn is defined
 *
 * bootMs is deliberately large: the window between commit and boot is the
 * window in which a guard-less wait hands the case to a page that has nothing
 * in it yet.
 */
const createSim = ({
  outgoingBooted = true,
  commitMs = 20,
  bootMs = 300,
  pollMs = 10,
  roundTripMs = 3,
  transientFailures = 0, // first N reads of the outgoing document reject
  readFailsAlways = false, // every read of the outgoing document rejects
  markFails = false, // the marker write rejects
} = {}) => {
  let now = 0;
  let gen = 0;
  let acceptedAt = null;
  let commitAt = null;
  let bootAt = null;
  let navigations = 0;
  let markAttempts = 0;
  let markAt = null;
  let failuresLeft = transientFailures;
  let unknownSignals = 0;
  const marked = new Map([[0, false]]);
  const polls = []; // every poll of a guarded wait, in order

  const settle = () => {
    if (commitAt !== null && gen === 0 && now >= commitAt) {
      gen = 1;
      marked.set(1, false);
      bootAt = commitAt + bootMs;
    }
  };

  const booted = () => {
    settle();
    if (gen === 0) return outgoingBooted;
    return bootAt !== null && now >= bootAt;
  };

  // The case's own post-boot signal (Case 8 waits for __airhornBooted rather
  // than the app marker). It can only be true in a booted fresh document - that
  // is what makes it a post-boot signal - so it is modelled as exactly that.
  const signal = (expression) => {
    if (expression === FRESH_BOOT) return booted();
    unknownSignals += 1;
    return gen === 1 && booted();
  };

  const evaluate = async (expression) => {
    now += roundTripMs;
    settle();
    if (expression === FRESH_BOOT) {
      if (readFailsAlways) throw new Error('CDP: Runtime.evaluate transient failure');
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('CDP: Runtime.evaluate transient failure');
      }
      return booted();
    }
    if (expression === MARK_OUTGOING) {
      if (markFails) throw new Error('CDP: target closed');
      markAttempts += 1;
      markAt = now;
      marked.set(gen, true);
      return 1;
    }
    const guarded = expression.match(/^!window\.__outgoingDocument && \((.*)\)$/s);
    if (guarded) {
      const satisfied = !marked.get(gen) && signal(guarded[1]);
      polls.push({ at: now, gen, booted: booted(), marked: marked.get(gen), satisfied });
      return satisfied;
    }
    throw new Error(`this simulator does not model the expression the guard asked for: ${expression}`);
  };

  const send = async (method) => {
    if (method !== 'Page.navigate') throw new Error(`this simulator does not model CDP ${method}`);
    navigations += 1;
    acceptedAt = now;
    commitAt = acceptedAt + commitMs;
    now += roundTripMs;
    return {};
  };

  // Same shape as support/poll.mjs's policy: poll, retry evaluation errors, and
  // fail with the label at the deadline. It returns WHERE it was satisfied, which
  // is what the assertions read.
  const waitUntil = async (expression, timeoutMs, label) => {
    const deadline = now + timeoutMs;
    let lastError = null;
    for (;;) {
      try {
        if (await evaluate(expression)) return { at: now, gen };
        lastError = null;
      } catch (err) {
        lastError = err;
      }
      if (now > deadline) {
        throw new Error(`sim: timed out after ${timeoutMs}ms waiting for ${label}`
          + (lastError ? ` (last error: ${lastError.message})` : ''));
      }
      now += pollMs;
    }
  };

  return {
    evaluate,
    send,
    waitUntil,
    port: PORT,
    timeoutMs: 15000,
    now: () => now,
    gen: () => (settle(), gen),
    commitAt: () => commitAt,
    navigations: () => navigations,
    markAttempts: () => markAttempts,
    markAt: () => markAt,
    polls,
    satisfied: () => polls.filter((p) => p.satisfied),
    unknownSignals: () => unknownSignals,
  };
};

// A guard built on a simulator: the same options the suite passes, minus the
// retry delay (virtual time here, real sleeping there).
const guardFor = (sim, create = createNavigateFresh) => create({
  evaluate: sim.evaluate,
  send: sim.send,
  waitUntil: sim.waitUntil,
  port: sim.port,
  timeoutMs: sim.timeoutMs,
  retryDelayMs: 0,
});

test('the race is real: a bare boot wait resolves on the OUTGOING document', async () => {
  // The pre-guard code, verbatim in shape: navigate, then wait for the app
  // marker. This is the defect, and it is why the guard exists.
  const sim = createSim();
  await sim.send('Page.navigate', {});
  const resolved = await sim.waitUntil(FRESH_BOOT, sim.timeoutMs, 'app to boot');
  assert.equal(resolved.gen, 0,
    'the bare wait must visibly resolve in the document being LEFT - if this ever resolves in generation 1, '
    + 'this check has stopped reproducing the race and proves nothing about the guard');
  assert.ok(resolved.at < sim.commitAt(),
    `it resolves ${sim.commitAt() - resolved.at}ms BEFORE the new document commits`);
});

test('the guard resolves only in the fresh, booted document', async () => {
  const sim = createSim();
  await guardFor(sim)('case 6');
  const satisfied = sim.satisfied();
  assert.equal(satisfied.length > 0, true, 'the guard must eventually be satisfied');
  assert.equal(satisfied[0].gen, 1, 'the first satisfied poll is in the fresh document');
  assert.equal(satisfied[0].booted, true, 'and only after the deferred bundle ran');
  assert.equal(sim.satisfied().filter((p) => p.gen === 0).length, 0,
    'the outgoing document must never answer this wait');
  assert.equal(sim.satisfied().filter((p) => p.gen === 1 && !p.booted).length, 0,
    'nor may it resolve mid-parse, in the window between commit and boot');
});

test('the marker is written BEFORE the navigation is requested', async () => {
  const sim = createSim();
  await guardFor(sim)('case 6');
  assert.equal(sim.markAttempts(), 1, 'a booted outgoing document is marked exactly once');
  assert.ok(sim.markAt() < sim.commitAt(),
    'the marker lands in the outgoing document, not the fresh one - if it landed after the commit the wait '
    + 'could not be satisfied at all, which is the loud failure this ordering avoids');
  assert.equal(sim.polls[0].marked, true, 'every poll therefore runs against a marked outgoing document');
});

test('ONE transient boot-check failure still marks the document, so the wait is not handed back', async () => {
  // The exact airhorn-xl1t scenario: the first read of the outgoing document
  // rejects, the retry succeeds.
  const sim = createSim({ transientFailures: 1 });
  await guardFor(sim)('case 6');
  assert.equal(sim.markAttempts(), 1,
    'the retry must recover the boot check and still write the marker - a fail-open read would skip it');
  assert.equal(sim.satisfied()[0].gen, 1, 'and the wait still ends in the fresh document');
  assert.equal(sim.satisfied().filter((p) => p.gen === 0).length, 0,
    'the previous document never answers the wait, transient failure or not');
});

test('an outgoing document that cannot be read at all REFUSES to navigate', async () => {
  const sim = createSim({ readFailsAlways: true });
  await assert.rejects(() => guardFor(sim)('case 6'),
    /case 6: could not read the outgoing document \(CDP: Runtime\.evaluate transient failure\) - refusing to navigate, because an unreadable document is not an unbooted one/,
    'a persistent read failure must fail loudly and name the case');
  assert.equal(sim.navigations(), 0, 'and it must not navigate unguarded');
  assert.equal(sim.markAttempts(), 0, 'with no marker written, since there was nothing to prove');
});

test('a marker write that cannot be proven REFUSES to navigate', async () => {
  // Readable, but the mark does not stick: the same hazard as an unreadable
  // document - a wait with nothing to tell the two documents apart.
  const sim = createSim({ markFails: true });
  await assert.rejects(() => guardFor(sim)('case 7'),
    /case 7: could not mark the outgoing document \(CDP: target closed\) - refusing to navigate/);
  assert.equal(sim.navigations(), 0, 'and it must not navigate unguarded');
});

test('an outgoing document that never booted needs no marker, and the wait still requires the fresh boot', async () => {
  // The helper's other branch: a caller arrives from a document that never booted
  // (an about:blank start, a script-disabled page). Marking it is pointless - but
  // the wait must still end in the fresh, BOOTED document, not at the first
  // absence of the marker.
  const sim = createSim({ outgoingBooted: false });
  await guardFor(sim)('case 1');
  assert.equal(sim.markAttempts(), 0, 'an unbooted document is not marked');
  assert.equal(sim.satisfied()[0].gen, 1, 'the wait ends in the fresh document');
  assert.equal(sim.satisfied()[0].booted, true, 'and after its boot signal, not at commit');
});

test("a case's own post-boot signal does not relax the fresh-document requirement", async () => {
  // A caller may wait on its own post-boot signal (__airhornBooted) rather than the
  // app marker; the guard must still refuse to end on the outgoing document, whose
  // own signal it also carries.
  const sim = createSim();
  await guardFor(sim)('case 8', 'typeof window.__airhornBooted === "function"');
  assert.equal(sim.unknownSignals() > 0, true, 'the simulator saw the case-specific signal (it was modelled)');
  assert.equal(sim.satisfied().filter((p) => p.gen === 0).length, 0,
    'the outgoing document must not answer a wait built on the case-specific signal either');
  assert.equal(sim.satisfied()[0].gen, 1, 'and the wait ends in the fresh document');
});

test('MUTATION: the fail-open read (the pre-airhorn-xl1t guard) lets the wait resolve on the outgoing document', async () => {
  // Replace the refusal with the old silent `return false`, i.e. "unreadable"
  // read as "not booted". Everything else - retries, marker, wait - is the
  // shipped code. If this mutant no longer steals the wait, the checks above
  // have stopped testing anything.
  const source = fs.readFileSync(guardPath, 'utf8');
  const refusal = /throw new Error\(`\$\{label\}: could not \$\{what\}[\s\S]*?unbooted one'\);/;
  assert.match(source, refusal,
    'the mutation anchor must still be the line that decides this case: without it this check silently '
    + 'mutates nothing and passes for the wrong reason');
  const mutantSource = source.replace(refusal, 'return false;');
  assert.notEqual(mutantSource, source, 'the mutation must actually differ from the shipped source');
  const { createNavigateFresh: createMutant } = await import(
    `data:text/javascript;base64,${Buffer.from(mutantSource, 'utf8').toString('base64')}`
  );

  // The same permanent read failure that makes the shipped guard refuse (the
  // case above): the mutant proceeds unguarded.
  const sim = createSim({ readFailsAlways: true });
  await guardFor(sim, createMutant)('case 6');
  assert.equal(sim.navigations(), 1, 'the mutant navigates where the shipped guard refuses');
  const satisfied = sim.satisfied();
  assert.equal(satisfied.length > 0, true, 'and its wait is satisfied');
  assert.equal(satisfied[0].gen, 0,
    'ON THE OUTGOING DOCUMENT - this is airhorn-xl1t exactly: an unreadable document read as unbooted, '
    + 'the marker skipped, and the wait handed back to the page the case is leaving');
});

/*
 * The reload guard's page timeline (airhorn-ajzf): no Page.navigate at all.
 * The page reloads ITSELF (Case 6's controllerchange), so the marker is written
 * FIRST, while no reload can be in flight, and the reload arrives later on the
 * page's own schedule - or never, if the update is reverted.
 *
 *   now 0        pre-update document (generation 0), booted: the case just
 *                proved the boot before publishing the update
 *   markOutgoing() writes the marker into generation 0
 *   reloadAt     the page reloads itself (generation 1 commits, unmarked);
 *                null models the mutation the false-green risk was called out
 *                with: the update reverted, the old document stays
 *   +bootMs      the reloaded document's deferred bundle has run
 */
const createReloadSim = ({
  reloadAt = 100,
  bootMs = 300,
  pollMs = 10,
  roundTripMs = 3,
  markFails = false,
} = {}) => {
  let now = 0;
  let gen = 0;
  let bootAt = null;
  let markAttempts = 0;
  let markAt = null;
  const marked = new Map([[0, false]]);
  const polls = [];

  const settle = () => {
    if (reloadAt !== null && gen === 0 && now >= reloadAt) {
      gen = 1;
      marked.set(1, false);
      bootAt = now + bootMs;
    }
  };

  // The pre-update document is booted by precondition (the case waited for it
  // before publishing v2); the reloaded document boots bootMs after the reload.
  const booted = () => {
    settle();
    if (gen === 0) return true;
    return bootAt !== null && now >= bootAt;
  };

  const evaluate = async (expression) => {
    now += roundTripMs;
    settle();
    if (expression === MARK_OUTGOING) {
      if (markFails) throw new Error('CDP: target closed');
      markAttempts += 1;
      markAt = now;
      marked.set(gen, true);
      return 1;
    }
    const guarded = expression.match(/^!window\.__outgoingDocument && \((.*)\)$/s);
    if (guarded) {
      const satisfied = !marked.get(gen) && (guarded[1] === FRESH_BOOT ? booted() : false);
      polls.push({ at: now, gen, booted: booted(), marked: marked.get(gen), satisfied });
      return satisfied;
    }
    // A mutant whose marker conjunct was stripped asks for the bare boot signal.
    if (expression === `(${FRESH_BOOT})`) {
      const satisfied = booted();
      polls.push({ at: now, gen, booted: booted(), marked: marked.get(gen), satisfied });
      return satisfied;
    }
    throw new Error(`this simulator does not model the expression the guard asked for: ${expression}`);
  };

  const waitUntil = async (expression, timeoutMs, label) => {
    const deadline = now + timeoutMs;
    let lastError = null;
    for (;;) {
      try {
        if (await evaluate(expression)) return { at: now, gen };
        lastError = null;
      } catch (err) {
        lastError = err;
      }
      if (now > deadline) {
        throw new Error(`sim: timed out after ${timeoutMs}ms waiting for ${label}`
          + (lastError ? ` (last error: ${lastError.message})` : ''));
      }
      now += pollMs;
    }
  };

  return {
    evaluate,
    waitUntil,
    timeoutMs: 15000,
    markAttempts: () => markAttempts,
    markAt: () => markAt,
    polls,
    satisfied: () => polls.filter((p) => p.satisfied),
  };
};

const reloadGuardFor = (sim, create = createReloadFresh) => create({
  evaluate: sim.evaluate,
  waitUntil: sim.waitUntil,
  timeoutMs: sim.timeoutMs,
  retryDelayMs: 0,
});

test('reload guard: the wait resolves only in the reloaded, booted document', async () => {
  const sim = createReloadSim({ reloadAt: 100 });
  await reloadGuardFor(sim).markOutgoing('case 6');
  assert.equal(sim.markAttempts(), 1, 'the pre-update document is marked exactly once');
  assert.ok(sim.markAt() < 100,
    'the marker is written BEFORE the page can reload itself - after the trigger there would be nothing to order it against');
  const resolved = await reloadGuardFor(sim).waitFresh('case 6 post-update');
  assert.equal(resolved.gen, 1, 'the wait resolves in the reloaded document');
  const satisfied = sim.satisfied();
  assert.equal(satisfied[0].gen, 1, 'the first satisfied poll is in the reloaded document');
  assert.equal(satisfied[0].booted, true, 'and only after its deferred bundle ran');
  assert.equal(sim.polls.filter((p) => p.gen === 0 && p.satisfied).length, 0,
    'the marked pre-update document must never answer this wait');
});

test('reload guard goes RED when the update is reverted: the stale document cannot satisfy it', async () => {
  // The mutation the false-green risk was called out with (airhorn-ajzf):
  // serve the old document / revert the update, modelled as the reload never
  // arriving. The booted pre-update document is still right there answering
  // polls - a bare boot wait would pass on it - so if this wait resolves, the
  // marker is not load-bearing.
  const sim = createReloadSim({ reloadAt: null });
  await reloadGuardFor(sim).markOutgoing('case 6');
  await assert.rejects(
    () => reloadGuardFor(sim).waitFresh('case 6 post-update'),
    /timed out after 15000ms waiting for case 6 post-update: the reloaded document to commit and boot/,
    'with no reload, the wait must time out RED and name the case - never pass on the stale document');
  assert.equal(sim.satisfied().length, 0,
    'no poll was ever satisfied: every one of them ran against the booted, MARKED pre-update document');
});

test('reload guard: a marker write that cannot be proven refuses to wait', async () => {
  const sim = createReloadSim({ markFails: true });
  await assert.rejects(() => reloadGuardFor(sim).markOutgoing('case 6'),
    /case 6: could not mark the outgoing document \(CDP: target closed\) - refusing to wait for the reload/,
    'an unmarked document leaves nothing to tell the two generations apart, so this is fatal, not a skip');
});

test('MUTATION: stripping the marker conjunct lets the STALE pre-update document answer (the airhorn-ajzf false green)', async () => {
  // Remove `!window.__outgoingDocument && ` from the one expression builder the
  // shipped guards share, leaving a bare boot wait - the exact pre-ajzf Case 6
  // shape. Everything else (mark, retry, wait) is the shipped code. With the
  // update reverted (no reload), the mutant wait must visibly resolve on the
  // stale document; if it ever stops doing so, the reload-guard checks above
  // have stopped testing anything.
  const source = fs.readFileSync(guardPath, 'utf8');
  const conjunct = '!window.__outgoingDocument && (${booted})';
  assert.ok(source.includes(conjunct),
    'the mutation anchor must still be the expression builder both guards share: without it this check '
    + 'silently mutates nothing and passes for the wrong reason');
  const mutantSource = source.replace(conjunct, '(${booted})');
  assert.notEqual(mutantSource, source, 'the mutation must actually differ from the shipped source');
  const { createReloadFresh: createMutant } = await import(
    `data:text/javascript;base64,${Buffer.from(mutantSource, 'utf8').toString('base64')}`
  );

  const sim = createReloadSim({ reloadAt: null });
  await reloadGuardFor(sim, createMutant).markOutgoing('case 6');
  const resolved = await reloadGuardFor(sim, createMutant).waitFresh('case 6 post-update');
  assert.equal(resolved.gen, 0,
    'the mutant resolves ON THE STALE PRE-UPDATE DOCUMENT - the false green airhorn-ajzf reported: the case '
    + 'would pass without the post-update page being tested at all');
});
