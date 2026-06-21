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
// cross-cutting hub, since a session's visibility spans services (it derives from
// whether an issue or a chat owns it). It depends downward on service contracts
// and asks each module to parse its own topic grammar (`chatIdFromTopic`,
// `sessionIdFromTopic`) rather than re-deriving it here. The edges run one way:
// service *logic* never imports this hub; only the serving edge does — the SSE
// route and the web doors (`createServerFn` handlers), which are where "who is
// acting?" is known. So `agent/server.ts` calling `canSeeSession` is a door
// reaching down to the hub, not a service depending sideways on it.
//
// For chat, this mirrors the RLS policies (migration 0007) on the same
// `chat_members` table — stream gate and table policies agree. Sessions have no
// RLS policy yet, so for `session:` topics this gate is the SOLE enforcement of
// the issue→public / chat→members / bare→crew rule; a session-events table
// policy is still owed (see the agent-session door hardening).

/**
 * A `session:<id>` topic carries an agent session's transcript. Its visibility
 * derives from where the session came from: an issue's builder session is public
 * (the board is public); a chat's backing session follows that chat's
 * membership; a bare/monitor session (a CLI `agent new`) is visible to the crew.
 *
 * The public session-visibility primitive: the agent doors hold a sessionId, so
 * they call this directly; `canSeeTopic` routes `session:` topics here too, so
 * the doors and the SSE stream funnel session visibility through one function.
 */
export async function canSeeSession(
  db: Database,
  actorId: string,
  sessionId: string,
): Promise<boolean> {
  if (await issueOwnsSession(db, sessionId)) return true
  const chatId = await chatIdForSession(db, sessionId)
  if (chatId !== null) return isMember(db, chatId, actorId)
  return true
}

/**
 * May `actorId` see events on `topic`? Each topic kind is a guard clause; a
 * topic no kind owns (e.g. `issue:*`) is public — visible to any crew member.
 */
export async function canSeeTopic(
  db: Database,
  actorId: string,
  topic: string,
): Promise<boolean> {
  const chatId = chatIdFromTopic(topic)
  if (chatId !== null) return isMember(db, chatId, actorId)

  const sessionId = sessionIdFromTopic(topic)
  if (sessionId !== null) return canSeeSession(db, actorId, sessionId)

  return true
}
