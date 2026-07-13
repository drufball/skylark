import { useEffect, useState } from 'react'

/**
 * The current time, re-rendering every `intervalMs` (default 30s). Needed for
 * anything that reads as "stalled after N minutes of silence" (the issue
 * board/thread's build-activity indicator, see `@hull/issues/activity`) — a
 * genuinely stalled session emits NO further events by definition, so nothing
 * else would ever re-trigger the render that flips "waiting" into "stalled".
 *
 * Starts from the render-time `Date.now()` (fine for SSR — no window access),
 * then ticks forward on an interval cleaned up on unmount.
 */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = setInterval(() => {
      setNow(new Date())
    }, intervalMs)
    return () => {
      clearInterval(id)
    }
  }, [intervalMs])

  return now
}
