import { systemDb } from '@hull/db/client'
import { subscribeToShipLog } from '@hull/events/bus'
import { errorMessage } from '@hull/lib/errors'

import type { NotificationRow } from './schema'
import { createNotificationsReactor } from './service'

/* v8 ignore start -- live wiring: the ship-log subscription + process singleton.
   The reactor's decisions are unit-tested in service.test.ts; this file only
   connects them to the running ship. */

/**
 * Delivery hooks beyond the inbox row itself — the chat orchestrator registers
 * the agent waker here. Module state read at delivery time, so registration
 * order versus reactor boot doesn't matter.
 */
const deliveryHooks: ((notification: NotificationRow) => void)[] = []

/** Register a delivery hook (e.g. "wake the agent this notification is for"). */
export function onNotificationDelivered(
  hook: (notification: NotificationRow) => void,
): void {
  deliveryHooks.push(hook)
}

let booted = false

/**
 * Boot the notifications reactor in this process (idempotent): subscribe the
 * fan-out to the ship's log. Runs on systemDb — writing inbox rows across
 * users is system plumbing no single actor's RLS context could do.
 */
export function ensureNotificationsReactor(): void {
  if (booted) return
  booted = true
  subscribeToShipLog(
    createNotificationsReactor({
      db: systemDb,
      onNotified: (row) => {
        // Each hook isolated, matching the reactor's best-effort posture — one
        // broken delivery channel must not silence the others.
        for (const hook of deliveryHooks) {
          try {
            hook(row)
          } catch (err) {
            console.error(`notification hook failed: ${errorMessage(err)}`)
          }
        }
      },
    }),
    'notifications',
  )
}
/* v8 ignore stop */
