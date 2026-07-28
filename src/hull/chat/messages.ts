import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import { emitEvent } from '@hull/events/bus'
import { MEMBERS_AUDIENCE } from '@hull/events/service'
import { users, type UserRow } from '@hull/users/schema'

import {
  chatMembers,
  chatMessages,
  chats,
  type ChatRow,
  type ChatMessageRow,
} from './schema'
import { CHAT_MESSAGE_POSTED, chatTopic } from './topic'

/**
 * Pure logic + persistence for the chat service. Database-agnostic like every
 * service; touches only its own tables (plus a read-join onto users for
 * display). The orchestrator (orchestrator.ts) is the impure shell that drives
 * agent replies; the web doors live in server.ts. What a widget's props MEAN is
 * the rigging catalog's business (`@rigging/widgets`); `widgets.ts` keeps only
 * what's true of the ROW — the answer convention and the answer's message body.
 *
 * Membership is visibility: a chat is seen only by its members, so chat events
 * are scoped to `chat:<id>` — never `public` — and the doors check membership
 * before returning a transcript.
 *
 * This module holds the message-response rules and chat/member/message
 * persistence; schedules, the widget store, and the canvas live in their own
 * modules next door, re-exported together by `service.ts`.
 */

// --- Pure decision logic (unit-tested directly) ----------------------------

/** Extract the @handles mentioned in a message body, lowercased, deduped. */
export function parseMentions(body: string): string[] {
  const matches = body.match(/@(\w+)/g) ?? []
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))]
}

/** A member as the response rule sees it. */
export interface MemberView {
  userId: string
  handle: string
  type: UserRow['type']
}

/**
 * Which agent members should respond to a freshly-posted message? The rules:
 * - Only a **human's** message triggers a response (agents never trigger agents,
 *   so a reply can't cascade into a loop).
 * - In a **1:1** (exactly one human + one agent), the agent always responds.
 * - In a **group**, only the agents whose handle is @mentioned respond.
 * Pure: the caller supplies the members and the message; this picks the targets.
 */
export function targetsForMessage(input: {
  members: MemberView[]
  authorId: string
  body: string
}): string[] {
  const { members, authorId, body } = input
  const author = members.find((m) => m.userId === authorId)
  if (author?.type !== 'human') return []

  const agents = members.filter((m) => m.type === 'agent')
  const humans = members.filter((m) => m.type === 'human')
  if (humans.length === 1 && agents.length === 1) {
    return [agents[0].userId]
  }

  const mentioned = parseMentions(body)
  return agents
    .filter((a) => mentioned.includes(a.handle.toLowerCase()))
    .map((a) => a.userId)
}

/**
 * The later of two message ids, with null meaning "nothing yet". Message ids are
 * UUIDv7, so lexicographic order IS chronological order — the same fact
 * `listMessages`'s `order by id` already rides on.
 *
 * This is how an agent member's seen-watermark is resolved: the MAX of the
 * `lastSeenMessageId` the orchestrator advances and the last message the agent
 * itself authored. Two halves, deliberately, so a crash between the two writes
 * is safe in either order — see `messagesSinceAgent`.
 */
export function laterMessageId(
  a: string | null,
  b: string | null,
): string | null {
  if (a === null) return b
  if (b === null) return a
  return a > b ? a : b
}

/** Render chat messages into a transcript prompt for an agent's session. */
export function formatTranscript(
  messages: { handle: string; body: string }[],
): string {
  return messages.map((m) => `@${m.handle}: ${m.body}`).join('\n')
}

// --- Persistence -----------------------------------------------------------

export async function createChat(
  db: Database,
  input: { id: string; title?: string | null; memberIds: string[] },
): Promise<ChatRow> {
  return db.transaction(async (tx) => {
    // No RETURNING on the chat insert: under RLS, returning a row needs SELECT
    // visibility (membership), and the membership rows land on the next
    // statement. Insert blind, add the members, THEN read the row back —
    // inside one transaction, so a member-creator sees their own chat.
    await tx.insert(chats).values({ id: input.id, title: input.title ?? null })
    const members = [...new Set(input.memberIds)]
    if (members.length > 0) {
      await tx
        .insert(chatMembers)
        .values(members.map((userId) => ({ chatId: input.id, userId })))
    }
    const chat = (
      await tx.select().from(chats).where(eq(chats.id, input.id))
    ).at(0)
    if (!chat) {
      // Creating a chat you are not in: RLS hides the row you just made.
      throw new Error('createChat: the creator must be one of memberIds')
    }
    return chat
  })
}

export async function getChat(
  db: Database,
  chatId: string,
): Promise<ChatRow | undefined> {
  const [row] = await db.select().from(chats).where(eq(chats.id, chatId))
  return row
}

/**
 * Throw a clean refusal if the actor can't see this chat. Run under `withActor`,
 * `getChat` returns undefined when RLS hides the row (non-member) — which the
 * mutating doors surface as a friendly "not a member" rather than letting the
 * WITH CHECK policy reject the write with a raw error (or leaking existence).
 */
export async function ensureChatVisible(
  db: Database,
  chatId: string,
): Promise<void> {
  if (!(await getChat(db, chatId))) throw new Error('not a member of this chat')
}

/** A member joined with the user it points at — what the views and rules need. */
export interface ChatMemberView {
  userId: string
  handle: string
  displayName: string
  type: UserRow['type']
  sessionId: string | null
  /** The agent's latest live progress line, persisted so it survives navigation. */
  progressLine: string | null
  /** How far this member's turns have read the chat (see `messagesSinceAgent`). */
  lastSeenMessageId: string | null
}

export async function listMembers(
  db: Database,
  chatId: string,
): Promise<ChatMemberView[]> {
  return db
    .select({
      userId: users.id,
      handle: users.handle,
      displayName: users.displayName,
      type: users.type,
      sessionId: chatMembers.sessionId,
      progressLine: chatMembers.progressLine,
      lastSeenMessageId: chatMembers.lastSeenMessageId,
    })
    .from(chatMembers)
    .innerJoin(users, eq(chatMembers.userId, users.id))
    .where(eq(chatMembers.chatId, chatId))
    .orderBy(asc(chatMembers.createdAt))
}

/** Every chat, newest activity first — what the orchestrator's reconcile scans. */
export async function listAllChats(db: Database): Promise<ChatRow[]> {
  return db.select().from(chats).orderBy(desc(chats.lastMessageAt))
}

/** Chats the user is a member of, newest activity first — the sidebar. */
export async function listChatsForUser(
  db: Database,
  userId: string,
): Promise<ChatRow[]> {
  const memberships = db
    .select({ chatId: chatMembers.chatId })
    .from(chatMembers)
    .where(eq(chatMembers.userId, userId))
  return db
    .select()
    .from(chats)
    .where(inArray(chats.id, memberships))
    .orderBy(desc(chats.lastMessageAt))
}

/** A chat as the sidebar shows it: title (or its members) + recency. */
export interface ChatSummary {
  id: string
  title: string | null
  lastMessageAt: Date
  memberHandles: string[]
}

/** The actor's chats, newest first, each with its member handles for display. */
export async function listChatSummaries(
  db: Database,
  userId: string,
): Promise<ChatSummary[]> {
  const rows = await listChatsForUser(db, userId)
  const summaries: ChatSummary[] = []
  for (const chat of rows) {
    const members = await listMembers(db, chat.id)
    summaries.push({
      id: chat.id,
      title: chat.title,
      lastMessageAt: chat.lastMessageAt,
      memberHandles: members.map((m) => m.handle),
    })
  }
  return summaries
}

/** A message joined with its author's handle — view-ready. */
export interface ChatMessageView {
  id: string
  authorId: string
  authorHandle: string
  body: string
}

export async function listMessages(
  db: Database,
  chatId: string,
): Promise<ChatMessageView[]> {
  return db
    .select({
      id: chatMessages.id,
      authorId: chatMessages.authorId,
      authorHandle: users.handle,
      body: chatMessages.body,
    })
    .from(chatMessages)
    .innerJoin(users, eq(chatMessages.authorId, users.id))
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(asc(chatMessages.id))
}

/** One message by id — the bus handler reads the body a posted-message note refers to. */
export async function getMessage(
  db: Database,
  messageId: string,
): Promise<ChatMessageRow | undefined> {
  const [row] = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId))
  return row
}

/**
 * Append a message, bump the chat's activity clock, and announce it on the
 * ship's log with topic (chat:<id>) and audience (members). Membership is
 * visibility: only crew members can see chat events.
 */
/**
 * Insert a message row and bump the chat's activity clock — the durable half of
 * a post, meant to run INSIDE a caller's transaction. Split out so a caller that
 * must commit the message atomically with something else (the schedule fire path
 * advances/disables its row in the same transaction) can, while `addMessage`
 * keeps the simple "one post" contract. Does not emit — see `emitMessagePosted`.
 */
export async function writeMessage(
  tx: Database,
  input: { id: string; chatId: string; authorId: string; body: string },
): Promise<ChatMessageRow> {
  const [message] = await tx.insert(chatMessages).values(input).returning()
  await tx
    .update(chats)
    .set({ lastMessageAt: new Date() })
    .where(eq(chats.id, input.chatId))
  return message
}

/**
 * Announce a written message on the ship's log (topic chat:<id>, audience
 * members) — run AFTER the write commits. Durable-first, emit-second, like the
 * files service: a dropped emit only delays the live reply (startup reconcile
 * re-drives it), whereas an emit inside the write's transaction could announce a
 * message a rollback then erased.
 */
export async function emitMessagePosted(
  db: Database,
  row: ChatMessageRow,
): Promise<void> {
  await emitEvent(db, {
    type: CHAT_MESSAGE_POSTED,
    source: 'chat',
    topic: chatTopic(row.chatId),
    audience: MEMBERS_AUDIENCE,
    actorId: row.authorId,
    payload: {
      chatId: row.chatId,
      messageId: row.id,
      authorId: row.authorId,
    },
  })
}

export async function addMessage(
  db: Database,
  input: { id: string; chatId: string; authorId: string; body: string },
): Promise<ChatMessageRow> {
  const row = await db.transaction((tx) => writeMessage(tx, input))
  await emitMessagePosted(db, row)
  return row
}

/**
 * Messages this member's turns haven't read yet (all of them if none) — what a
 * reply turn is fed.
 *
 * The watermark is the LATER of two things, and both halves are load-bearing:
 *
 * - **`lastSeenMessageId`**, advanced by the orchestrator when a reply turn
 *   ends. Since an agent speaks by calling `chat_post` itself, a turn may end
 *   with nothing said; without this half, a silent turn leaves no mark and the
 *   same messages are re-fed on every later reply, forever.
 * - **the last message the agent AUTHORED.** Without this half, a crash between
 *   an agent's post committing and the watermark write would re-drive a turn
 *   that already spoke — a duplicate message in the crew's face.
 *
 * Taking the max means neither crash ordering hurts: lose the watermark write
 * and the post still covers it; end silently and the watermark still covers it.
 * That is what keeps `reconcile`/`resumeChat` idempotent.
 */
export async function messagesSinceAgent(
  db: Database,
  chatId: string,
  agentUserId: string,
): Promise<ChatMessageView[]> {
  const memberRows = await db
    .select({ lastSeenMessageId: chatMembers.lastSeenMessageId })
    .from(chatMembers)
    .where(
      and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, agentUserId)),
    )
  const lastRows = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatId, chatId),
        eq(chatMessages.authorId, agentUserId),
      ),
    )
    .orderBy(desc(chatMessages.id))
    .limit(1)

  const watermark = laterMessageId(
    memberRows.at(0)?.lastSeenMessageId ?? null,
    lastRows.at(0)?.id ?? null,
  )
  const all = await listMessages(db, chatId)
  if (watermark === null) return all
  return all.filter((m) => m.id > watermark)
}

export async function addMember(
  db: Database,
  chatId: string,
  userId: string,
): Promise<void> {
  await db.insert(chatMembers).values({ chatId, userId }).onConflictDoNothing()
}

export async function removeMember(
  db: Database,
  chatId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
}

export async function setTitle(
  db: Database,
  chatId: string,
  title: string | null,
): Promise<void> {
  await db.update(chats).set({ title }).where(eq(chats.id, chatId))
}

/** Record the backing agent session for an agent member of a chat. */
export async function setMemberSession(
  db: Database,
  chatId: string,
  userId: string,
  sessionId: string,
): Promise<void> {
  await db
    .update(chatMembers)
    .set({ sessionId })
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
}

/**
 * Advance an agent member's seen watermark to `messageId` — the durable mark
 * that this member's turn READ the chat up to there, whether or not it chose to
 * say anything. Called by the orchestrator at turn end.
 *
 * **Monotonic**: a stale advance is ignored (`last_seen_message_id < messageId`
 * in the where). Two turns can finish out of order — a queued call returns as
 * soon as its prompt is folded into the turn already in flight, which then
 * finishes later with an EARLIER read tail — and a watermark that walked
 * backwards would re-feed messages the agent has already answered.
 */
export async function setMemberSeen(
  db: Database,
  chatId: string,
  userId: string,
  messageId: string,
): Promise<void> {
  await db
    .update(chatMembers)
    .set({ lastSeenMessageId: messageId })
    .where(
      and(
        eq(chatMembers.chatId, chatId),
        eq(chatMembers.userId, userId),
        or(
          isNull(chatMembers.lastSeenMessageId),
          lt(chatMembers.lastSeenMessageId, messageId),
        ),
      ),
    )
}

/**
 * Which chat a backing agent session speaks for, and under whose handle — how
 * the agent-facing chat tools (session-tools.ts) find their chat from nothing
 * but the session they were registered on.
 *
 * Matched on BOTH the session id and the agent id, so a session id can never be
 * used to speak as a different member. Run under the agent's own actor: RLS then
 * makes membership the outer gate too. Undefined for a session that backs no
 * chat membership at all (an inbox session, a builder's) — the tools simply
 * don't exist there.
 */
export async function findChatForSession(
  db: Database,
  input: { sessionId: string; agentUserId: string },
): Promise<{ chatId: string; handle: string } | undefined> {
  const [row] = await db
    .select({ chatId: chatMembers.chatId, handle: users.handle })
    .from(chatMembers)
    .innerJoin(users, eq(chatMembers.userId, users.id))
    .where(
      and(
        eq(chatMembers.sessionId, input.sessionId),
        eq(chatMembers.userId, input.agentUserId),
      ),
    )
  return row
}

/**
 * Write (or clear, with null) an agent member's latest live progress line —
 * the durable half of the "working…" bubble. Persisted so navigating away from
 * a chat and back still shows the agent's last status, not just silence;
 * `driveTurn` clears it back to null once the turn ends.
 */
export async function setMemberProgress(
  db: Database,
  chatId: string,
  userId: string,
  progressLine: string | null,
): Promise<void> {
  await db
    .update(chatMembers)
    .set({ progressLine })
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
}
