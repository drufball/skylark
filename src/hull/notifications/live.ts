import { systemDb } from '@hull/db/client'
import { subscribeToShipLog } from '@hull/events/bus'

import { createNotificationsReactor } from './service'

/* v8 ignore start -- live wiring: the ship-log subscription + process singleton.
   The reactor's decisions are unit-tested in service.test.ts; this file only
   connects them to the running ship. */

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
    createNotificationsReactor({ db: systemDb }),
    'notifications',
  )
}
/* v8 ignore stop */
