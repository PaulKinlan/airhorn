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
  //          visibility, opacity, boxChain,
  //          hasTextContent, renderedText }
  // The adapter supplies facts only; every decision is here.
  // Returns 'none' (skip this node AND its subtree), 'own' (descend, but this
  // node's own text nodes are not painted) or 'text' (collect and descend).
  const gate = (facts) => {
    // Documents, shadow roots and text nodes are not gated on their own; a
    // shadow root is adapted through its host, which does have the facts.
    if (facts.type !== 'element') return 'text';
    // content-visibility decides the whole subtree. checkVisibility does NOT
    // report the element's OWN skip - measured: a c-v:hidden element and an
    // off-screen c-v:auto element both report true - while innerText is '' for
    // both, so for c-v the rendered text is the evidence (read lazily: it is a
    // layout query, and only c-v elements pay for it).
    if (facts.contentVisibility === 'hidden') return 'none';
    if (facts.contentVisibility === 'auto' && facts.hasTextContent && facts.renderedText === '') return 'none';
    if (facts.display === 'contents') {
      // No box of its own, and checkVisibility is FALSE for it while its
      // children are still painted (measured in Chrome 155: display:contents
      // element, checkVisibility false, innerText non-empty, one range rect).
      // So the subtree is never pruned on this element's verdict - a child
      // carries the ancestor facts itself and may override visibility
      // (airhorn-od1's cleared case). Its OWN text nodes still need a verdict,
      // and they are painted only if BOTH the box chain above it is rendered
      // (asked without visibilityProperty, so an ancestor's visibility cannot
      // override the element's own) and its own computed visibility/opacity
      // allow it. Without this, a display:contents region reading its own text
      // claimed shown:true from display:none, visibility:hidden and opacity:0
      // (measured with the browser fixture; the 13-case matrix missed it).
      if (facts.visibility === 'hidden') return 'own';
      if (!(facts.opacity > 0.05)) return 'own';
      if (facts.boxChain === false) return 'own';
      return 'text';
    }
    if (facts.checkVisibility === false) return 'none';
    return 'text';
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
      const verdict = gate(n.facts);
      if (verdict === 'none') return;
      if (verdict === 'text' && n.ownText) parts.push(n.ownText);
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

  return { OPTIONS, gate, renderedText, isShown };
}
