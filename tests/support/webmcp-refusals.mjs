/*
 * The refusal-message contract for the WebMCP hostile-input suite, pure so the pin
 * drives the real predicate browser-free (airhorn-g0qr.13).
 *
 * The defect this fixes: both rules used to be gated on `result.code` being truthy,
 * so a refusal carrying NO code but a huge error string passed every check - the
 * length bound only fired when a sibling field was set. The length bound now applies
 * whenever an error string is present; the blank-message rule stays code-gated (a
 * code-less, message-less refusal has nothing to judge - that shape is the harness's
 * own "not a refusal result" branch, not this contract).
 */

export const REFUSAL_MESSAGE_MAX = 200;

export const refusalMessageViolations = (label, result) => {
  const violations = [];
  // Presence-of-content, not length: whitespace around an empty value is what a
  // template produces, so trimming decides PRESENCE only (never the measured value).
  const hasUsableMessage = typeof result.error === 'string' && result.error.trim() !== '';
  if (result.code && !hasUsableMessage) {
    violations.push(`${label} was refused with code ${JSON.stringify(result.code)} but carried no usable error message (blank or absent, got ${JSON.stringify(result.error ?? null)})`);
  }
  // airhorn-g0qr.13: the length bound is NOT gated on the code - a code-less refusal
  // carrying a megabyte of prose is the same defect as a coded one.
  if (typeof result.error === 'string' && result.error.length > REFUSAL_MESSAGE_MAX) {
    violations.push(`${label} returned a ${result.error.length}-character error message`);
  }
  return violations;
};
