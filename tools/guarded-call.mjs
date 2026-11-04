/*
 * tools/guarded-call.mjs - "the guarded suite really calls the shipped enforcer"
 * as a question about the SYNTAX TREE, not about the file's text (airhorn-6829,
 * airhorn-nqje, ADR airhorn-rv1k).
 *
 * Why not a text scan: three rounds of text rules were defeated by text. A
 * `// call` comment satisfied `suite.includes('call(')`; so did the same call in
 * a block comment, and inside a string literal. A parser throws comments and
 * string bodies away for free - a commented, stringified or deleted call is
 * simply absent from the tree - and it preserves structure, which is what this
 * pin is for:
 *
 *   - the callee must resolve to the binding imported from the tested support
 *     module, so a local lookalike that returns instead of throwing is refused;
 *   - the call must be a statement that always runs: not an operand whose result
 *     is discarded, not inside a branch, loop or short-circuit.
 *
 * What this pin deliberately does NOT try to police any more is SWALLOWING - a
 * try/catch, a wrapper function, a `.catch(() => {})`. An earlier revision
 * refused those shapes and a review found the obvious next one within minutes
 * (airhorn-f96y): the class is open-ended, because "can this throw reach the
 * harness" depends on the whole calling graph. It is closed instead at the
 * enforcer: a missing copy schedules a non-zero exit that a caught throw cannot
 * cancel, so wrapping the call cannot honour the failure (see
 * tests/support/lost-upgrade-copy.mjs and the child-process proofs in
 * tests/lost-upgrade-copy.test.mjs). That is why wrapping is ALLOWED here now -
 * it is harmless - and why this file is 130 lines instead of 220.
 *
 * Reachability beyond the checks above (a function that is never invoked, dead
 * code behind a stub) is not decidable here and is a review question, named in
 * the ADR consequences.
 *
 * Cost note: this lives in tools/ on purpose. `tools/*` maps to gate-smoke and
 * gate-map, both browser-free; a module under tests/support/** would be selected
 * with the whole 20-suite browser battery (airhorn-x3f1).
 */

import { parseAst } from 'vite';

// Statements/paths that can leave the call unexecuted.
const MAY_NOT_RUN = new Set([
  'IfStatement',
  'ConditionalExpression',
  'LogicalExpression',
  'SwitchStatement',
  'SwitchCase',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

function isNode(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.type === 'string';
}

/** Depth-first walk yielding every node with its ancestor chain (outermost first). */
function walk(node, ancestors, visit) {
  visit(node, ancestors);
  const chain = [...ancestors, node];
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, chain, visit);
    } else if (isNode(value)) {
      walk(value, chain, visit);
    }
  }
}

function declaredNames(node) {
  const names = [];
  const add = (id) => {
    if (!isNode(id)) return;
    if (id.type === 'Identifier') names.push(id.name);
    else if (id.type === 'ObjectPattern') for (const p of id.properties) add(p.value ?? p.argument ?? p.key);
    else if (id.type === 'ArrayPattern') for (const el of id.elements) add(el);
    else if (id.type === 'AssignmentPattern') add(id.left);
    else if (id.type === 'RestElement') add(id.argument);
  };
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    for (const param of node.params) add(param);
    if (node.id) add(node.id);
  } else if (node.type === 'VariableDeclarator') {
    add(node.id);
  } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
    if (node.id) add(node.id);
  } else if (node.type === 'CatchClause') {
    if (node.param) add(node.param);
  } else if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') {
    add(node.local);
  }
  return names;
}

/** Why a call site may never run, or null when it is an unconditional statement. */
function unexecutedReason(ancestors) {
  const parent = ancestors[ancestors.length - 1];
  if (!parent || parent.type !== 'ExpressionStatement') {
    return `the call is an operand inside ${parent ? parent.type : 'nothing'}, not a statement of its own - its result would be discarded`;
  }
  for (const node of ancestors) {
    if (MAY_NOT_RUN.has(node.type)) {
      return `the call is inside ${node.type}, so it may never run`;
    }
  }
  return null;
}

/**
 * @param {string} source
 * @param {{callee: string, from: string}} spec  the shipped enforcer and the module it must come from
 * @param {string} [filename] for the message only
 * @returns {string|null} null when the delegation is real, else why it is not
 */
export function guardedCallProblem(source, spec, filename = 'suite') {
  const { callee, from } = spec;
  const ast = parseAst(source, { jsx: false });

  const imports = [];
  const bindings = [];
  const calls = [];
  walk(ast, [], (node, ancestors) => {
    if (node.type === 'ImportDeclaration') imports.push(node);
    for (const name of declaredNames(node)) bindings.push({ name, node });
    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier') {
      calls.push({ node, ancestors });
    }
  });

  const where = `${filename}`;

  // (1) The callee must be the import binding from the shipped module.
  let localName = null;
  for (const declaration of imports) {
    if (!declaration.source || declaration.source.value !== from) continue;
    for (const specifier of declaration.specifiers ?? []) {
      if (specifier.type === 'ImportSpecifier' && specifier.imported && specifier.imported.name === callee) {
        localName = specifier.local ? specifier.local.name : callee;
      }
    }
  }
  if (!localName) {
    return `${where} must import ${callee} from '${from}' - the shipped enforcer is the only thing whose behaviour is proven by tests/lost-upgrade-copy.test.mjs`;
  }

  // (2) Nothing may shadow that import: a local replacement can return instead of
  // enforcing, and a call-shaped pin could not tell the difference.
  const shadow = bindings.find((entry) => entry.name === localName
    && !(entry.node.type === 'ImportSpecifier' && entry.node.imported && entry.node.imported.name === callee));
  if (shadow) {
    return `${where} declares its own ${localName} (${shadow.node.type}) alongside the import - a local replacement can return instead of enforcing, so the call would not reach the tested enforcer`;
  }

  // (3) A commented-out, stringified or deleted call is not in the tree at all.
  const sites = calls.filter((site) => site.node.callee.name === localName);
  if (sites.length === 0) {
    return `${where} never calls ${localName} in code - a deleted, commented-out or stringified call is not delegation`;
  }

  // (4) Every call must actually run. Swallow shapes are not policed here: the
  // enforcer's failure survives a catch (see the header).
  for (const site of sites) {
    const reason = unexecutedReason(site.ancestors);
    if (reason) return `${where}: ${reason}`;
  }
  return null;
}

/** Throwing form for a gate: names the file and the reason. */
export function assertGuardedCall(source, spec, filename = 'suite') {
  const problem = guardedCallProblem(source, spec, filename);
  if (problem) throw new Error(problem);
}
