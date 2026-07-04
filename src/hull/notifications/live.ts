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
 * globalThis-based arm-once registry (defense in depth, survives module
 * re-execution). The boot module's registry prevents redundant boot calls;
 * this ensures the reactor itself is protected even if called directly.
 * The reactor subscription persists across module executions, so armed-but-lost
 * is a valid steady state (the old subscription is still active) (#2wkv).
 */
interface GlobalWithNotificationsReactor {
  __SKYLARK_NOTIFICATIONS_REACTOR__?: { armed: boolean }
}

function getRegistry(): { armed: boolean } {
  const g = globalThis as GlobalWithNotificationsReactor
  g.__SKYLARK_NOTIFICATIONS_REACTOR__ ??= { armed: false }
  return g.__SKYLARK_NOTIFICATIONS_REACTOR__
}

/**
 * Boot the notifications reactor in this process (idempotent): subscribe the
 * fan-out to the ship's log. Runs on systemDb — writing inbox rows across
 * users is system plumbing no single actor's RLS context could do.
 *
 * Arm-once: uses globalThis registry that survives module re-execution (SSR
 * reload resets module state but globalThis persists), so subscriptions never
 * stack even without import.meta.hot.dispose cooperation (#lo0x).
 */
export function ensureNotificationsReactor(): void {
  const registry = getRegistry()
  if (booted) return
  if (registry.armed) {
    // Reactor armed in a previous module execution but module state lost:
    // the subscription from the previous execution is still active in the bus,
    // so just restore the booted flag and return normally.
    booted = true
    return
  }
  registry.armed = true
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
/* v8 ignore stop */
