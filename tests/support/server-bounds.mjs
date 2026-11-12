import { hostSteal, stretchedBounds } from '../../tools/lib/chrome.mjs';

/**
 * Bounds for a suite that SPAWNS a server and then fetches it.
 *
 * Both waits used to be fixed constants: a 5000 ms fetch abort and a 30000 ms ready bound. On a
 * starved host the child needs more wall clock than that, and the failure arrives as a
 * client-side TimeoutError - which is indistinguishable from a product bug and turns the gate
 * red for every lane on the VM (airhorn-dwbl). The SHAPE stays the same; only the numbers
 * stretch, by the host's own measured steal, capped by stretchedBounds' MAX_BOUND_STRETCH.
 *
 * The steal is measured ONCE per call to this function - callers do it at module load - rather
 * than per timer: the value is a property of the host for the length of a suite, and re-reading
 * /proc inside a wait would make the bound move under the thing it is bounding. An UNKNOWN steal
 * (unreadable /proc/stat) returns the fixed bounds unchanged, which is the honest fallback: the
 * adaptor cannot claim to have stretched anything it did not measure.
 */
export function serverBounds({ steal = hostSteal(), fetchMs = 5000, readyMs = 30000 } = {}) {
  const stretched = stretchedBounds({ timeoutMs: readyMs, discoveryMs: fetchMs, steal });
  return { fetchMs: stretched.discoveryMs, readyMs: stretched.timeoutMs, steal };
}
