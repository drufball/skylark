/**
 * Wrap an async function so that while one call is in flight, further calls are
 * DROPPED (return immediately) rather than overlapping. Used to make a recurring
 * sweep re-entrancy-safe: a tick that runs past its interval (a slow database
 * waking, say) must not have the next tick fire on top of it and re-read the
 * same not-yet-persisted state — two overlapping night-watch sweeps would both
 * see `nudgeCount = 0` and fire two interventions for one stall.
 *
 * A dropped call resolves with `undefined` (the work was skipped, not failed).
 * `inFlight` is reset in a `finally`, so a rejected run never wedges the gate
 * shut — the rejection propagates to the caller (the interval sweep logs it).
 */
export function singleFlight<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown>,
): (...args: A) => Promise<void> {
  let inFlight = false
  return async (...args: A): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      await fn(...args)
    } finally {
      inFlight = false
    }
  }
}
