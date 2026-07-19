import { systemDb } from '@hull/db/client'
import { subscribeToShipLog } from '@hull/events/bus'
import { createServerRuntime } from '@hull/agent/server-runtime'
import {
  ensureNotificationsReactor,
  onNotificationDelivered,
} from '@hull/notifications/live'
import {
  describeNotification,
  listUnread,
  markRead,
} from '@hull/notifications/service'
import { getUserById, handleOf } from '@hull/users/service'
import { startIntervalSweep } from '@hull/lib/interval-sweep'

import { type ChatOrchestrator, createChatOrchestrator } from './orchestrator'
import { fireDueSchedules } from './service'
import { createAgentWaker } from './waker'

/* v8 ignore start -- live wiring: the real agent runtime + the ship-log
   subscription. The orchestrator's DECISIONS (reply targeting, the bus-note
   handler, reconcile) are unit-tested against PGlite + a fake runtime in
   orchestrator.test.ts, and the waker's in waker.test.ts; this file is the
   impure shell that connects them to the real bus and real pi sessions,
   exercised by running the app. */

/** How long a flurry of notifications gathers before one wake fires. */
const WAKE_DEBOUNCE_MS = 10_000

/**
 * How often the schedule sweep checks for due schedules. The interval floor is
 * five minutes, so a 30s cadence keeps a fire within half a minute of its time
 * — responsive without being chatty (mirrors the files sweep's 30s tick). A
 * long-overdue row from a reboot still fires exactly once (advanceNextFire).
 */
const SCHEDULE_SWEEP_INTERVAL_MS = 30_000

let started: ChatOrchestrator | undefined
let unsubscribeBus: (() => void) | undefined
let unsubscribeHook: (() => void) | undefined
let stopScheduleSweep: (() => void) | undefined

/**
 * globalThis-based arm-once registry (defense in depth, survives module
 * re-execution). The boot module's registry prevents redundant boot calls;
 * this ensures the reactor itself is protected even if called directly.
 * Stores the LIVE INSTANCE so module re-execution returns the same functioning
 * orchestrator, not a stub (#2wkv).
 */
interface GlobalWithChatOrchestrator {
  __SKYLARK_CHAT_ORCHESTRATOR__?: {
    armed: boolean
    instance?: ChatOrchestrator
  }
}

function getRegistry(): { armed: boolean; instance?: ChatOrchestrator } {
  const g = globalThis as GlobalWithChatOrchestrator
  g.__SKYLARK_CHAT_ORCHESTRATOR__ ??= { armed: false }
  return g.__SKYLARK_CHAT_ORCHESTRATOR__
}

/**
 * Boot the chat orchestrator into the server process (idempotent): wire it to
 * the real runtime and subscribe it to the ship's log, so a posted message
 * drives the agent reply off the bus (the same path the issues orchestrator
 * uses). `subscribeToShipLog` registers the subscription synchronously and kicks
 * startup reconciliation in the background, so booting never blocks a door.
 *
 * Also arms the agent waker: the notifications reactor's delivery hook batches
 * an agent's inbox entries and wakes it on its own inbox session with the
 * unread batch — the agent decides for itself which chat (if any) an update
 * belongs in — which is why this also ensures the reactor runs in this
 * process.
 *
 * Arm-once: uses globalThis registry that survives module re-execution (SSR
 * reload resets module state but globalThis persists), so subscriptions never
 * stack even without import.meta.hot.dispose cooperation (#lo0x).
 */
export function ensureChatOrchestrator(): ChatOrchestrator {
  const registry = getRegistry()
  if (started) return started
  if (registry.armed && registry.instance) {
    // Reactor armed in a previous module execution but module state lost:
    // restore the live instance from the registry so callers get the SAME
    // functioning orchestrator, not a stub that silently drops work.
    started = registry.instance
    return registry.instance
  }
  registry.armed = true
  // On HMR reload, module state resets but subscriptions in other modules
  // persist (InProcessBus, deliveryHooks). Clean up the old ones first.
  unsubscribeBus?.()
  unsubscribeHook?.()
  stopScheduleSweep?.()
  // systemDb (superuser): the orchestrator is fixed plumbing — it scans all
  // chats to recover work (reconcile) and posts the agent's reply, which under
  // app_user with no actor would fail closed. It reacts to events, it doesn't
  // serve a request, so RLS-bypass is safe here. The waker rides the same
  // posture: it reads agents' inboxes and drives their sessions.
  const runtime = createServerRuntime(systemDb)
  const orchestrator = createChatOrchestrator({ db: systemDb, runtime })
  registry.instance = orchestrator
  started = orchestrator
  unsubscribeBus = subscribeToShipLog(orchestrator, 'chat orchestrator')

  const waker = createAgentWaker({
    isAgent: async (userId) =>
      (await getUserById(systemDb, userId))?.type === 'agent',
    listUnread: (userId) => listUnread(systemDb, userId),
    markRead: (userId, ids) => markRead(systemDb, userId, ids),
    describe: async (n) =>
      describeNotification({
        type: n.type,
        topic: n.topic,
        payload: n.payload,
        actorHandle: await handleOf(systemDb, n.actorId),
      }),
    wake: (agentUserId, briefing) => orchestrator.wake(agentUserId, briefing),
    debounceMs: WAKE_DEBOUNCE_MS,
  })
  unsubscribeHook = onNotificationDelivered((notification) => {
    waker.onNotified(notification)
  })
  ensureNotificationsReactor()

  // The schedule sweep: fire every due chat schedule (one-shot or recurring) by
  // calling chat's own addMessage as the author — nothing else, so the reply
  // rules do the rest. On systemDb (RLS bypassed), the same posture as the
  // orchestrator; the shared interval helper keeps it unref'd + error-swallowing.
  stopScheduleSweep = startIntervalSweep({
    intervalMs: SCHEDULE_SWEEP_INTERVAL_MS,
    label: 'chat schedules',
    tick: (now) => fireDueSchedules(systemDb, new Date(now)),
  })

  return orchestrator
}
/* v8 ignore stop */
