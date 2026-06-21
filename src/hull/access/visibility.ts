import type { Database } from '@hull/db/client'
import { chatIdForSession, chatIdFromTopic, isMember } from '@hull/chat/service'
import { sessionIdFromTopic } from '@hull/agent/runtime'
import { issueOwnsSession } from '@hull/issues/service'

// Who may see a ship's-log topic? The entitlement gate for the SSE stream,
// beyond the coarse public/members audience. Topic-pattern matching decides what
// a client asked for; this decides what they're allowed — so subscribing to a
// chat's topic (or a chat's backing-session topic) isn't enough to read it.
//
// This is the one home for the ship's per-topic visibility rules — a deliberate
// cross-cutting hub, since visibility spans services (an agent session's
// visibility derives from whether an issue or a chat owns it). Each rule asks
// the owning module to parse its own topic grammar (`chatIdFromTopic`,
// `sessionIdFromTopic`) rather than re-deriving it here, and consults the same
// tables the RLS policies do, so the stream gate and table policies agree.
//
// Adding a topic kind = add a TopicRule. A topic no rule claims is visible to
// any crew member (e.g. `issue:*` — the board is public).

/** One topic kind's visibility: parse its id from a topic, then decide. */
interface TopicRule {
  /** The id this topic refers to, or null if this rule doesn't own the topic. */
  idFromTopic: (topic: string) => string | null
  /** May `actorId` see the entity with this id? */
  canSee: (db: Database, actorId: string, id: string) => Promise<boolean>
}

/**
 * A `session:<id>` topic carries an agent session's transcript. Its visibility
 * derives from where the session came from: an issue's builder session is public
 * (the board is public); a chat's backing session follows that chat's
 * membership; a bare/monitor session (a CLI `agent new`) is visible to the crew.
 */
async function canSeeSession(
  db: Database,
  actorId: string,
  sessionId: string,
): Promise<boolean> {
  if (await issueOwnsSession(db, sessionId)) return true
  const chatId = await chatIdForSession(db, sessionId)
  if (chatId !== null) return isMember(db, chatId, actorId)
  return true
}

const TOPIC_RULES: TopicRule[] = [
  {
    idFromTopic: chatIdFromTopic,
    canSee: (db, actor, id) => isMember(db, id, actor),
  },
  { idFromTopic: sessionIdFromTopic, canSee: canSeeSession },
]

/**
 * May `actorId` see events on `topic`? Runs the first rule that claims the
 * topic; a topic no rule owns is public (visible to any crew member).
 */
export async function canSeeTopic(
  db: Database,
  actorId: string,
  topic: string,
  rules: TopicRule[] = TOPIC_RULES,
): Promise<boolean> {
  for (const rule of rules) {
    const id = rule.idFromTopic(topic)
    if (id !== null) return rule.canSee(db, actorId, id)
  }
  return true
}
