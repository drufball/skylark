import { useCallback } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useShipLog } from './use-ship-log'

/**
 * Subscribes to ship-log topics and invalidates the router on events.
 *
 * Combines the common pattern of listening to ship-log events and
 * re-running the loader by calling router.invalidate().
 *
 * @param topics - Topic strings or patterns to subscribe to
 *
 * @example
 * // Re-load when this issue's topic fires
 * useShipLogInvalidate([issueTopic(id)])
 *
 * @example
 * // Re-load on any issue event
 * useShipLogInvalidate([ISSUE_TOPIC_PATTERN])
 */
export function useShipLogInvalidate(topics: string[]) {
  const router = useRouter()

  const onEvent = useCallback(() => {
    void router.invalidate()
  }, [router])

  useShipLog(topics, onEvent)
}
