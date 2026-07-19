import { useEffect, useState } from 'react'

import { getBehindOrigin } from '@hull/health/server'

/**
 * How many commits `origin/main` is ahead of the serving checkout — issue
 * #f70a's silent-staleness signal — polled every `intervalMs` (default 5
 * minutes, matching the server's own fetch cache window: polling faster than
 * that would only ever replay the same cached answer). Fetched once on mount
 * too, so a fresh page — including a Dock remount on navigation — shows the
 * current count without waiting a full interval.
 *
 * `null` covers both "not behind" and "unknown" (the door degrades failures
 * to null rather than throwing); either way the shell renders nothing, so a
 * flaky check never puts a false alarm in front of the crew.
 */
export function useBehindOrigin(intervalMs = 5 * 60 * 1000): number | null {
  const [behind, setBehind] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false

    async function check() {
      const result = await getBehindOrigin().catch(() => null)
      if (!cancelled) setBehind(result)
    }

    void check()
    const id = setInterval(() => void check(), intervalMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [intervalMs])

  return behind
}
