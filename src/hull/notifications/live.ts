import { systemDb } from '@hull/db/client'
import { subscribeToShipLog } from '@hull/events/bus'

import type { NotificationRow } from './schema'
import { createNotificationsReactor, deliverToHooks } from './service'

/* v8 ignore start -- live wiring: the ship-log subscription + process singleton.
   The reactor's decisions are unit-tested in service.test.ts; this file only
   connects them to the running ship. */

/**
 * Delivery hooks beyond the inbox row itself — the chat orchestrator registers
 * the agent waker here. Module state read at delivery time, so registration
 * order versus reactor boot doesn't matter.
 */
const deliveryHooks: ((notification: NotificationRow) => void)[] = []

/**
 * Register a delivery hook (e.g. "wake the agent this notification is for").
 * Returns an unsubscribe function to remove the hook — callers must store and
 * call it on HMR cleanup to prevent hook stacking (the #xwh2 bug).
 */
export function onNotificationDelivered(
  hook: (notification: NotificationRow) => void,
): () => void {
  deliveryHooks.push(hook)
  return () => {
    const idx = deliveryHooks.indexOf(hook)
    if (idx !== -1) deliveryHooks.splice(idx, 1)
  }
}

let booted = false
let unsubscribe: (() => void) | undefined

/**
 * Boot the notifications reactor in this process (idempotent): subscribe the
 * fan-out to the ship's log. Runs on systemDb — writing inbox rows across
 * users is system plumbing no single actor's RLS context could do.
 *
 * HMR-safe: cleans up the old subscription on Vite reload so one reactor
 * doesn't stack to N on N reloads (the #xwh2 bug).
 */
export function ensureNotificationsReactor(): void {
  if (booted) return
  booted = true
  // On HMR reload, module state resets but the InProcessBus subscription
  // persists (it's in a different module). Clean up the old one first.
  unsubscribe?.()
  unsubscribe = subscribeToShipLog(
    createNotificationsReactor({
      db: systemDb,
      // deliverToHooks (tested in the service) isolates each hook, matching
      // the reactor's best-effort posture.
      onNotified: (row) => {
        deliverToHooks(deliveryHooks, row)
      },
    }),
    'notifications',
  )
}

// HMR cleanup: unsubscribe on reload so the old reactor doesn't stack with the
// new one. Vite calls dispose() before reloading the module.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribe?.()
    unsubscribe = undefined
    booted = false
  })
}
/* v8 ignore stop */
