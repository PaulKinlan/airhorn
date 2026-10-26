/*
 * tools/lib/chrome.mjs — THE one Chrome launch path (airhorn-2po9).
 *
 * Eight tools each carried their own copy of this (resolve the binary, spawn,
 * scrape the ws:// URL off stderr, bound /json/list, find the page target, kill
 * the tree, rm the profile) and tests/support/browser.mjs carried a ninth. The
 * copies had already drifted and the drift was paid for one merge at a time:
 * the 2026-10-20 reaper burst was >=10 merges fixing one bug class (bounds per
 * tool: e885f1c/01ba7fc/0e1dbf7/489d42b; close()/sweep per suite:
 * f52e450/50c5bc0/a0b38eb/4dd2b46) and the converge commit 3615e5c+a06d482 is
 * the only one that fixed the class once. The "Raced against the handshake"
 * comment (airhorn-trj7) was pasted in three files for the same reason.
 *
 * So: resolve-bin, spawn, startup bound, profile dir, /json/list discovery,
 * the page ws handshake bound, tree kill and profile rm live HERE. A tool or a
 * suite adds only what is genuinely its own (an extra flag, a browser-level CDP
 * session, a persistent profile). Behaviour is unchanged for the suites:
 * tests/support/browser.mjs is now a re-export of this module, not a copy.
 *
 * Everything hard-won by the earlier copies is kept, because each one cost a
 * merge:
 *   - NOT detached (airhorn-acex, airhorn-105n): chrome must stay in the
 *     caller's process group. fleet-gate's bound and any job-tree reaper kill
 *     the GROUP, and a SIGKILL runs no node handler, so a detached launch
 *     outlives the kill (15 processes + the profile survived a group SIGKILL).
 *   - --disable-breakpad / --disable-crash-reporter everywhere (airhorn-hlg):
 *     a crashpad handler outlives a bound-killed browser and the reaper cannot
 *     attribute it.
 *   - --disable-dev-shm-usage everywhere (airhorn-ecp): a small /dev/shm is the
 *     ordinary case on these boxes.
 *   - the profile-marker sweep (airhorn-byun/77ih): one /proc read finds the
 *     whole tree by `--user-data-dir=`, so nothing can out-fork the cleanup.
 *   - one reap path for every way a launch can end without a handle: spawn
 *     failure (airhorn-trj7/r5me), a startup that never announces itself, a
 *     /json/list that rejects (airhorn-9nea), one that accepts and never
 *     answers (airhorn-4yhb), a page ws that never opens (airhorn-doek), and a
 *     bound-kill during any of it (airhorn-4yhb) - the caller cannot have
 *     registered its own handler yet.
 *   - the discovery bound is enforced twice, by the abort AND by a race, so a
 *     fetch that ignores its AbortSignal (a stub, an older runtime) cannot park
 *     the launch past every gate bound (airhorn-4yhb).
 *   - the bounds state the host's condition instead of asserting a machine
 *     speed (airhorn-w1wh). /proc/stat's steal column measured 88-96% on the
 *     2-vCPU fleet box for minutes at a time, in 11 consecutive 2s samples,
 *     while our own processes used 3-6% of a core; under that, chrome needed
 *     22-57s to answer /json/list at ONE browser (68-123s at two). A fixed 15s
 *     bound is a machine-speed assertion by 2-4x there, and a full gate paid
 *     1800s to report 11 failures that were all the same expired bound. So
 *     above a ceiling the launch refuses AT ONCE with 'host starved: steal
 *     NN%', and below it both bounds stretch by 1/(1-steal), capped. A healthy
 *     host (steal 0) takes neither branch and keeps today's exact bounds.
 *
 * A shared-Chrome mode (one long-lived browser per flag family, fresh page per
 * suite via Target.createTarget) was built and measured for airhorn-ecp and
 * REJECTED on this 2-core box: one browser process serialises the parallel
 * suites' work and costs more than the cold launches it saves (A/B gate runs:
 * master 62-70s vs shared 82-98s; per-suite e.g. shortcuts 16s -> 31s,
 * sw-failover 11s -> 24s in-gate, while a solo shared run took 15s - it is
 * contention, not the mechanism). Off-the-record browser contexts were also
 * unusable: serviceWorker is undefined there (probed), and most suites drive
 * the SW. The history has the full implementation if a bigger box revives it.
 *
 * The handle:
 *   {
 *     chrome,          // child process
 *     browserWsUrl,    // browser-level CDP endpoint
 *     port,            // devtools HTTP port
 *     pageTargetId,    // the fresh page's target id (null if discoverPage:false)
 *     pageWsUrl,       // ... and its WebSocket URL (connectPage() dials it)
 *     profileDir,      // the --user-data-dir this launch owns
 *     close(),         // sweep + profile rm synchronously (signal-safe); exit race after
 *     killNow(),       // synchronous tree-kill, for signal handlers
 *   }
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The one profile-marker sweep (airhorn-byun): the tools and this helper share
// a single definition in tools/lib/reap.mjs instead of five drifting copies.
import { sweepProfile } from './reap.mjs';

export { sweepProfile };

/*
 * Host steal (airhorn-w1wh) - see the header bullet.
 *
 * hostSteal() is the fraction of THIS VM's ticks the hypervisor took away,
 * measured across the process's own lifetime (a sample at module load, then the
 * delta at call time). It is deliberately a delta and not a lifetime average:
 * these VMs are days old, so the since-boot average is diluted by quiet periods
 * and reads low exactly when the box is starved now. A window too short to
 * measure (< MIN_STEAL_TICKS) returns null, which means "unknown" - the caller
 * then behaves exactly as it did before this existed, so a launch can never be
 * blocked on a reading nobody took.
 *
 * CHROME_STEAL_OVERRIDE (0..1) and CHROME_STEAL_CEILING (0..1) are the test
 * seams for both branches: a suite may not assert the machine it runs on
 * (docs/speed.md independence), so the tests here drive these, not /proc.
 */
const DEFAULT_STEAL_CEILING = 0.6;
const MAX_BOUND_STRETCH = 8;
const MIN_STEAL_TICKS = 10;
// The window ENDS NOW, every time: a lifetime average cannot see a host that has
// just been starved (10,000 healthy ticks then 2,000 starved ones average 16% -
// a healthy verdict from the wrong window).
//
// The window has to be long enough to be believable, and the two decisions do not
// cost the same: refusing early is cheap and safe, letting a launch through is the
// one that burns a gate bound. So a clear reading decides at once (500ms), anything
// in the ambiguous band is confirmed over a second reading that still ends now
// (2s total), and only a comfortably healthy host gets the short path. Measured
// cost on a healthy host: ~0.5s per launch; on a starved host the refusal lands in
// ~0.5s instead of the old 2s sample.
const DEFAULT_STEAL_WINDOW_MS = 500;
const STEAL_CONFIRM_MS = 1500;
const STEAL_SUSPICIOUS = 0.10;
const TEST_CONTEXT_ENV = 'AIRHORN_TEST_CONTEXT';

// A synchronous, bounded sleep: the preflight runs before the launch and cannot
// await, and the only thing it needs is a window wide enough to measure.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB: skip */ }
}

const CPU_STAT_FIELDS = 8;   // user nice system idle iowait irq softirq steal

/*
 * Parse /proc/stat's aggregate line. Exported because the validation IS the
 * contract: a malformed or truncated read must be UNKNOWN, never "steal 0".
 * A short line (an unusual kernel, a fixture, a truncated read) used to fill the
 * missing steal column with 0, and once the remaining fields advanced ten ticks
 * hostSteal() returned a confident 0% - a healthy verdict derived from no data,
 * which is exactly how a starved host would masquerade as idle (airhorn-w1wh
 * review). Missing file, wrong line and wrong field count all mean the same
 * thing: we do not know, so the caller behaves as it did before this existed.
 */
export function cpuStatProblem(text, source = '/proc/stat') {
  const first = String(text).split('\n')[0].trim();
  const parts = first === '' ? [] : first.split(/\s+/);
  if (parts[0] !== 'cpu') {
    return `${source}: first line is not the aggregate 'cpu' line (${JSON.stringify(parts[0] ?? '')})`;
  }
  const fields = parts.slice(1).map(Number);
  if (fields.length < CPU_STAT_FIELDS) {
    return `${source}: malformed aggregate cpu line (${fields.length} fields, need ${CPU_STAT_FIELDS} so steal is present)`;
  }
  const counters = fields.slice(0, CPU_STAT_FIELDS);
  if (!counters.every(Number.isFinite)) {
    return `${source}: malformed aggregate cpu line (non-numeric counter: ${counters.join(',')})`;
  }
  return null;
}

// Returns null - UNKNOWN - for anything it cannot read with confidence, and never
// throws (airhorn-w1wh round 6, P3): a throw here was converted to null further
// up, so the reason was lost at exactly the point a caller needs to name it.
export function parseCpuTicks(text, source = '/proc/stat') {
  if (cpuStatProblem(text, source) !== null) return null;
  // guest/guest_nice are already counted inside user/nice, so the total is the
  // first eight counters only - summing all ten would double-count them.
  const counters = String(text).split('\n')[0].trim().split(/\s+/).slice(1, 1 + CPU_STAT_FIELDS).map(Number);
  return { total: counters.reduce((a, b) => a + b, 0), steal: counters[7] };
}

function readStatNow() {
  const path = process.env.CHROME_STAT_PATH || '/proc/stat';
  const text = fs.readFileSync(path, 'utf8');
  const problem = cpuStatProblem(text, path);
  if (problem !== null) throw new Error(problem);
  return parseCpuTicks(text, path);
}

/*
 * The steal rate between two readings, or null when the pair cannot support a
 * verdict (missing data, no ticks between them, counters going backwards). Pure,
 * so the decision is testable without a machine, a clock or a browser.
 */
export function stealRate(from, to) {
  if (!from || !to) return null;
  const total = to.total - from.total;
  const steal = to.steal - from.steal;
  if (!(total >= MIN_STEAL_TICKS)) return null;   // too short a window to mean anything
  if (!(steal >= 0)) return null;                 // a counter that went backwards is not a rate
  return Math.min(1, Math.max(0, steal / total));
}

/*
 * A probe measures over a window that ENDS NOW: read, wait the window, read again,
 * and judge the delta between those two readings. It deliberately keeps no
 * baseline from module load or from a previous launch - that is what let a host
 * that had just been starved read as healthy (airhorn-w1wh round 6, P2).
 * Injectable so the window logic is testable with a scripted reader and no sleep.
 */
export function createStealProbe({
  readStat = readStatNow,
  sleep = sleepSync,
  windowMs = DEFAULT_STEAL_WINDOW_MS,
  confirmMs = STEAL_CONFIRM_MS,
  suspicious = STEAL_SUSPICIOUS,
  ceiling = DEFAULT_STEAL_CEILING,
} = {}) {
  return {
    rate() {
      const from = readStat();
      sleep(windowMs);
      const to = readStat();
      const quick = stealRate(from, to);
      if (quick === null) return null;
      // A reading at or above the ceiling already decides the launch: say so at once.
      if (quick >= ceiling) return quick;
      // A low reading is the one that lets a launch through, so it is the one worth
      // confirming - over a window that still ENDS NOW, never a cached baseline.
      if (quick >= suspicious) return quick;   // nothing to gain from a longer wait here
      sleep(confirmMs);
      const confirmed = stealRate(from, readStat());
      return confirmed === null ? quick : confirmed;
    },
  };
}

let lastUnknownReason = null;

// Why the last hostSteal() could not judge the host, for the refusal message.
export function stealUnknownReason() { return lastUnknownReason; }

/*
 * The seam resolver (airhorn-w1wh round 6, P1). CHROME_STEAL_OVERRIDE and
 * CHROME_STEAL_CEILING exist so tests can drive both branches of this decision on
 * any machine - and they were honoured in production, which meant
 * CHROME_STEAL_OVERRIDE=0 (or CHROME_STEAL_CEILING=1) silently disabled the
 * ceiling on a 96% host. They now only apply in an explicit test context, and the
 * ceiling cannot be raised above the default at all outside one.
 */
export function resolveSeams(env = process.env) {
  const testContext = env[TEST_CONTEXT_ENV] === '1';
  let override = null;
  let ceiling = DEFAULT_STEAL_CEILING;
  if (testContext) {
    const forced = Number(env.CHROME_STEAL_OVERRIDE);
    if (env.CHROME_STEAL_OVERRIDE !== undefined && env.CHROME_STEAL_OVERRIDE !== '' && Number.isFinite(forced)) {
      override = Math.min(1, Math.max(0, forced));
    }
    const rawCeiling = Number(env.CHROME_STEAL_CEILING);
    if (Number.isFinite(rawCeiling) && rawCeiling > 0 && rawCeiling <= 1) ceiling = rawCeiling;
  }
  return { testContext, override, ceiling };
}

export function hostSteal() {
  const { override } = resolveSeams();
  if (override !== null) { lastUnknownReason = null; return override; }
  const { ceiling } = resolveSeams();
  try {
    const rate = createStealProbe({ ceiling }).rate();
    lastUnknownReason = rate === null
      ? 'no usable window between two /proc/stat readings (fewer than 10 ticks advanced, or a counter went backwards)'
      : null;
    return rate;
  } catch (err) {
    lastUnknownReason = String((err && err.message) || err);
    return null;
  }
}

// A loaded box gets more time, not a wrong verdict: the bounds grow by exactly
// the factor the machine is slower by (1/(1-steal)), capped. steal <= 0 (or
// null, "unknown") returns the caller's bounds untouched.
export function stretchedBounds({ timeoutMs, discoveryMs, steal }) {
  if (steal === null || steal === undefined || !(steal > 0)) return { timeoutMs, discoveryMs };
  const stretch = Math.min(1 / (1 - steal), MAX_BOUND_STRETCH);
  return { timeoutMs: Math.round(timeoutMs * stretch), discoveryMs: Math.round(discoveryMs * stretch) };
}

export function stealCeiling(env = process.env) {
  return resolveSeams(env).ceiling;
}

export { DEFAULT_STEAL_CEILING, MAX_BOUND_STRETCH };

export function chromeBin() {
  return process.env.CHROME_BIN ||
    (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' :
    fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' :
    fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : 'google-chrome');
}

// The flag family every launch shares, for the reasons in the header. A caller
// that needs more passes `extraFlags`; none of it re-derives the family.
function familyArgs({ autoplay = false, webmcp = false } = {}) {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-breakpad',
    '--disable-crash-reporter',
  ];
  if (autoplay) args.push('--autoplay-policy=no-user-gesture-required');
  if (webmcp) args.push('--enable-features=WebMCP,WebMCPTesting');
  return args;
}

// Kill a process tree, children deepest-first: killing the parent alone leaves
// its renderers behind (the reaper found 13 processes, 47 minutes old, from one
// such run). Synchronous by design so signal handlers can use it. It walks
// ppid, so it is the fallback for a /proc-less host and the belt to the marker
// sweep's braces (a child reparented when the browser died first is invisible
// here and found there).
export function killTree(pid) {
  try {
    const table = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
    const children = new Map();
    for (const line of table.trim().split('\n')) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(child);
    }
    const order = [];
    const walk = (node) => {
      for (const child of children.get(node) || []) {
        walk(child);
        order.push(child);
      }
    };
    walk(pid);
    for (const child of [...order].reverse()) {
      try { process.kill(child, 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch { /* ps failed; fall through to killing the parent */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * launchChrome({ autoplay, webmcp, extraFlags, label, timeoutMs, discoveryMs,
 *                profileDir, keepProfile, discoverPage })
 *
 *   autoplay:     --autoplay-policy=no-user-gesture-required (a launch from a
 *                 shortcut is a user gesture; anything asserting blocked
 *                 autoplay passes false)
 *   webmcp:       --enable-features=WebMCP,WebMCPTesting (every caller that
 *                 sets it also sets autoplay)
 *   extraFlags:   appended after the family flags - the caller's own flags
 *                 (certificate ignoring, --no-first-run, ...)
 *   label:        names the profile dir and the timeout errors
 *   timeoutMs:    bound on chrome startup
 *   discoveryMs:  bound on /json/list discovery (its own bound; timeoutMs
 *                 bounds the startup phase only - airhorn-sesh)
 *   profileDir:   use this directory instead of a fresh mkdtemp. A tool whose
 *                 stale-profile sweep keys on the mkdtemp SHAPE
 *                 (sweepStaleProfiles) passes its own; everyone else lets the
 *                 launch own it.
 *   keepProfile:  leave the profile on disk at close (a "what does this device
 *                 do after a restart" scenario, tools/rollback-rehearsal.mjs)
 *   discoverPage: fetch /json/list and resolve the page target. false for a
 *                 browser-level CDP session (tools/resilience-audit.mjs), which
 *                 never needs a page.
 */
export async function launchChrome({
  autoplay = false,
  webmcp = false,
  extraFlags = [],
  label = 'chrome',
  timeoutMs = 15000,  // Bound on /json/list discovery, generous on purpose (airhorn-sesh): Chrome's
  // DevTools endpoint answers LATE on a loaded box - measured at 5 s on a 2-core
  // VM with other lanes' suites running, which read as a launch failure in a
  // browser suite that was fine (visual-overrides: '/json/list never answered on
  // port ...'). It is still capped by timeoutMs, so a suite that wants to fail
  // fast on a real launch failure passes a lower bound explicitly.
  discoveryMs = 15000,
  profileDir: givenProfileDir = null,
  keepProfile = false,
  discoverPage = true,
} = {}) {
  // Before anything is created or spawned (airhorn-w1wh): on a starved host this
  // launch cannot succeed, and waiting for the bound to expire is what turned
  // one exhausted machine into eleven "DevTools discovery timeout" failures and
  // an 1800s gate. Saying it costs nothing and names the actual cause.
  const steal = hostSteal();
  const ceiling = stealCeiling();
  if (steal === null) {
    // UNKNOWN fails CLOSED (airhorn-w1wh round 6, P3): "we could not read the host"
    // used to skip the refusal and launch anyway, which is the one case where the
    // guard silently stops guarding. Name why, so the fix is obvious from the log.
    throw new Error(
      `cannot judge host steal: ${stealUnknownReason() || 'no recent sample'} - ` +
      `refusing to launch chrome (${label}): without a current steal reading this host cannot be ` +
      'shown to be healthy, and launching here is what spends the gate bound on a machine that ' +
      'cannot run it (airhorn-w1wh)');
  }
  if (steal >= ceiling) {
    throw new Error(
      `host starved: steal ${(steal * 100).toFixed(0)}% (ceiling ${(ceiling * 100).toFixed(0)}%) - ` +
      `refusing to launch chrome (${label}): this host cannot start a browser, and failing here ` +
      'names the machine instead of spending the gate bound on it (airhorn-w1wh)');
  }
  const bounds = stretchedBounds({ timeoutMs, discoveryMs, steal });
  const profileDir = givenProfileDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `chrome-${label}-`));
  const chrome = spawn(chromeBin(), [
    ...familyArgs({ autoplay, webmcp }),
    ...extraFlags,
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  // NOT detached: chrome must stay in the caller's process group. As its own
  // group leader (detached: true) it sat outside every ancestor group-kill -
  // fleet-gate's bound and any job-tree reaper kill the GROUP, and a SIGKILL
  // runs no node handler, so the whole browser tree outlived the kill
  // (airhorn-acex: 15 processes + the profile survived a group SIGKILL that
  // the pre-77ih code cleaned). In the caller's group the same kill reaches
  // every process of this launch instantaneously, handler or no handler.
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // One reap path for every way a launch can end without a handle: startup
  // failure, discovery failure, or the launch being cut short (airhorn-9nea,
  // airhorn-4yhb).
  let closed = false;
  const reap = () => {
    if (closed) return;
    closed = true;
    // The marker sweep first (airhorn-77ih): the browser is killed in the same
    // pass that finds its children, so nothing can out-fork the cleanup, and
    // anything that raced the read is visible to the sweep's second pass.
    sweepProfile(profileDir);
    // Belt and braces for anything the marker somehow missed.
    try { killTree(chrome.pid); } catch { /* already gone */ }
    if (keepProfile) return;
    // A SIGKILL'd child lands final writebacks during the rm walk, so this
    // needs the retries, not a bare rm (airhorn-jx9, airhorn-yfh8). The
    // budget is sized to fit a signal handler's grace: the launch-window
    // guard runs BEFORE a caller's signal-exit cleanup, so every millisecond
    // spent here is taken off close()'s budget downstream (airhorn-gau8).
    try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ }
  };
  // Nothing in the caller can reap this browser yet: a caller registers its own
  // signal handler only AFTER launchChrome resolves, so a bound-kill during
  // startup or discovery left the whole chrome tree and its profile behind
  // (airhorn-4yhb). Prepended, so it reaps before a caller's own handler runs;
  // if it is the only listener, the signal is re-raised so the process still
  // dies the way it would have without the guard.
  const onSignal = function onLaunchSignal(signal) {
    reap();
    if (process.listenerCount(signal) > 1) return;
    process.removeListener(signal, onLaunchSignal);
    process.kill(process.pid, signal);
  };
  const onExit = () => reap();
  const signals = ['SIGTERM', 'SIGINT'];
  for (const signal of signals) process.prependListener(signal, onSignal);
  process.on('exit', onExit);
  const release = () => {
    for (const signal of signals) process.removeListener(signal, onSignal);
    process.removeListener('exit', onExit);
  };

  let browserWsUrl = null;
  let pageTarget = null;
  let port = null;
  const stderrLines = [];
  // Discovery is NOT capped by the startup bound any more (airhorn-sesh): they
  // measure different phases (spawn -> ws URL, then ws URL -> /json/list), and a
  // flat cap made the second phase inherit a budget sized for the first. A suite
  // that wants a fast total failure passes both bounds explicitly.
  const discoveryBound = Math.max(1, bounds.discoveryMs);
  try {
    await new Promise((resolve, reject) => {
      // A spawn that never produced a process reports through the 'error'
      // event, not a rejection - and a missing CHROME_BIN is the ordinary case,
      // since the default path does not exist on a machine without Chrome. With
      // no listener that is an uncaughtException: it aborts the caller BEFORE
      // reap() can run and leaves the launch profile behind (airhorn-trj7,
      // airhorn-r5me). Raced against the handshake so it takes the same
      // teardown as the ws-silent and exits-early shapes.
      const timeout = setTimeout(
        () => reject(new Error(`Chrome start timeout (${label}) after ${bounds.timeoutMs}ms (steal ${(steal === null ? 'unknown' : `${(steal * 100).toFixed(0)}%`)}): ${stderrLines.join('\n')}`)),
        bounds.timeoutMs);
      const onData = (data) => {
        const text = data.toString();
        stderrLines.push(text);
        const match = text.match(/ws:\/\/[^\s]+/);
        if (match && !browserWsUrl) {
          browserWsUrl = match[0];
          clearTimeout(timeout);
          resolve();
        }
      };
      // Chrome announces the endpoint on stderr; a wrapper script may use
      // stdout, so both are watched (the tools' copies always did).
      chrome.stderr.on('data', onData);
      chrome.stdout.on('data', onData);
      chrome.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`chrome launch failed: ${err.message}`));
      });
      chrome.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Chrome exited early (${code}) (${label}): ${stderrLines.join('\n')}`));
      });
    });

    port = new URL(browserWsUrl).port;
    if (discoverPage) {
      // DevTools discovery is a failure path too: if the /json/list fetch rejects
      // or no page target exists, launchChrome must not return with the Chrome
      // process and its profile still alive (airhorn-9nea). A peer that accepts
      // the connection and never answers is the third case: with no bound it
      // parked the launch until undici's 300s headers timeout - longer than any
      // suite or gate bound - so the practical outcome was a bound-kill with an
      // unreaped browser (airhorn-4yhb).
      //
      // The wait is now a CONDITION retried until a bound, not one fetch inside a
      // fixed window (airhorn-sesh). Chrome accepts the DevTools connection and
      // then answers late on a starved box - measured as 'DevTools discovery
      // timeout (5000ms)' at load 12.75 BEFORE any suite assertion ran - so a
      // single 5 s (or 15 s) attempt was a machine-speed assertion. Each attempt
      // gets a short timeout and is retried; the bound is the ceiling for the
      // whole wait. A timeout, a refusal and a hung socket are all "not ready
      // yet"; an ANSWER with no page target is not - that is the 9nea failure and
      // is reported at once, without retrying.
      const ATTEMPT_MS = 2500;
      const POLL_MS = 100;
      const discoveryDeadline = Date.now() + discoveryBound;
      let discoveryTimer = null;
      const discoveryTimeout = new Promise((_, reject) => {
        discoveryTimer = setTimeout(() => reject(new Error(
          `DevTools discovery timeout (${discoveryBound}ms) (${label}): /json/list never answered on port ${port}`)),
        discoveryBound);
      });
      let targets;
      try {
        targets = await Promise.race([
          discoveryTimeout,
          // The race above holds even if an attempt ignores its AbortSignal (a stub
          // in a test, an older runtime) - the bound is enforced twice, as before.
          (async () => {
            let lastErr = null;
            let attempts = 0;
            while (discoveryDeadline - Date.now() > 0) {
              attempts += 1;
              const attemptMs = Math.max(1, Math.min(ATTEMPT_MS, discoveryDeadline - Date.now()));
              try {
                const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(attemptMs) });
                const list = await res.json();
                if (!Array.isArray(list)) throw new Error(`/json/list answered with ${JSON.stringify(list)}`);
                const types = list.map((t) => t.type);
                if (types.includes('page')) return list;
                return { noPageTarget: types };
              } catch (err) {
                lastErr = err;
              }
              if (discoveryDeadline - Date.now() > 0) await new Promise((r) => setTimeout(r, POLL_MS));
            }
            return { exhausted: true, attempts, lastErr };
          })(),
        ]);
      } finally {
        clearTimeout(discoveryTimer);
      }
      if (targets && targets.noPageTarget) {
        throw new Error(`no page target in /json/list (${label}): ${JSON.stringify(targets.noPageTarget)}`);
      }
      if (targets && targets.exhausted) {
        const why = targets.lastErr ? ` (last of ${targets.attempts} attempts: ${targets.lastErr.message})` : '';
        throw new Error(`DevTools discovery timeout (${discoveryBound}ms) (${label}): /json/list never answered on port ${port}${why}`);
      }
      pageTarget = targets.find((t) => t.type === 'page');
      if (!pageTarget) throw new Error(`no page target in /json/list (${label}): ${JSON.stringify(targets.map((t) => t.type))}`);
    }
  } catch (err) {
    reap();
    throw err;
  } finally {
    // Past this point the caller owns the lifecycle (it registers its own
    // handler as soon as it has the handle).
    release();
  }

  const exited = new Promise((r) => chrome.on('exit', r));
  return {
    chrome,
    browserWsUrl,
    port,
    pageTargetId: pageTarget ? pageTarget.id : null,
    pageWsUrl: pageTarget ? pageTarget.webSocketDebuggerUrl : null,
    profileDir,
    async close() {
      if (closed) return 0;
      closed = true;
      try { chrome.kill('SIGTERM'); } catch { /* already gone */ }
      // Everything that matters below is SYNCHRONOUS, and it must be: once
      // this method awaits, the process can be exited under it - a signal
      // handler's grace timer, or a sibling cleanup throwing while this one
      // is in flight (airhorn-gau8's repro: a launch still pending makes
      // inflight?.close() a TypeError, and signal-exit answers the rejection
      // by exiting 143 while close() is still awaiting). close() used to
      // wait 1500ms for a graceful exit before touching the profile; inside
      // a bound-kill that wait alone ate the whole grace and the profile
      // survived. A healthy chrome TERM-exits in ~120ms (measured); the rm
      // retries absorb its writeback, which is what they are for
      // (airhorn-jx9, airhorn-yfh8) - and the rm budget is sized so the
      // signal path fits signal-exit's 2s grace with room to spare.
      sweepProfile(profileDir);
      // Belt and braces for anything the marker somehow missed, as in reap()
      // above - and the ONLY kill on a /proc-less system, where the sweep
      // returns without acting (airhorn-v54f).
      try { killTree(chrome.pid); } catch { /* already gone */ }
      if (!keepProfile) {
        try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ }
      }
      // Tidiness only - the profile is already gone; nothing above is guarded
      // by this await.
      await Promise.race([exited.then(() => true), sleep(400).then(() => false)]);
      return 0;
    },
    killNow() {
      reap();
    },
  };
}

/*
 * connectPage(wsUrlOrHandle, { label, timeoutMs }) — dial the page socket.
 *
 * The ws open is part of the launch window and gets the same treatment as the
 * handshake above: a peer that answers /json/list but never completes the
 * upgrade must reject, labelled, instead of parking the caller with a live
 * browser (airhorn-doek, airhorn-nbfp, airhorn-e4im - the same bound fixed in
 * four copies before this module owned it).
 */
export async function connectPage(target, { label = 'chrome', timeoutMs = 15000 } = {}) {
  const wsUrl = typeof target === 'string' ? target : target?.pageWsUrl;
  if (!wsUrl) throw new Error(`connectPage: no page socket to dial (${label})`);
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    // Settle exactly once. Closing the socket is part of settling (a half-open
    // ws keeps the event loop alive and the caller never exits), and that close
    // fires onerror SYNCHRONOUSLY - so an unguarded onerror would replace the
    // labelled bound message with the generic one, and the caller would see the
    // wrong reason for the same failure.
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(bound);
      if (!err) { resolve(); return; }
      try { ws.close(); } catch { /* never opened, or already closed */ }
      reject(err);
    };
    const bound = setTimeout(() => settle(new Error(
      `DevTools ws handshake timeout (${label}): the page socket never opened within ${timeoutMs}ms`)), timeoutMs);
    ws.onopen = () => settle(null);
    ws.onerror = (err) => settle(err instanceof Error && err.message
      ? new Error(`DevTools ws handshake failed (${label}): ${err.message}`)
      : new Error(`DevTools ws handshake failed (${label}): the page socket errored`));
  });
  return ws;
}
