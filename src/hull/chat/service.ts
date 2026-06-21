import { and, asc, desc, eq, inArray } from 'drizzle-orm'

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

/**
 * Pure logic + persistence for the chat service. Database-agnostic like every
 * service; touches only its own three tables (plus a read-join onto users for
 * display). The orchestrator (orchestrator.ts) is the impure shell that drives
 * agent replies; the web doors live in server.ts.
 *
 * Membership is visibility: a chat is seen only by its members, so chat events
 * are scoped to `chat:<id>` — never `public` — and the doors check membership
 * before returning a transcript.
 */

/** The prefix every chat topic carries — the one home for the chat: grammar. */
const CHAT_TOPIC_PREFIX = 'chat:'

/**
 * The ship-log **topic** a chat's events ride on; members subscribe to it.
 * Named `*Scope` for historical reasons — the event `scope` field is retired;
 * this returns a topic string.
 */
export function chatScope(chatId: string): string {
  return `${CHAT_TOPIC_PREFIX}${chatId}`
}

/**
 * The chat id a topic refers to, or null if it isn't a chat topic — the inverse
 * of `chatScope`. So entitlement code asks chat "is this yours, and whose?"
 * rather than re-deriving the `chat:` format and drifting from it.
 */
export function chatIdFromTopic(topic: string): string | null {
  return topic.startsWith(CHAT_TOPIC_PREFIX)
    ? topic.slice(CHAT_TOPIC_PREFIX.length)
    : null
}

/** The event a posted message announces (one name for emitter + subscriber). */
export const CHAT_MESSAGE_POSTED = 'chat.message_posted'

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
    const [chat] = await tx
      .insert(chats)
      .values({ id: input.id, title: input.title ?? null })
      .returning()
    const members = [...new Set(input.memberIds)]
    if (members.length > 0) {
      await tx
        .insert(chatMembers)
        .values(members.map((userId) => ({ chatId: chat.id, userId })))
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

/** A member joined with the user it points at — what the views and rules need. */
export interface ChatMemberView {
  userId: string
  handle: string
  displayName: string
  type: UserRow['type']
  profileId: string | null
  sessionId: string | null
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
      profileId: users.profileId,
      sessionId: chatMembers.sessionId,
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
export async function addMessage(
  db: Database,
  input: { id: string; chatId: string; authorId: string; body: string },
): Promise<ChatMessageRow> {
  const row = await db.transaction(async (tx) => {
    const [message] = await tx.insert(chatMessages).values(input).returning()
    await tx
      .update(chats)
      .set({ lastMessageAt: new Date() })
      .where(eq(chats.id, input.chatId))
    return message
  })
  await emitEvent(db, {
    type: CHAT_MESSAGE_POSTED,
    source: 'chat',
    topic: chatScope(input.chatId),
    audience: MEMBERS_AUDIENCE,
    actorId: input.authorId,
    payload: {
      chatId: input.chatId,
      messageId: row.id,
      authorId: row.authorId,
    },
  })
  return row
}

/** Messages posted after the agent's last message here (all of them if none). */
export async function messagesSinceAgent(
  db: Database,
  chatId: string,
  agentUserId: string,
): Promise<ChatMessageView[]> {
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

  const all = await listMessages(db, chatId)
  if (lastRows.length === 0) return all
  const lastId = lastRows[0].id
  return all.filter((m) => m.id > lastId)
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
