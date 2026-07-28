import { uuidv7 } from '@earendil-works/pi-agent-core'
import { and, asc, eq, lte, or } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import { errorMessage } from '@hull/lib/errors'
import { users, type UserRow } from '@hull/users/schema'

import { emitMessagePosted, writeMessage } from './messages'
import { chatSchedules, type ChatScheduleRow } from './schema'

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
