import { uuidv7 } from '@earendil-works/pi-agent-core'
import { and, asc, desc, eq, inArray, lte, or } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import { emitEvent } from '@hull/events/bus'
import { MEMBERS_AUDIENCE } from '@hull/events/service'
import { errorMessage } from '@hull/lib/errors'
import { users, type UserRow } from '@hull/users/schema'

import {
  chatMembers,
  chatMessages,
  chatSchedules,
  chats,
  type ChatRow,
  type ChatMessageRow,
  type ChatScheduleRow,
} from './schema'
import { CHAT_MESSAGE_POSTED, chatTopic } from './topic'

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
async function writeMessage(
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
async function emitMessagePosted(
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

// --- Schedules: pure decision logic (unit-tested directly) -----------------

/**
 * The interval floor: a recurring schedule may fire no more than once every
 * five minutes. Cheap insurance against a mistyped `--every 1` turning a chat
 * into a firehose; v1 keeps recurrence to a plain minute interval, no cron.
 */
export const MIN_INTERVAL_MINUTES = 5

/** A member as the author rule sees it. */
export interface ScheduleMemberView {
  userId: string
  type: UserRow['type']
}

/**
 * May `actorId` create a schedule that posts AS `authorId` in this chat? A
 * schedule posts in its author's name, so the rule guards whose mouth you may
 * put words in: your own always, or an **agent** member of the chat — but
 * NEVER another human. (`authorId` must be a member; an agent that isn't in
 * the chat can't be spoken for either.) Pure: the caller supplies the roster.
 */
export function canAuthorSchedule(input: {
  actorId: string
  authorId: string
  members: ScheduleMemberView[]
}): boolean {
  const { actorId, authorId, members } = input
  if (authorId === actorId) return true
  return members.find((m) => m.userId === authorId)?.type === 'agent'
}

/** The timing fields a created schedule carries — exactly one shape is set. */
export interface ScheduleTiming {
  fireAt: Date | null
  intervalMinutes: number | null
  nextFireAt: Date | null
}

/**
 * Resolve and validate a new schedule's timing from the create input: exactly
 * one of a one-shot `fireAt` or a recurrence `intervalMinutes` (whole minutes,
 * at or above the floor). A recurring schedule's first fire is one interval out
 * from `now`. Throws a clean refusal at the door for a bad shape — pure, so the
 * rule is tested without a database.
 */
export function scheduleTiming(input: {
  now: Date
  fireAt?: Date | null
  intervalMinutes?: number | null
}): ScheduleTiming {
  const hasFireAt = input.fireAt != null
  const hasInterval = input.intervalMinutes != null
  if (hasFireAt === hasInterval) {
    throw new Error(
      'a schedule needs exactly one of a fire time or a repeat interval',
    )
  }
  if (input.intervalMinutes != null) {
    const minutes = input.intervalMinutes
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES) {
      throw new Error(
        `a repeat interval must be a whole number of minutes, at least ${String(MIN_INTERVAL_MINUTES)}`,
      )
    }
    return {
      fireAt: null,
      intervalMinutes: minutes,
      nextFireAt: new Date(input.now.getTime() + minutes * 60_000),
    }
  }
  return {
    // input.fireAt is non-null here (exactly one shape is set).
    fireAt: input.fireAt ?? null,
    intervalMinutes: null,
    nextFireAt: null,
  }
}

/** When a schedule is next due to fire: its `fireAt` (one-shot) or `nextFireAt`. */
export function scheduleDueTime(schedule: {
  fireAt: Date | null
  nextFireAt: Date | null
}): Date | null {
  return schedule.fireAt ?? schedule.nextFireAt
}

/** Should this schedule fire at `now`? Enabled, and its due time has arrived. */
export function isScheduleDue(
  schedule: { enabled: boolean; fireAt: Date | null; nextFireAt: Date | null },
  now: Date,
): boolean {
  if (!schedule.enabled) return false
  const due = scheduleDueTime(schedule)
  return due != null && due.getTime() <= now.getTime()
}

/**
 * The next fire time for a recurring schedule after it fires at `now`: the
 * smallest `nextFireAt + k·interval` (k ≥ 1) strictly after `now`. Stepping in
 * whole intervals keeps the cadence aligned to the original schedule; jumping
 * past every missed slot is what stops a reboot from backfilling a spam of
 * catch-up fires — the row fires once, then resumes on the grid.
 */
export function advanceNextFire(
  nextFireAt: Date,
  intervalMinutes: number,
  now: Date,
): Date {
  const intervalMs = intervalMinutes * 60_000
  const elapsed = now.getTime() - nextFireAt.getTime()
  const steps = Math.max(1, Math.floor(elapsed / intervalMs) + 1)
  return new Date(nextFireAt.getTime() + steps * intervalMs)
}

// --- Schedules: persistence ------------------------------------------------

/** A schedule joined with its author's handle — view/CLI ready. */
export interface ChatScheduleView extends ChatScheduleRow {
  authorHandle: string
}

export async function createSchedule(
  db: Database,
  input: {
    id: string
    chatId: string
    authorId: string
    body: string
    createdById: string
  } & ScheduleTiming,
): Promise<ChatScheduleRow> {
  const [row] = await db.insert(chatSchedules).values(input).returning()
  return row
}

/** Every schedule on a chat, oldest first (created order), with author handles. */
export async function listSchedules(
  db: Database,
  chatId: string,
): Promise<ChatScheduleView[]> {
  return db
    .select({
      id: chatSchedules.id,
      chatId: chatSchedules.chatId,
      authorId: chatSchedules.authorId,
      body: chatSchedules.body,
      fireAt: chatSchedules.fireAt,
      intervalMinutes: chatSchedules.intervalMinutes,
      nextFireAt: chatSchedules.nextFireAt,
      enabled: chatSchedules.enabled,
      createdAt: chatSchedules.createdAt,
      createdById: chatSchedules.createdById,
      authorHandle: users.handle,
    })
    .from(chatSchedules)
    .innerJoin(users, eq(chatSchedules.authorId, users.id))
    .where(eq(chatSchedules.chatId, chatId))
    .orderBy(asc(chatSchedules.id))
}

/** One schedule by id — RLS-filtered, so a non-member sees undefined. */
export async function getSchedule(
  db: Database,
  id: string,
): Promise<ChatScheduleRow | undefined> {
  const [row] = await db
    .select()
    .from(chatSchedules)
    .where(eq(chatSchedules.id, id))
  return row
}

/**
 * Every enabled schedule due to fire at `now`, across all chats — what the
 * firing sweep drains. A one-shot is due when `fireAt` has passed; a recurring
 * one when `nextFireAt` has. Runs on the superuser connection in the live sweep
 * (RLS bypassed), the same posture as the chat orchestrator.
 */
export async function listDueSchedules(
  db: Database,
  now: Date,
): Promise<ChatScheduleRow[]> {
  return db
    .select()
    .from(chatSchedules)
    .where(
      and(
        eq(chatSchedules.enabled, true),
        or(lte(chatSchedules.fireAt, now), lte(chatSchedules.nextFireAt, now)),
      ),
    )
    .orderBy(asc(chatSchedules.id))
}

export async function setScheduleEnabled(
  db: Database,
  id: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(chatSchedules)
    .set({ enabled })
    .where(eq(chatSchedules.id, id))
}

export async function deleteSchedule(db: Database, id: string): Promise<void> {
  await db.delete(chatSchedules).where(eq(chatSchedules.id, id))
}

/**
 * Fire every schedule due at `now`, in one sweep. For each due row, in ONE
 * transaction: post the body (chat's own message write AS the schedule's
 * author — nothing else) AND advance the schedule — a recurring row to its next
 * future slot, a one-shot to disabled (consumed, not deleted, so it stays a
 * visible record). Posting and advancing commit together, so a crash between
 * them can't refire the same row (no double post); the `chat.message_posted`
 * event is emitted only after the commit, so the reply rules then do the rest
 * (a human-authored fire draws agent replies, an agent-authored one draws none).
 * A recurring row fires once even if the ship was down across many missed slots
 * — advanceNextFire skips them, never backfilling. Each row is isolated: one
 * bad fire is logged and the sweep carries on. Runs on `systemDb` in the live
 * sweep. Returns how many fired.
 */
export async function fireDueSchedules(
  db: Database,
  now: Date,
): Promise<number> {
  // The SQL predicate and the pure rule must agree; filtering by isScheduleDue
  // documents that invariant and guards the fire path if the query ever drifts.
  const due = (await listDueSchedules(db, now)).filter((s) =>
    isScheduleDue(s, now),
  )
  let fired = 0
  for (const schedule of due) {
    try {
      const row = await db.transaction(async (tx) => {
        const message = await writeMessage(tx, {
          id: uuidv7(),
          chatId: schedule.chatId,
          authorId: schedule.authorId,
          body: schedule.body,
        })
        if (schedule.intervalMinutes != null && schedule.nextFireAt != null) {
          await tx
            .update(chatSchedules)
            .set({
              nextFireAt: advanceNextFire(
                schedule.nextFireAt,
                schedule.intervalMinutes,
                now,
              ),
            })
            .where(eq(chatSchedules.id, schedule.id))
        } else {
          await tx
            .update(chatSchedules)
            .set({ enabled: false })
            .where(eq(chatSchedules.id, schedule.id))
        }
        return message
      })
      await emitMessagePosted(db, row)
      fired++
    } catch (err) {
      /* v8 ignore next 4 -- defensive: one bad row must never starve the sweep;
         the happy path is covered, a forced-throw test would need a fake db */
      console.error(
        `chat schedule ${schedule.id} fire failed (continuing): ${errorMessage(err)}`,
      )
    }
  }
  return fired
}
