/*
 * tests/gate-smoke.test.mjs — the gate's own selection contract and the
 * tools scripts' syntax, as a REAL suite (airhorn-1ye): mapping tools/* to
 * this suite means a change to tools/fast-gate.sh or tools/resilience-audit.mjs
 * is placed by coverage that actually exercises the file, not by a nominal
 * unit suite that never reads it.
 *
 * Everything here is browser-free and fast: --list runs the map, no suites.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRenderModel } from '../tools/render-model.mjs';
import { READ_STATE } from '../tools/resilience-audit.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gate = path.join(root, 'tools', 'fast-gate.sh');

// Sentinel cleanup (airhorn-ey1): a bound kill during the symlink pin can
// leave its probe link behind, which would redden the tools parse of the
// NEXT run before the pin gets a chance to clean up. Probe names carry the
// OWNING PID: the sentinel removes only probes whose owner is gone, so a
// CONCURRENT run's live probe survives (airhorn-je9) - deleting it made
// two overlapping runs read false greens.
const probeLinkName = () => `zz-symlink-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}.mjs`;
const PROBE_RE = /^zz-symlink-probe-(\d+)-[0-9a-f]+\.mjs$/;
for (const f of fs.readdirSync(path.join(root, 'tools'))) {
  const m = PROBE_RE.exec(f);
  if (!m) continue;
  const owner = Number(m[1]);
  if (owner === process.pid) continue; // our own run's probe
  let alive = true;
  try { process.kill(owner, 0); } catch (e) { alive = e.code === 'EPERM'; }
  if (!alive) fs.rmSync(path.join(root, 'tools', f), { force: true });
}

const listFor = (changed) =>
  execFileSync('bash', [gate, '--changed', changed, '--list'], { cwd: root, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);

test('a worker change selects the offline + failover suites', () => {
  const suites = listFor('public/sw.js');
  // Subset, not equality: the map may legitimately add suites (the pending
  // test/ spellings, or suites arriving on other branches) and this contract
  // must survive that.
  for (const s of ['tests/sw-offline.test.mjs', 'tests/sw-failover.test.mjs']) {
    assert.ok(suites.includes(s), `public/sw.js must select ${s}, got ${JSON.stringify(suites)}`);
  }
  assert.ok(!suites.includes('tests/horn.test.js'),
    `a worker change must not select the horn unit suite, got ${JSON.stringify(suites)}`);
});

test('a page change selects the page suites', () => {
  const suites = listFor('src/main.js');
  for (const s of ['tests/a11y.test.mjs', 'tests/webmcp-browser.test.mjs', 'tests/resilience-ui.test.mjs']) {
    assert.ok(suites.includes(s), `src/main.js must select ${s}, got ${JSON.stringify(suites)}`);
  }
});

test('an audit-tool change selects this suite (the tools/* row is real)', () => {
  const suites = listFor('tools/resilience-audit.mjs');
  assert.ok(suites.includes('tests/gate-smoke.test.js'),
    `tools/resilience-audit.mjs must select the gate smoke suite, got ${JSON.stringify(suites)}`);
});

test('the dev server still parses (esbuild transform = the syntax check it gets)', () => {
  // server.ts is TypeScript outside the Vite bundle graph; the honest smoke
  // is a parse, via the esbuild that vite already ships (airhorn-1ye).
  execFileSync(path.join(root, 'node_modules', '.bin', 'esbuild'), [path.join(root, 'server.ts')], { stdio: 'pipe' });
});

test('the gate script parses (bash -n)', () => {
  execFileSync('bash', ['-n', gate]);
});

test('every tools script parses - recognised extensions at any depth (airhorn-7lm, airhorn-7z5, airhorn-h19)', () => {
  // Glob, not names (airhorn-v1n), and every RECOGNISED script extension,
  // not just .mjs (airhorn-h19: .cjs and .ts were unparseable, extensionless
  // files invisible). A tools file with no parser is a failure, not a skip:
  // teach the checker or list the extension as data here.
  const PARSERS = {
    '.mjs': (f) => execFileSync(process.execPath, ['--check', f]),
    '.js': (f) => execFileSync(process.execPath, ['--check', f]),
    '.cjs': (f) => execFileSync(process.execPath, ['--check', f]),
    '.ts': (f) => execFileSync(path.join(root, 'node_modules', '.bin', 'esbuild'), [f]),
    '.sh': (f) => execFileSync('bash', ['-n', f]),
  };
  const DATA_EXTS = new Set(['.conf', '.tsv', '.json', '.md', '.txt']);
  const entries = fs.readdirSync(path.join(root, 'tools'), { recursive: true, withFileTypes: true });
  let parsed = 0;
  for (const ent of entries) {
    // A symlink can point at a real script: Dirents are lstat-based, so a
    // symlink reports neither file nor directory - resolve it before
    // classifying, or a mirror of a broken script reads as covered
    // (airhorn-0ct). Directories remain containers (airhorn-mo4).
    let isFile = ent.isFile();
    // resolve (not join): parentPath is spelled with the readdir base, which
    // is absolute here - join would double it and read a nonexistent path.
    const full = path.resolve(root, ent.parentPath || ent.path, ent.name);
    if (!isFile && !ent.isDirectory()) {
      let st = null;
      try { st = fs.statSync(full); } catch { st = null; }
      if (!st) assert.fail(`${path.relative(root, full)} is a dangling symlink - remove it or point it at a real file (airhorn-0ct, airhorn-pww)`);
      isFile = st.isFile();
    }
    if (!isFile) continue;
    const rel = path.relative(root, full);
    const ext = path.extname(rel);
    if (DATA_EXTS.has(ext)) continue;
    const parse = PARSERS[ext];
    if (!parse) {
      // Keep h19's guarantee while saying precisely what to do: an
      // extensionless file must become a parseable script or gain an
      // extension this suite can classify.
      const hint = ext === ''
        ? 'add a script extension (.mjs/.js/.cjs/.ts/.sh) so gate-smoke can parse it, or move it - extensionless tools files are assumed to be scripts'
        : 'add a parser for its extension to gate-smoke, or move it to the data list';
      assert.fail(`no parser for ${rel}: ${hint} (airhorn-h19, airhorn-mo4)`);
    }
    parse(path.join(root, rel));
    parsed += 1;
  }
  assert.ok(parsed >= 3, `expected the tools scripts to be present, got ${parsed}`);
});

test('every script-tier suite is gated by a tests/support change (airhorn-dco)', () => {
  // The report hook is runner-injected into EVERY script-tier (*.test.mjs)
  // suite, so a hook edit can break any of them; the support row must name all
  // of them minus the explicit-only acceptance pass (airhorn-i8i), and this
  // assertion - derived from the tree, per run - is what makes that rule
  // fail loudly instead of living in a comment (airhorn-10q, airhorn-n00,
  // airhorn-5t8 were three recurrences of the same drift).
  const supportChange = 'tests/support/report-hook.mjs';
  const selected = listFor(supportChange).sort();
  const scriptTier = fs.readdirSync(path.join(root, 'tests'))
    .filter((f) => /\.test\.mjs$/.test(f) && f !== 'acceptance.mjs')
    .map((f) => `tests/${f}`).sort();
  assert.ok(scriptTier.length >= 6, `expected the script-tier suites to be present, got ${JSON.stringify(scriptTier)}`);
  // EXACT set, not subset (airhorn-cae): over-naming matters as much as
  // under-naming - tests/acceptance.mjs in this row would put a full
  // browser acceptance pass on every support change, and subset-only
  // checking would call that correct.
  assert.deepEqual(selected, scriptTier,
    `the support row must select exactly the script-tier suites:\n  row: ${JSON.stringify(selected)}\n  expected: ${JSON.stringify(scriptTier)}`);
});
// Self-invocation guard with an unguessable key AND a per-run token
// (airhorn-j60, airhorn-5os): the child re-runs this suite; without the
// guard it would create the probe symlink again and recurse forever. The
// skip fires only when the key's VALUE matches the token THIS pin minted -
// an inherited key (any value) cannot satisfy it, so a stray can neither
// disable the pin nor make it skip silently: a top-level run without the
// exact token always RUNS the pin.
const guardKey = `GATE_SMOKE_SELF_${crypto.randomBytes(4).toString('hex')}`;
const guardToken = crypto.randomBytes(8).toString('hex');
// GATE_SMOKE_SELF carries "key:token" - BOTH minted by the pin process.
// A child re-checks env[key] === token against the INHERITED names, so the
// pairing survives process boundaries; a stray value (no colon, wrong
// name, wrong token) fails the parse or the lookup and the pin RUNS.
const guardActive = () => {
  const spec = process.env.GATE_SMOKE_SELF || '';
  const i = spec.indexOf(':');
  if (i < 0) return false;
  return process.env[spec.slice(0, i)] === spec.slice(i + 1);
};

test('the tools parse fails on a symlinked broken script and passes a valid one (airhorn-0ct)', {
  skip: guardActive() ? 'self-invocation guard' : false,
}, () => {
  // A regression pin that invokes the REAL suite: with a symlinked broken
  // script in tools/, the tools parse must fail; with a valid target, pass.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-smoke-symlink-'));
  const probeName = probeLinkName();
  const link = path.join(root, 'tools', probeName);
  const runSelf = () => {
    // Strip the runner's NODE_TEST_CONTEXT: a child node --test that inherits
    // it believes it is a managed test child, writes nothing and exits 0 -
    // the silent green that made this pin read as a false pass.
    const childEnv = { ...process.env, [guardKey]: guardToken, GATE_SMOKE_SELF: `${guardKey}:${guardToken}`, GSM_PROBE_NAME: probeName };
    delete childEnv.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(root, 'tests', 'gate-smoke.test.js')], {
      cwd: root, encoding: 'utf8',
      env: childEnv,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    // The child MUST have skipped this pin via the guard pairing
    // (airhorn-5os): a green child that RAN its own pin would be
    // recursion, and a guard that never engages is invisible.
    assert.ok(/# SKIP[-\s]*self-invocation guard/.test(out), `the pin child must report the guard skip: ${out.slice(0, 200)}`);
    const lines = out.split('\n').filter((l) => /not ok|pass |fail |SyntaxError|Error/.test(l)).slice(0, 6).join(' || ');
    return { status: r.status, tail: `err=${r.error ? r.error.code : 'none'} ${lines}` };
  };
  try {
    fs.writeFileSync(path.join(tmp, 'broken.mjs'), 'const x = {');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(tmp, 'broken.mjs'), link);
    const brokenRun = runSelf();
    assert.notEqual(brokenRun.status, 0, `a symlinked BROKEN tools script must fail the suite: ${brokenRun.tail}`);

    fs.writeFileSync(path.join(tmp, 'valid.mjs'), 'export const ok = 1;');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(tmp, 'valid.mjs'), link);
    const validRun = runSelf();
    assert.equal(validRun.status, 0, `a symlinked VALID tools script must pass the suite: ${validRun.tail}`);

    // Dangling: the resolution must fail LOUDLY, not silently skip - a
    // 'continue' here reads as coverage KNOWN over a hole (airhorn-56e).
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(tmp, 'never-created.mjs'), link);
    const danglingRun = runSelf();
    assert.notEqual(danglingRun.status, 0, `a DANGLING symlinked tools script must fail the suite: ${danglingRun.tail}`);
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The audit's render instrument as a decision TABLE (airhorn-0w9, -cpi, -9py,
// -7s3, -4jw). Every fact below is what Chrome 155 MEASURED for that
// arrangement - checkVisibility, computed display/content-visibility and
// innerText - so this table is the browser's behaviour in Node form. The
// audit injects this module's SOURCE into the page, so the model tested here
// is the model Chromium runs: no second copy, no drift.
//
// The class this replaces: 'shown' was checkVisibility(el) and 'text' came
// from a separate walk, so every disagreement WAS a finding (a c-v:auto
// skipped region read shown:true over innerText '', a display:contents region
// with visible text read shown:false). Here one walk decides both.
test('the render model: shown IS visible text; a skipped node contributes nothing (airhorn-0w9, -cpi, -9py)', () => {
  const model = makeRenderModel();
  const el = (facts = {}, ownText = '', elements = [], shadow = null) => ({
    facts: { type: 'element', checkVisibility: true, display: 'block', contentVisibility: 'visible', ...facts },
    ownText, elements, shadow,
  });
  const shadowRoot = (...elements) => ({ facts: { type: 'shadow' }, ownText: '', elements, shadow: null });
  const cases = [
    { name: 'a plain visible region', tree: el({}, 'plain visible status'), text: 'plain visible status' },
    // Chrome: a c-v:hidden element reports checkVisibility TRUE and innerText
    // '' - the skip is invisible to checkVisibility, so innerText is the
    // evidence. Its subtree is pruned whole.
    { name: 'its own content-visibility:hidden', tree: el({ contentVisibility: 'hidden', hasTextContent: true, renderedText: '' }, 'alpha', [el({}, 'kid')]), text: '' },
    { name: 'its own content-visibility:auto, skipped off-screen', tree: el({ contentVisibility: 'auto', hasTextContent: true, renderedText: '' }, 'auto skipped status'), text: '' },
    { name: 'its own content-visibility:auto, rendered', tree: el({ contentVisibility: 'auto', hasTextContent: true, renderedText: 'auto visible' }, 'auto visible'), text: 'auto visible' },
    { name: 'a skipped element inside a rendered region', tree: el({}, '', [el({ contentVisibility: 'hidden', hasTextContent: true, renderedText: '' }, 'invisible kid')]), text: '' },
    // Chrome: display:contents reports checkVisibility FALSE (no box) while its
    // text is on screen (innerText non-empty, one range rect) - so a boxless
    // element is decided by its children, not by its own checkVisibility.
    { name: 'display:contents region with its own text', tree: el({ display: 'contents', checkVisibility: false }, 'contents region text'), text: 'contents region text' },
    { name: 'display:contents region with text in a visible child', tree: el({ display: 'contents', checkVisibility: false }, '', [el({}, 'contents visible child')]), text: 'contents visible child' },
    { name: 'display:contents region whose only child is hidden', tree: el({ display: 'contents', checkVisibility: false }, '', [el({ checkVisibility: false }, 'gone')]), text: '' },
    { name: 'a region inside a display:none ancestor', tree: el({ checkVisibility: false }, 'hidden ancestor status'), text: '' },
    // The inheritable-override case (airhorn-od1): a visibility:visible region
    // inside a visibility:hidden ancestor IS shown, and checkVisibility says so.
    { name: 'a visibility:visible region inside a visibility:hidden ancestor', tree: el({}, 'visible override region'), text: 'visible override region' },
    { name: 'an opacity:0 region', tree: el({ checkVisibility: false }, 'echo opacity zero'), text: '' },
    { name: 'a region in closed <details>', tree: el({ checkVisibility: false }, 'closed details alert'), text: '' },
    { name: 'a message only in an open shadow root', tree: el({}, '', [], shadowRoot(el({}, 'shadow alert text'))), text: 'shadow alert text' },
    { name: 'a message in a nested shadow root', tree: el({}, '', [el({}, '', [], shadowRoot(el({}, 'nested shadow text')))]), text: 'nested shadow text' },
  ];
  for (const c of cases) {
    const adapt = (n) => n; // the fixture nodes already have the adapter's shape
    const text = model.renderedText(c.tree, adapt);
    assert.equal(text, c.text, `${c.name}: expected ${JSON.stringify(c.text)}, got ${JSON.stringify(text)}`);
    // One decision (airhorn-0w9): 'shown' is not a second answer that can
    // disagree with the text it reports.
    assert.equal(model.isShown(c.tree, adapt), text !== '',
      `${c.name}: shown must BE "has visible text" - a second visibility path is the bug`);
  }
});

// The instrument the audit actually runs - READ_STATE, the page code - driven
// here against a fake DOM (airhorn-0w9, -cpi, -9py). The model test above
// pins the decisions; this pins the ADAPTER, the only bridge between them and
// browser facts. A dropped `contentVisibility` or a misspelled fact here would
// restore the c-v bug in the browser with every other test green, and would
// have been invisible: nothing used to test READ_STATE at all.
test('the page instrument turns DOM facts into the model verdict (airhorn-0w9, -cpi, -9py)', () => {
  const descendants = (node) => node.children.flatMap((c) => [c, ...descendants(c)]);
  const wire = (node) => {
    node.querySelectorAll = (sel) => descendants(node).filter((d) => (sel === '*' ? true : !!d.role));
    return node;
  };
  const textOf = (node) => [node.ownText, ...node.children.map(textOf)].filter(Boolean).join(' ');
  const mk = (facts = {}, ownText = '', children = [], extra = {}) => {
    const node = {
      nodeType: 1, facts, children, shadowRoot: extra.shadow || null, role: extra.role || null,
      childNodes: ownText ? [{ nodeType: 3, textContent: ownText }] : [],
    };
    node.ownText = ownText;
    node.textContent = textOf(node);
    // Chrome 155 facts: display:none/[hidden]/closed details/opacity:0/
    // visibility resolve through checkVisibility; the element's OWN c-v skip
    // does not (measured) and shows up as empty innerText instead.
    node.checkVisibility = () => facts.checkVisibility !== false;
    Object.defineProperty(node, 'innerText', { get: () => (facts.innerText !== undefined ? facts.innerText : node.textContent) });
    node.getAttribute = (k) => (k === 'role' ? node.role : null);
    return wire(node);
  };
  const shadowOf = (host, ...children) => wire({ nodeType: 11, host, children, shadowRoot: null });
  const styleOf = (n) => ({
    display: n.facts ? n.facts.display || 'block' : 'block',
    contentVisibility: n.facts ? n.facts.contentVisibility || 'visible' : 'visible',
    visibility: 'visible',
    opacity: '1',
  });
  const instrument = (regions) => {
    const body = mk({}, '', regions);
    const document = wire({ nodeType: 9, children: [body], shadowRoot: null, querySelector: () => null, title: 'fixture', readyState: 'complete' });
    // Inject the real page code with the browser globals it reads.
    const run = new Function('document', 'getComputedStyle', 'performance', 'navigator', 'location', 'window',
      `return ${READ_STATE}`);
    return run(document, styleOf, { getEntriesByType: () => [] }, { onLine: true }, { href: 'about:blank' }, {});
  };
  const plain = mk({}, 'plain visible status', [], { role: 'status' });
  const skippedAuto = mk({ contentVisibility: 'auto', innerText: '' }, 'auto skipped status', [], { role: 'status' });
  const contents = mk({ display: 'contents', checkVisibility: false }, 'contents region text', [], { role: 'status' });
  const host = mk({}, '', [], { role: 'status' });
  host.shadowRoot = shadowOf(host, mk({}, 'shadow alert text'));
  const state = instrument([plain, skippedAuto, contents, host]);
  assert.deepEqual(state.live.map((l) => l.shown), [true, false, true, true],
    `shown must follow visible text: ${JSON.stringify(state.live)}`);
  assert.deepEqual(state.live.map((l) => l.text),
    ['plain visible status', '', 'contents region text', 'shadow alert text'],
    `text must be the rendered text only: ${JSON.stringify(state.live)}`);
  for (const l of state.live) {
    assert.equal(l.shown, l.text !== '', `shown must BE "has visible text": ${JSON.stringify(l)}`);
  }
  // The body read is the same instrument: the skipped region's text is not in
  // it (it used to be, and earned 'explains itself' for nothing).
  assert.ok(!state.bodyText.includes('auto skipped status'), `bodyText leaked skipped text: ${state.bodyText}`);
  assert.ok(state.bodyText.includes('contents region text'), `bodyText lost rendered text: ${state.bodyText}`);
});
