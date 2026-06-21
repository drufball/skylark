import type { Database } from '@hull/db/client'
import { runAsActor } from '@hull/db/with-actor'
import { chatIdFromTopic, getChat } from '@hull/chat/service'
import { getSession } from '@hull/agent/service'
import { sessionIdFromTopic } from '@hull/agent/runtime'

// The ONE entitlement gate. Everything that needs "may this actor see X?" — the
// SSE stream, and the in-process control doors (cancel/send a turn) — asks
// `canSeeTopic` with a ship-log topic, so there's a single front door and no
// caller writing its own bespoke check that could drift.
//
// It works by PROBING the parent resource under the actor's RLS context: read
// the row as that actor and see if it comes back. So the RLS policies are the
// single source of truth — `app_can_see_chat` (migration 0007) and
// `app_can_see_session` (0008). Each module parses its own topic grammar
// (`chatIdFromTopic`, `sessionIdFromTopic`); a topic no kind owns (e.g.
// `issue:*`) is public.
//
// (Why a gate at all, if RLS filters table reads? The event bus isn't a table
// read — ephemeral events never touch Postgres, and live delivery decides per
// subscriber — and `cancel` is an in-process action, not a query. Those are the
// surfaces RLS can't reach, so they ask this gate, which still defers to RLS.)

/**
 * May `actorId` see events on `topic`? Probe the parent under RLS (chat→chats,
 * session→agent_sessions); a topic no kind owns (e.g. `issue:*`) is public.
 */
export async function canSeeTopic(
  db: Database,
  actorId: string,
  topic: string,
): Promise<boolean> {
  // Did the row come back when read as this actor? RLS hides what they can't see.
  const seen = <T>(read: (tx: Database) => Promise<T | undefined>) =>
    runAsActor(db, actorId, read).then((row) => row !== undefined)

  const chatId = chatIdFromTopic(topic)
  if (chatId !== null) return seen((tx) => getChat(tx, chatId))

  const sessionId = sessionIdFromTopic(topic)
  if (sessionId !== null) return seen((tx) => getSession(tx, sessionId))

  return true
}
