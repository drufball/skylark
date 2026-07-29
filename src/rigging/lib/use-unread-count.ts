import { useCallback, useEffect, useState } from 'react'

import { unreadNotificationCount } from '@hull/notifications/server'
import { NOTIFY_TOPIC_PATTERN } from '@hull/notifications/topic'

import { useShipLog, type EventSourceFactory } from './use-ship-log'

/**
 * The current actor's unread notification count, live \u2014 what badges the
 * rail's permanent Inbox entry (#933f) on every surface, not just the inbox
 * itself. Fetched once on mount and re-fetched whenever a notification event
 * lands on the wildcard `notify:*` pattern (the same one the `inbox` widget
 * subscribes to): the props here can't name a viewer either, so the caller
 * can't name a topic \u2014 and that's safe by construction, because
 * `canSeeTopic` admits a `notify:<userId>` event only to that user, so this
 * hook is only ever told about the CALLER's own notifications landing.
 *
 * `null` while unknown (before the first read lands, or after a failed one)
 * draws no badge \u2014 same "degrade to nothing rather than lie" posture as
 * `useBehindOrigin`.
 */
export function useUnreadCount(
  eventSourceFactory?: EventSourceFactory,
): number | null {
  const [count, setCount] = useState<number | null>(null)

  const read = useCallback(() => {
    unreadNotificationCount()
      .then((n) => {
        setCount(n)
      })
      .catch(() => {
        setCount(null)
      })
  }, [])

  useEffect(() => {
    read()
  }, [read])

  useShipLog([NOTIFY_TOPIC_PATTERN], read, eventSourceFactory)

  return count
}
