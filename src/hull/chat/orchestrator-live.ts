import { db } from '@hull/db/client'
import { ensureShipLogListener, shipLogBus } from '@hull/events/bus'
import { createAgentRuntime, createPiSession } from '@hull/agent/runtime'
import { errorMessage } from '@hull/lib/errors'

import { type ChatOrchestrator, createChatOrchestrator } from './orchestrator'

/* v8 ignore start -- live wiring: the real agent runtime + the ship-log
   subscription. The orchestrator's DECISIONS (reply targeting, the bus-note
   handler, reconcile) are unit-tested against PGlite + a fake runtime in
   orchestrator.test.ts; this file is the impure shell that connects them to the
   real bus and real pi sessions, exercised by running the app. */

let started: ChatOrchestrator | undefined

/**
 * Boot the chat orchestrator into the server process (idempotent): wire it to
 * the real runtime, subscribe it to the ship's log so a posted message drives
 * the agent reply off the bus (the same path the issues orchestrator uses), and
 * run startup reconciliation for any human message a restart left unanswered.
 */
export async function ensureChatOrchestrator(): Promise<ChatOrchestrator> {
  if (started) return started

  ensureShipLogListener()
  const runtime = createAgentRuntime({ db, factory: createPiSession })
  const orch = createChatOrchestrator({ db, runtime })

  shipLogBus.subscribe((note) => {
    void orch.handleBusNote(note).catch((err: unknown) => {
      console.error(
        `chat orchestrator bus handler failed: ${errorMessage(err)}`,
      )
    })
  })

  started = orch
  await orch.reconcile().catch((err: unknown) => {
    console.error(`chat reconcile failed: ${errorMessage(err)}`)
  })
  return orch
}
/* v8 ignore stop */
