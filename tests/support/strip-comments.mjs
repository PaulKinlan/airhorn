/*
 * tests/support/strip-comments.mjs - what is left of a source file once the
 * things that cannot run are removed (airhorn-6829, ADR airhorn-rv1k).
 *
 * Why this exists: a gate that pins a call site by searching a suite's text was
 * green on `// assertLostUpgradeNotice(lost.text);`, on the same call inside
 * /* ... *\/ and inside a string literal (airhorn-nqje). Any text rule is
 * satisfiable by text, so the pin has to search something that is only
 * EXECUTABLE: comments and literal bodies removed, every byte offset and line
 * unchanged so the result can still be reported against the real file.
 *
 * Two exports, and the difference matters:
 *   - stripComments(source) - comment bodies blanked. Strings are left alone.
 *   - liveCode(source)      - comment AND string/template/regex bodies blanked.
 *                             A substring of liveCode can only come from code.
 * Both replace removed bytes with spaces (newlines kept) rather than deleting
 * them, so `liveCode(s).indexOf(x)` is a real offset in `s` and error messages
 * can quote the line the hit was on.
 *
 * Deliberately NOT a parser: no regex-engine rules beyond the usual "a slash
 * after an expression is division, after an operator is a regex" heuristic, and
 * a template literal's `${...}` substitutions are treated as part of the
 * literal. Both limitations only ever HIDE code, never invent a hit, so the
 * failure direction is a red pin that names a real file - never a green one.
 */

const REGEX_PREFIX_CHARS = new Set('(,=:[!&|?{};+-*%~^<>');
const REGEX_PREFIX_WORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'do', 'else', 'case', 'yield', 'await', 'throw',
]);

/**
 * @param {string} source
 * @param {{literals?: boolean}} [options]
 * @returns {string}
 */
export function removeNonCode(source, options = {}) {
  const blankLiterals = options.literals === true;
  const out = source.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  const prevSignificant = (from) => {
    for (let k = from - 1; k >= 0; k -= 1) {
      if (!isSpace(source[k])) return k;
    }
    return -1;
  };
  const startsRegex = (slashIndex) => {
    const prev = prevSignificant(slashIndex);
    if (prev < 0) return true;
    const ch = source[prev];
    if (REGEX_PREFIX_CHARS.has(ch)) return true;
    if (/[A-Za-z_$]/.test(ch)) {
      let start = prev;
      while (start > 0 && /[A-Za-z0-9_$]/.test(source[start - 1])) start -= 1;
      return REGEX_PREFIX_WORDS.has(source.slice(start, prev + 1));
    }
    return false;
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      let end = source.indexOf('\n', i);
      if (end < 0) end = source.length;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      let end = source.indexOf('*/', i + 2);
      end = end < 0 ? source.length : end + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === ch) break;
        if (ch !== '`' && (source[j] === '\n' || source[j] === '\r')) break;
        j += 1;
      }
      const close = j < source.length && source[j] === ch ? j : Math.min(j, source.length);
      if (blankLiterals) blank(i + 1, close);
      i = close + 1;
      continue;
    }
    if (ch === '/' && startsRegex(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break;
        j += 1;
      }
      if (blankLiterals) blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Comment bodies blanked; strings, templates and regexes left intact. */
export function stripComments(source) {
  return removeNonCode(source, { literals: false });
}

/** Comments AND literal bodies blanked: every byte of what survives is code. */
export function liveCode(source) {
  return removeNonCode(source, { literals: true });
}
