import { systemDb } from '@hull/db/client'
import { subscribeToShipLog } from '@hull/events/bus'
import { createServerRuntime } from '@hull/agent/fake-session'
import { getIssue } from '@hull/issues/service'
import { issueIdFromTopic } from '@hull/issues/topic'
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

import { type ChatOrchestrator, createChatOrchestrator } from './orchestrator'
import { createAgentWaker } from './waker'

/* v8 ignore start -- live wiring: the real agent runtime + the ship-log
   subscription. The orchestrator's DECISIONS (reply targeting, the bus-note
   handler, reconcile) are unit-tested against PGlite + a fake runtime in
   orchestrator.test.ts, and the waker's in waker.test.ts; this file is the
   impure shell that connects them to the real bus and real pi sessions,
   exercised by running the app. */

/** How long a flurry of notifications gathers before one wake fires. */
const WAKE_DEBOUNCE_MS = 10_000

let started: ChatOrchestrator | undefined
let unsubscribeBus: (() => void) | undefined
let unsubscribeHook: (() => void) | undefined

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
 * Also arms the agent waker: the notifications reactor's delivery hook routes
 * an agent's inbox entries back to the chat the work was filed from
 * (issues.originChatId) and wakes the agent there with the unread batch —
 * which is why this also ensures the reactor runs in this process.
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
    chatForTopic: async (topic) => {
      const issueId = issueIdFromTopic(topic)
      if (!issueId) return null
      return (await getIssue(systemDb, issueId))?.originChatId ?? null
    },
    describe: async (n) =>
      describeNotification({
        type: n.type,
        topic: n.topic,
        payload: n.payload,
        actorHandle: await handleOf(systemDb, n.actorId),
      }),
    wake: (chatId, agentUserId, briefing) =>
      orchestrator.wake(chatId, agentUserId, briefing),
    debounceMs: WAKE_DEBOUNCE_MS,
  })
  unsubscribeHook = onNotificationDelivered((notification) => {
    waker.onNotified(notification)
  })
  ensureNotificationsReactor()

  return orchestrator
}
/* v8 ignore stop */
