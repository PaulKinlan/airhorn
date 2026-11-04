/**
 * tools/lib/mutation-reporter.mjs — the test-runner reporter tools/mutation-check.mjs runs.
 *
 * It exists for ONE reason: to answer "did a test actually start, and did an assertion INSIDE
 * a test fail?" from a place the suite cannot write to. A reporter module loads in the RUNNER
 * process, and the test file runs in the runner's child, whose output can only reach this
 * stream as diagnostics - so a suite cannot emit a passing or failing POINT. That is the
 * difference between this and every earlier attempt at the question in this repo
 * (airhorn-u1v2): a source scan reads text the suite writes (a comment moved the verdict), an
 * import record is written by the suite's own process (a strip of the handlers moved it), and
 * a report FILE named in an environment variable can be written by the suite (a forged report
 * moved it, airhorn-gwcm).
 *
 * The one structural rule is about the event's OWN fields, never about how the suite was
 * spelled on the command line (the trap in airhorn-lnme):
 *
 *   a FILE-LEVEL entry  is the runner accounting for the FILE as a whole - a load crash, a
 *                       throw after the tests finished, a top-level script assertion, or a
 *                       file that registered no test - and is recognised in two ways, both
 *                       from the event's own fields:
 *                         (a) its name IS its file, decided FOUR ways that must not depend on
 *                             how the suite was spelled or on whether the path crosses a
 *                             symlink: name === basename(file); basename(name) ===
 *                             basename(file); the two canonicalise (realpath) to the same
 *                             file; or the two resolve to the same path. node names that
 *                             entry with the path AS PASSED ('tests/x.test.mjs'), so
 *                             comparing against basename alone marked every
 *                             directory-qualified suite as a real test - the airhorn-lnme
 *                             trap, one level deeper (round 4). Path identity is checked
 *                             through realpath as well as resolve, because a suite reached
 *                             through a symlinked directory is the same file and node's
 *                             choice of spelling in data.file is not something to rely on;
 *                         (b) it carries node's own wrapper error: code ERR_TEST_FAILURE
 *                             with the message 'test failed'.
 *   a REAL TEST         has its own name and its own error.
 *
 * A real test that happens to be named exactly like its own file would be read as file-level:
 * that is an under-claim, which is the safe direction for this tool.
 *
 * Output: one JSON object per line, on stdout, for the tool to parse.
 */
import fs from 'node:fs';
import path from 'node:path';

export default async function* mutationReporter(source) {
  for await (const event of source) {
    const kind = event.type === 'test:fail' ? 'fail' : event.type === 'test:pass' ? 'pass' : null;
    if (!kind) continue;
    const data = event.data || {};
    const file = typeof data.file === 'string' ? data.file : '';
    const name = typeof data.name === 'string' ? data.name : '';
    const details = data.details || {};
    const error = details.error;
    const reason = error && typeof error.message === 'string' ? error.message.split('\n')[0].slice(0, 300) : null;
    const resolve = (value) => {
      try {
        return path.resolve(value);
      } catch {
        return null;
      }
    };
    const canonical = (value) => {
      try {
        return fs.realpathSync(path.resolve(value));
      } catch {
        return resolve(value);
      }
    };
    const base = (value) => {
      try {
        return path.basename(value);
      } catch {
        return null;
      }
    };
    // (a) the entry's name IS its file, however the file was spelled on the command line and
    // however the path got there (a symlinked directory is the same file)
    const nameIsFile = Boolean(file) && (
      name === base(file)
      || base(name) === base(file)
      || canonical(name) === canonical(file)
      || resolve(name) === resolve(file)
    );
    // (b) node's own wrapper error for "the file failed", as opposed to a test that failed
    const wrapperError = kind === 'fail' && Boolean(error) && error.code === 'ERR_TEST_FAILURE' && /^test failed/.test(String(error.message || ''));
    yield `${JSON.stringify({
      event: kind,
      name,
      file,
      nesting: typeof data.nesting === 'number' ? data.nesting : null,
      detailsType: typeof details.type === 'string' ? details.type : null,
      fileLevel: nameIsFile || wrapperError,
      fileLevelBy: nameIsFile ? 'name-is-file' : wrapperError ? 'wrapper-error' : null,
      reason,
      skip: Boolean(data.skip),
      todo: Boolean(data.todo),
    })}\n`;
  }
}
