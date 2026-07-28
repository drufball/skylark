import { useEffect, useState } from 'react'

/**
 * One live read: what the last read came back with, and whether the LATEST
 * read failed. `value` stays at the last good answer through a failure — the
 * two facts move independently, which is the whole point.
 */
export interface LiveRead<T> {
  value: T | null
  failed: boolean
}

/**
 * The fetch/degrade state machine every live kind rides: run `read` on mount
 * and again whenever `deps` move (in practice, the `revision` the surface
 * bumps when an event lands on a subscribed topic — see the stack), and hold
 * what it came back with.
 *
 * On failure it KEEPS the last good value while setting `failed`: the ship
 * degrades to "database: down" rather than crashing, and so does a tile on it
 * — an honest "couldn't read just now" over yesterday's list beats a blank
 * box. A read that settles after unmount (or after `deps` have already moved
 * on) is dropped, so a slow response can never overwrite a fresh one.
 *
 * `read` is taken fresh from the render that ran the effect, so it may close
 * over props without being memoised — only `deps` decide when to read again.
 */
export function useLiveRead<T>(
  read: () => Promise<T>,
  deps: unknown[],
): LiveRead<T> {
  const [state, setState] = useState<LiveRead<T>>({
    value: null,
    failed: false,
  })
  useEffect(() => {
    let cancelled = false
    void read().then(
      (value) => {
        if (!cancelled) setState({ value, failed: false })
      },
      () => {
        if (!cancelled) setState((prev) => ({ ...prev, failed: true }))
      },
    )
    return () => {
      cancelled = true
    }
    // The caller's deps ARE the dependency list — `read` itself is deliberately
    // not in it (see above), which the static rule cannot see from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}
