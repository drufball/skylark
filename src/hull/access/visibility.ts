import type { Database } from '@hull/db/client'
import { runAsActor } from '@hull/db/with-actor'
import { chatIdFromTopic, getChat } from '@hull/chat/service'
import { getSession } from '@hull/agent/service'
import { sessionIdFromTopic } from '@hull/agent/runtime'

// Who may see a ship's-log topic? The entitlement gate for the SSE stream and
// for control actions that aren't plain table reads (cancelling a turn). Topic
// patterns decide what a client asked for; this decides what they're allowed.
//
// It works by PROBING the parent resource under the actor's RLS context: read
// the row as that actor and see if it comes back. So the RLS policies are the
// single source of truth — `app_can_see_chat` (migration 0007) and
// `app_can_see_session` (0008) — and this never re-derives membership or origin
// in app code. Each module parses its own topic grammar (`chatIdFromTopic`,
// `sessionIdFromTopic`); a topic no rule owns (e.g. `issue:*`) is public.
//
// (Why a gate at all, if RLS filters table reads? The event bus isn't a table
// read — ephemeral events never touch Postgres, and live delivery decides per
// subscriber — and `cancel` is an in-process action, not a query. Those are the
// surfaces RLS can't reach, so they ask this gate, which still defers to RLS.)

/**
 * May `actorId` see this agent session? Probe it under the actor's RLS context:
 * if the row comes back, the session-visibility policy (issue→public,
 * chat→members, bare→crew) allowed it. The agent doors call this for control
 * actions; `canSeeTopic` routes `session:` topics here, so the doors and the
 * stream funnel session visibility through one function — and one policy.
 */
export async function canSeeSession(
  db: Database,
  actorId: string,
  sessionId: string,
): Promise<boolean> {
  const session = await runAsActor(db, actorId, (tx) =>
    getSession(tx, sessionId),
  )
  return session !== undefined
}

/**
 * May `actorId` see events on `topic`? Probe the parent under RLS (chat→chats,
 * session→agent_sessions); a topic no kind owns (e.g. `issue:*`) is public.
 */
export async function canSeeTopic(
  db: Database,
  actorId: string,
  topic: string,
): Promise<boolean> {
  const chatId = chatIdFromTopic(topic)
  if (chatId !== null) {
    const chat = await runAsActor(db, actorId, (tx) => getChat(tx, chatId))
    return chat !== undefined
  }

  const sessionId = sessionIdFromTopic(topic)
  if (sessionId !== null) return canSeeSession(db, actorId, sessionId)

  return true
}
