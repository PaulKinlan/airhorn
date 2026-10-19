/*
 * tools/render-model.mjs — ONE decision for "does the platform render this
 * node, and what text does it contribute".
 *
 * Why this file exists (airhorn-0w9, -cpi, -9py, -7s3, -4jw, -od1): the audit
 * used to answer TWO questions on two code paths - `shown` from
 * checkVisibility(el), `text` from a separate DOM walk. Every finding in that
 * lineage is the same finding: the two answers disagree. A content-visibility
 * skipped region still collected its children's text (shown:true over text
 * nobody can see), a display:contents region with visible text read
 * shown:false, an element's own content-visibility skip was invisible to
 * checkVisibility, and a region under a hidden ancestor was re-decided by a
 * per-ancestor walk that then over-suppressed a visibility override.
 *
 * Here the walk is the ONLY path. A node the platform does not render is
 * pruned whole - its subtree contributes nothing - and a live region is
 * `shown` exactly when that walk returns text. One decision, so the verdict
 * and its evidence cannot disagree.
 *
 * makeRenderModel() is deliberately self-contained: tools/resilience-audit.mjs
 * injects its SOURCE into the page (Function.prototype.toString), so the
 * instrument Chromium runs is the same code tests/gate-smoke.test.js pins in
 * Node against the facts measured in Chrome 155. Keep every helper inside it.
 */

export function makeRenderModel() {
  // One option set for every checkVisibility call. contentVisibilityAuto
  // covers a skipped ANCESTOR; visibilityProperty keeps the inheritable
  // override semantics (a visibility:visible region inside a
  // visibility:hidden ancestor IS shown - airhorn-od1).
  const OPTIONS = { visibilityProperty: true, contentVisibilityAuto: true, opacityProperty: true };

  // facts: { type, checkVisibility, display, contentVisibility,
  //          hasTextContent, renderedText }
  // The adapter supplies facts only; every decision is here.
  const isRendered = (facts) => {
    // Documents, shadow roots and text nodes are not gated on their own;
    // a shadow root is adapted through its host, which does have the facts.
    if (facts.type !== 'element') return true;
    // checkVisibility answers display:none, [hidden], closed <details>,
    // opacity:0 and visibility (including ancestors). It is FALSE for
    // display:contents, whose children are still painted - measured in
    // Chrome 155: display:contents element, checkVisibility false,
    // innerText non-empty, range rect count 1. A boxless element is
    // therefore decided by its children, and they carry the ancestor
    // facts themselves.
    if (facts.display !== 'contents' && facts.checkVisibility === false) return false;
    // checkVisibility does NOT report the element's OWN content-visibility
    // skip - measured: a c-v:hidden element and an off-screen c-v:auto
    // element both report true - while innerText is '' for both. So for c-v
    // the rendered text is the evidence, and it is only asked for here (the
    // reading is a layout query; ordinary elements never pay for it).
    if (facts.contentVisibility === 'hidden') return false;
    if (facts.contentVisibility === 'auto' && facts.hasTextContent && facts.renderedText === '') return false;
    return true;
  };

  // The composed text of `root`: light children plus open shadow roots, any
  // depth, each node's own direct text counted once.
  // adapt(node) -> { facts, ownText, elements (direct element children),
  //                  shadow (open shadow root or null) }
  const renderedText = (root, adapt) => {
    const parts = [];
    const visit = (node) => {
      const n = adapt(node);
      // Pruning the WHOLE subtree is the fix: the old walk skipped a
      // non-rendered element's own text but kept collecting its children's,
      // so a skipped region reported text from content nobody could see
      // (airhorn-0w9, -cpi, -7s3).
      if (!isRendered(n.facts)) return;
      if (n.ownText) parts.push(n.ownText);
      if (n.shadow) visit(n.shadow);
      for (const child of n.elements) visit(child);
    };
    visit(root);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };

  // Shown is not a second decision (airhorn-0w9): a region is shown exactly
  // when its composed rendered text is non-empty. A region with nothing to
  // say explains nothing (airhorn-01e).
  const isShown = (root, adapt) => renderedText(root, adapt) !== '';

  return { OPTIONS, isRendered, renderedText, isShown };
}
