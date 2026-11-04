/*
 * tools/guarded-call.mjs - "the guarded suite really calls the shipped enforcer,
 * and its throw cannot be discarded" as a QUESTION ABOUT THE SYNTAX TREE, not
 * about the file's text (airhorn-6829, airhorn-nqje, ADR airhorn-rv1k).
 *
 * Why not a text scan: three rounds of text rules were defeated by text. A
 * `// call` comment satisfied `suite.includes('call(')`; so did the same call in
 * a block comment, and inside a string literal. Then a substring pin over
 * comment-stripped source moved the boundary and not the problem: `try { call }
 * catch {}` is still text that contains the call. Any rule over characters can
 * be satisfied by characters, so this module asks the parser instead.
 *
 * A parser throws comments and string bodies away for free - a commented,
 * stringified or deleted call is simply absent from the tree - and it preserves
 * STRUCTURE, which is what "honoured" actually means:
 *
 *   - the callee must resolve to the shipped enforcer (the import binding from
 *     the support module), so a local lookalike that returns instead of
 *     throwing is refused, not honoured;
 *   - the call must be a bare statement in a function body, so nothing may sit
 *     between it and the failure: no try/catch, no .catch()/.finally() handler,
 *     no if/loop/ternary, no return, no await.
 *
 * What this deliberately does NOT claim: it is structure, not execution. A
 * caller ABOVE the guarded function could still catch its failure (see the
 * residual in ADR airhorn-rv1k) - closing that needs a browser-mutant run,
 * which the gate does not buy. Inside the suite, though, every shape that can
 * swallow the throw is a shape this refuses.
 *
 * Cost note: this lives in tools/ on purpose. `tools/*` maps to gate-smoke and
 * gate-map, both browser-free; a module under tests/support/** would be selected
 * with the whole 20-suite browser battery (airhorn-x3f1).
 */

import { parseAst } from 'vite';

const STATEMENT_CONTAINERS = new Set([
  'Program',
  'BlockStatement',
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'StaticBlock',
]);

const CATCHING_HANDLER = /^(catch|finally)$/;

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

function handlerName(node) {
  // `.catch(handler)` / `.finally(handler)` wraps a throw away; `test(name, cb)` does not.
  if (node.type !== 'CallExpression') return null;
  const { callee } = node;
  if (!callee || callee.type !== 'MemberExpression') return null;
  const prop = callee.property && (callee.property.name ?? callee.property.value);
  return typeof prop === 'string' && CATCHING_HANDLER.test(prop) ? prop : null;
}

function calleeLabel(node) {
  const callee = node.callee;
  if (!callee) return 'a call';
  if (callee.type === 'Identifier') return `${callee.name}(...)`;
  const prop = callee.property && (callee.property.name ?? callee.property.value);
  return prop ? `.${prop}(...)` : 'a call';
}

/**
 * Why a call site cannot honour the enforcer's throw, if the call is wrapped in
 * something that discards it. Returns null for a bare statement call.
 */
function wrappedReason(ancestors) {
  for (const node of ancestors) {
    // try/finally cannot discard a throw - the failure still leaves the frame - so
    // it is allowed (the shipped case is inside one). try/catch CAN, and a catch
    // that happens to rethrow today is still a catch that can be edited to swallow,
    // so any catch clause makes the call site RED.
    if (node.type === 'TryStatement' && node.handler) {
      return 'the call is inside try/catch - a discarded throw does not honour the enforcer';
    }
    const handler = handlerName(node);
    if (handler) {
      return `the call is inside a .${handler}() handler - the enforcer's throw is discarded there`;
    }
  }
  const parent = ancestors[ancestors.length - 1];
  if (!parent || parent.type !== 'ExpressionStatement') {
    return `the call is nested inside ${parent ? parent.type : 'nothing'}, not a statement of its own - a nested call can be wrapped, awaited or discarded`;
  }
  const grand = ancestors[ancestors.length - 2];
  if (!grand || grand.type !== 'BlockStatement') {
    return `the call is not inside a block statement (its container is ${grand ? grand.type : 'nothing'}) - write it as a plain statement`;
  }
  for (const node of ancestors) {
    if (STATEMENT_CONTAINERS.has(node.type)) continue;
    if (node.type === 'ExpressionStatement') continue;
    // A try/finally with no catch clause cannot discard the throw (try WITH a catch
    // was refused above), and the shipped case is wrapped in one to close the browser.
    if (node.type === 'TryStatement' && !node.handler) continue;
    if (node.type === 'CallExpression') {
      // A harness wrapper (`test('name', () => { ... })`) is not a swallow: it is
      // the thing that REPORTS the throw. A method call (`list.map(cb)`,
      // `p.then(cb)`) is, because a callback handed to a method can be skipped,
      // dropped, retried or caught.
      if (node.callee && node.callee.type === 'Identifier') continue;
      return `${calleeLabel(node)} receives the guarded call as a callback - it must be a statement of a function body, not an argument`;
    }
    return `the call is inside ${node.type} - only a conditional, looped or returned call sits there, and each of those can discard the failure`;
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
  const where = `${filename}`;
  if (!localName) {
    return `${where} must import ${callee} from '${from}' - the shipped enforcer is the only thing whose throw is proven by tests/lost-upgrade-copy.test.mjs`;
  }

  // (2) No local declaration may shadow that import: a lookalike that returns
  // instead of throwing would satisfy a call-shaped pin and enforce nothing.
  const shadow = bindings.find((entry) => entry.name === localName
    && !(entry.node.type === 'ImportSpecifier' && entry.node.imported && entry.node.imported.name === callee));
  if (shadow) {
    return `${where} declares its own ${localName} (${shadow.node.type}) alongside the import - a local replacement can return instead of throwing, so the call would not honour the tested enforcer`;
  }

  // (3) A commented-out, stringified or deleted call is not in the tree at all.
  const sites = calls.filter((site) => site.node.callee.name === localName);
  if (sites.length === 0) {
    return `${where} never calls ${localName} in code - a deleted, commented-out or stringified call is not delegation`;
  }

  // (4) Every call site must be a bare statement: nothing between it and the
  // failure that could discard the throw.
  for (const site of sites) {
    const reason = wrappedReason(site.ancestors);
    if (reason) return `${where}: ${reason}`;
  }
  return null;
}

/** Throwing form for a gate: names the file and the reason. */
export function assertGuardedCall(source, spec, filename = 'suite') {
  const problem = guardedCallProblem(source, spec, filename);
  if (problem) throw new Error(problem);
}
