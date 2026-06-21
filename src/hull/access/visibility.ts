import type { Database } from '@hull/db/client'
import { isMember } from '@hull/chat/service'

// Who may see a ship's-log topic? The entitlement gate for the SSE stream,
// beyond the coarse public/members audience. Topic-pattern matching decides what
// a client asked for; this decides what they're allowed — so subscribing to a
// chat's topic isn't enough to read it, you have to be a member.
//
// Single-crew by design (everyone in `users` is the crew), so the only intra-
// crew question is membership. It consults `chat_members` directly — the same
// source of truth the RLS policies (migration 0007) join against — so the
// stream gate and the table policies can't disagree.

const CHAT_TOPIC_PREFIX = 'chat:'

/**
 * May `actorId` see events on `topic`?
 *  - `chat:<id>` → only the chat's members (closes the cross-member read leak).
 *  - everything else (`issue:*` public, `session:*` until the agent service is
 *    scoped) → yes for now.
 */
export async function canSeeTopic(
  db: Database,
  actorId: string,
  topic: string,
): Promise<boolean> {
  if (topic.startsWith(CHAT_TOPIC_PREFIX)) {
    return isMember(db, topic.slice(CHAT_TOPIC_PREFIX.length), actorId)
  }
  return true
}
