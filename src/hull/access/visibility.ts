import type { Database } from '@hull/db/client'
import { runAsActor } from '@hull/db/with-actor'
import { getChat } from '@hull/chat/service'
import { chatIdFromTopic } from '@hull/chat/topic'
import { getSession } from '@hull/agent/service'
import { sessionIdFromTopic } from '@hull/agent/topic'
import { FILE_TOPIC_PREFIX } from '@hull/files/topic'
import { ISSUE_TOPIC_PREFIX } from '@hull/issues/topic'
import { userIdFromNotifyTopic } from '@hull/notifications/topic'

// The ONE entitlement gate. Everything that needs "may this actor see X?" — the
// SSE stream, and the in-process control doors (cancel/send a turn) — asks
// `canSeeTopic` with a ship-log topic, so there's a single front door and no
// caller writing its own bespoke check that could drift.
//
// It works by PROBING the parent resource under the actor's RLS context: read
// the row as that actor and see if it comes back. So the RLS policies are the
// single source of truth — `app_can_see_chat` (migration 0007) and
// `app_can_see_session` (0008). Each module parses its own topic grammar
// (`chatIdFromTopic`, `sessionIdFromTopic`).
//
// (Why a gate at all, if RLS filters table reads? The event bus isn't a table
// read — ephemeral events never touch Postgres, and live delivery decides per
// subscriber — and `cancel` is an in-process action, not a query. Those are the
// surfaces RLS can't reach, so they ask this gate, which still defers to RLS.)

/**
 * The topic grammars that are deliberately crew-public, named here beside the
 * private ones so the whole vocabulary is on one page. Everything else on this
 * ship is fail-closed by construction (RLS sees nothing, `withActor` unset
 * matches no rows) — this list is what keeps the gate the same way: a topic no
 * grammar claims is DENIED, so a service that mints a private topic and
 * forgets this file ships "the new tiles don't go live" (a bug somebody sees),
 * not "its events stream to the whole crew" (a leak nobody does).
 */
const PUBLIC_TOPIC_PREFIXES = [
  // The issue board is a crew-shared surface.
  ISSUE_TOPIC_PREFIX,
  // Shared documents (`file:<path>`) and the files service's ops news
  // (`files:staging`, `files:sweep`).
  FILE_TOPIC_PREFIX,
  'files:',
]

/**
 * May `actorId` see events on `topic`? Private grammars are probed under RLS
 * (chat→chats, session→agent_sessions) or matched on ownership (notify);
 * `PUBLIC_TOPIC_PREFIXES` are open to the crew; anything else is denied.
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

  // A notification topic is private to its owner — no probe needed: the topic
  // IS the entitlement (notify:<userId> admits exactly that user).
  const notifyUserId = userIdFromNotifyTopic(topic)
  if (notifyUserId !== null) return actorId === notifyUserId

  if (PUBLIC_TOPIC_PREFIXES.some((prefix) => topic.startsWith(prefix)))
    return true

  // Unknown grammar: refuse, and say so once — the complaint is what turns
  // "my widget never updates" into a one-line fix in this file.
  warnUnknownTopic(topic)
  return false
}

const warnedPrefixes = new Set<string>()

/** One console complaint per unknown grammar, not one per event. */
function warnUnknownTopic(topic: string): void {
  const prefix = topic.slice(0, topic.indexOf(':') + 1) || topic
  if (warnedPrefixes.has(prefix)) return
  warnedPrefixes.add(prefix)
  console.warn(
    `canSeeTopic: denying topic "${topic}" — no grammar claims it. ` +
      `If this grammar is real, register it in hull/access/visibility.ts ` +
      `(probe it like chat/session, or list its prefix as crew-public).`,
  )
}
