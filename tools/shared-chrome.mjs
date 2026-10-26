/*
 * tools/shared-chrome.mjs — one browser per flag family for a whole gate run
 * (airhorn-w1wh).
 *
 * Why this exists again: airhorn-ecp built this, measured it slower, and reverted
 * it (366ee39/e80c6ac -> 965cad6: cold gate 62-70s vs shared 82-98s on this
 * 2-core box). That measurement was taken on a HEALTHY box, where a cold launch
 * costs ~2s and the one thing sharing buys - fewer launches - is worth almost
 * nothing, while the one thing it costs - parallel suites contending inside one
 * browser process (shortcuts 16->31s, sw-failover 11->24s) - is paid eleven
 * times. It is the right answer to a different question.
 *
 * The question that brought it back is the starved box: /proc/stat steal 88-96%
 * for minutes, chrome needing 22-57s to answer /json/list at ONE browser
 * (airhorn-w1wh, 11 in-run samples). There the launch, not the contention, is
 * the cost - eleven stretched launches cannot fit any gate bound - and paying ONE
 * launch for every suite is the difference between a gate that runs and a gate
 * that refuses. So this is not a general speed-up: it is the starved-host path,
 * and tools/lib/chrome.mjs refuses per-suite launches on exactly that host
 * ('host starved: steal NN%'). One process, one budget, many suites.
 *
 * Usage: node tools/shared-chrome.mjs --out <envfile> --suites <suite...>
 *
 * Env file lines (only for families actually started):
 *   AIRHORN_CHROME_WS=ws://...           default flags
 *   AIRHORN_CHROME_WS_AUTOPLAY=ws://...  + --autoplay-policy=no-user-gesture-required
 *   AIRHORN_CHROME_WS_WEBMCP=ws://...    + autoplay + --enable-features=WebMCP,WebMCPTesting
 *
 * tests/support/browser.mjs turns those into "a fresh page in the shared
 * browser"; a suite with no family var (or run outside the gate) cold-launches,
 * so a gap in the family map below costs time, never correctness.
 *
 * Lifecycle: the gate kills us when it finishes; we also exit if our parent dies
 * or after 30 minutes, and every exit path closes the browsers through the one
 * teardown in tools/lib/chrome.mjs (sweep + tree kill + profile rm).
 */
import fs from 'node:fs';
import { launchChrome } from './lib/chrome.mjs';

const FAMILY_ARGS = {
  default: { autoplay: false, webmcp: false },
  autoplay: { autoplay: true, webmcp: false },
  webmcp: { autoplay: true, webmcp: true },
};
const ENV_NAME = {
  default: 'AIRHORN_CHROME_WS',
  autoplay: 'AIRHORN_CHROME_WS_AUTOPLAY',
  webmcp: 'AIRHORN_CHROME_WS_WEBMCP',
};
// Parallel suites each hold a BACKGROUND page in a shared browser; without
// these, their timers are clamped whenever another suite's page is the active
// one (the ecp A/B measured shortcuts at 19s foreground vs 107s throttled).
const NO_THROTTLE_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];
// The whole point: a budget a starved host can actually meet, paid ONCE for
// every suite in the run. A per-suite launch cannot afford this, which is why
// tools/lib/chrome.mjs refuses instead.
const LAUNCH_BUDGET_MS = Number(process.env.AIRHORN_SHARED_LAUNCH_MS || 180000);
const DISCOVERY_BUDGET_MS = Number(process.env.AIRHORN_SHARED_DISCOVERY_MS || 60000);

// Suite path -> the families it will ask for, derived from the suite's own source.
//
// The ecp version hardcoded a suite-name regex and it had already drifted: today
// multitab and reflow-zoom launch with `autoplay: true`, so a map that gave them
// 'default' left them without a shared browser and they refused (measured: 1 of 3
// suites ran). Over-approximating from the source is the safe direction - a family
// that is started and unused costs one PARALLEL launch, while a family that is
// needed and not started costs the suite a refusal. 'autoplay'/'webmcp' are also
// added alongside 'default' because several suites pass a boolean that can be
// either way (shortcuts), and the webmcp family carries autoplay's flags.
// A suite that drives no browser starts no browser: the gate passes every selected
// suite, and launching one for a docs or unit suite would put a shared browser's
// cost on a run that has no use for it.
function familiesFor(suites) {
  const families = new Set();
  for (const suite of suites) {
    let source;
    try { source = fs.readFileSync(suite, 'utf8'); } catch { continue; }   // not a file, not a suite we can read
    if (!/launchBrowser|launchChrome/.test(source)) continue;
    // A suite that pins the steal seam never launches for real (tests/test-support.test.js
    // drives a stub binary with CHROME_STEAL_OVERRIDE=0): no browser for it, and no share.
    if (/CHROME_STEAL_OVERRIDE/.test(source)) continue;
    if (/webmcp/.test(source)) { families.add('webmcp'); families.add('default'); }
    else if (/autoplay/.test(source)) { families.add('autoplay'); families.add('default'); }
    else families.add('default');
  }
  return families;
}

const args = process.argv.slice(2);
let envFile = null;
const suites = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') envFile = args[++i];
  else if (args[i] === '--suites') suites.push(...args.slice(i + 1));
}
if (!envFile) {
  process.stderr.write('shared-chrome: --out is required\n');
  process.exit(2);
}

const families = familiesFor(suites);
if (families.size === 0) {
  fs.writeFileSync(envFile, '# no browser suites selected\n');
  process.exit(0);
}

const handles = [];
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const handle of handles) {
    try { handle.close(); } catch { /* the sweep and the rm are synchronous and already ran */ }
  }
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { cleanup(); process.exit(0); });
}
process.on('exit', cleanup);
// Backstops: a gate that dies without its trap must not leave us, or the
// browsers, for the reaper to find.
setInterval(() => {
  let parentAlive = true;
  try { process.kill(process.ppid, 0); } catch { parentAlive = false; }
  if (!parentAlive || process.ppid === 1) { cleanup(); process.exit(1); }
}, 5000).unref();
setTimeout(() => { cleanup(); process.exit(2); }, 30 * 60 * 1000).unref();

// All families launch in PARALLEL, for the same reason as ecp: the gate's suites
// block on the env file, so sequential starts would put N launches on the
// critical path before any suite can begin.
const lines = await Promise.all([...families].map(async (family) => {
  const handle = await launchChrome({
    ...FAMILY_ARGS[family],
    label: `shared-${family}`,
    extraFlags: NO_THROTTLE_FLAGS,
    discoverPage: false,
    timeoutMs: LAUNCH_BUDGET_MS,
    discoveryMs: DISCOVERY_BUDGET_MS,
    allowStarved: true,
  });
  handles.push(handle);
  return `export ${ENV_NAME[family]}=${handle.browserWsUrl}`;
})).catch((err) => {
  process.stderr.write(`shared-chrome: ${err.message}\n`);
  cleanup();
  process.exit(1);
});

fs.writeFileSync(envFile, `${lines.join('\n')}\n`);
process.stdout.write(`shared-chrome: ${[...families].join(', ')} ready\n`);
// Idle until killed; the backstops above handle abandonment.
setInterval(() => {}, 60000);
