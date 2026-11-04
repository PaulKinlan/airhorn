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
 *   a FILE-LEVEL entry  has name === basename(file) - it is the runner accounting for the
 *                       file as a whole: a load crash, a throw after the tests finished, a
 *                       top-level script assertion, or a file that registered no test;
 *   a REAL TEST         has its own name.
 *
 * A real test that happens to be named exactly like its own file would be read as file-level:
 * that is an under-claim, which is the safe direction for this tool.
 *
 * Output: one JSON object per line, on stdout, for the tool to parse.
 */
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
    yield `${JSON.stringify({
      event: kind,
      name,
      file,
      nesting: typeof data.nesting === 'number' ? data.nesting : null,
      detailsType: typeof details.type === 'string' ? details.type : null,
      fileLevel: Boolean(file) && name === path.basename(file),
      reason: error && typeof error.message === 'string' ? error.message.split('\n')[0].slice(0, 300) : null,
      skip: Boolean(data.skip),
      todo: Boolean(data.todo),
    })}\n`;
  }
}
