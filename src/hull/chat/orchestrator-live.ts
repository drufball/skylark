import { db } from '@hull/db/client'
import { subscribeToShipLog } from '@hull/events/bus'
import { createServerRuntime } from '@hull/agent/fake-session'

import { type ChatOrchestrator, createChatOrchestrator } from './orchestrator'

/* v8 ignore start -- live wiring: the real agent runtime + the ship-log
   subscription. The orchestrator's DECISIONS (reply targeting, the bus-note
   handler, reconcile) are unit-tested against PGlite + a fake runtime in
   orchestrator.test.ts; this file is the impure shell that connects them to the
   real bus and real pi sessions, exercised by running the app. */

let started: ChatOrchestrator | undefined

/**
 * Boot the chat orchestrator into the server process (idempotent): wire it to
 * the real runtime and subscribe it to the ship's log, so a posted message
 * drives the agent reply off the bus (the same path the issues orchestrator
 * uses). `subscribeToShipLog` registers the subscription synchronously and kicks
 * startup reconciliation in the background, so booting never blocks a door.
 */
export function ensureChatOrchestrator(): ChatOrchestrator {
  if (started) return started
  const runtime = createServerRuntime(db)
  started = createChatOrchestrator({ db, runtime })
  subscribeToShipLog(started, 'chat orchestrator')
  return started
}
/* v8 ignore stop */
