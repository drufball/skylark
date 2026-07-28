import { and, asc, eq, isNull } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import { emitEvent } from '@hull/events/bus'
import { MEMBERS_AUDIENCE } from '@hull/events/service'
import { users } from '@hull/users/schema'

import { listMembers } from './messages'
import {
  chatCanvasPages,
  chatViewState,
  chatWidgets,
  type ChatCanvasPageRow,
} from './schema'
import { CHAT_CANVAS_CHANGED, chatTopic } from './topic'
import {
  CANVAS_PLACEMENT,
  clampCanvasBox,
  DEFAULT_CANVAS_BOX,
  freeCanvasBox,
  nextCanvasSlot,
  STACK_PLACEMENT,
  type CanvasBox,
} from './widgets'
import {
  emitWidgetChanged,
  visibleWidget,
  widgetViewColumns,
  type ChatWidgetView,
} from './widgets-store'

// --- The canvas: pages, placement, and per-viewer page state ---------------
//
// The chat's second surface. The **stack** is turn-shaped — ephemeral,
// answer-shaped widgets an agent needs something from you about right now. The
// **canvas** is state-shaped — persistent readouts and controls the crew
// arranged, on named pages, staying where they were put. `placement` says which
// surface a widget is on, and moving between the two is an ordinary update of
// that column (see widgets.ts).
//
// Everything here is chat's own tables under chat's own membership policy
// (migration 0034), so the canvas inherits the conversation's access with no new
// access path. And nothing here RAISES a widget: an actor with judgment does
// that, through a door, and then arranges it.

/** Announce that a chat's canvas pages changed, on the chat's own topic. */
async function emitCanvasChanged(
  db: Database,
  chatId: string,
  actorId: string,
): Promise<void> {
  await emitEvent(db, {
    type: CHAT_CANVAS_CHANGED,
    source: 'chat',
    topic: chatTopic(chatId),
    audience: MEMBERS_AUDIENCE,
    actorId,
    payload: { chatId },
  })
}

/**
 * Add a page to a chat's canvas. It lands at the END of the strip unless the
 * caller says otherwise — a new page appearing in the middle of somebody's
 * tabs would move the ground under them.
 */
export async function createCanvasPage(
  db: Database,
  input: {
    id: string
    chatId: string
    title: string
    pageOrder?: number
    actorId: string
  },
): Promise<ChatCanvasPageRow> {
  const title = input.title.trim()
  if (!title) throw new Error('a canvas page needs a name')
  const existing = await listCanvasPages(db, input.chatId)
  const [row] = await db
    .insert(chatCanvasPages)
    .values({
      id: input.id,
      chatId: input.chatId,
      title,
      pageOrder: input.pageOrder ?? (existing.at(-1)?.pageOrder ?? -1) + 1,
    })
    .returning()
  await emitCanvasChanged(db, input.chatId, input.actorId)
  return row
}

/** A chat's canvas pages, in strip order (then oldest, so the order is total). */
export async function listCanvasPages(
  db: Database,
  chatId: string,
): Promise<ChatCanvasPageRow[]> {
  return db
    .select()
    .from(chatCanvasPages)
    .where(eq(chatCanvasPages.chatId, chatId))
    .orderBy(asc(chatCanvasPages.pageOrder), asc(chatCanvasPages.id))
}

/** One page by id — RLS-filtered, so a non-member sees undefined. */
export async function getCanvasPage(
  db: Database,
  pageId: string,
): Promise<ChatCanvasPageRow | undefined> {
  const [row] = await db
    .select()
    .from(chatCanvasPages)
    .where(eq(chatCanvasPages.id, pageId))
  return row
}

/**
 * The page, or a clean refusal. Under RLS the read IS the access check, exactly
 * like `visibleWidget`: a non-member sees no row, and neither does anyone once
 * the page's chat is deleted.
 */
async function visiblePage(
  db: Database,
  pageId: string,
): Promise<ChatCanvasPageRow> {
  const row = await getCanvasPage(db, pageId)
  if (!row) throw new Error('no such page (or not a member of its chat)')
  return row
}

export async function renameCanvasPage(
  db: Database,
  input: { pageId: string; title: string; actorId: string },
): Promise<void> {
  const page = await visiblePage(db, input.pageId)
  const title = input.title.trim()
  if (!title) throw new Error('a canvas page needs a name')
  await db
    .update(chatCanvasPages)
    .set({ title })
    .where(eq(chatCanvasPages.id, input.pageId))
  await emitCanvasChanged(db, page.chatId, input.actorId)
}

/** Move a page in the strip — low first, like every order column in chat. */
export async function reorderCanvasPage(
  db: Database,
  input: { pageId: string; pageOrder: number; actorId: string },
): Promise<void> {
  const page = await visiblePage(db, input.pageId)
  await db
    .update(chatCanvasPages)
    .set({ pageOrder: input.pageOrder })
    .where(eq(chatCanvasPages.id, input.pageId))
  await emitCanvasChanged(db, page.chatId, input.actorId)
}

/**
 * Remove an EMPTY page. A page holding widgets is refused rather than cascaded
 * away: those tiles are somebody's arrangement, and tidying up the tabs must
 * never be the thing that destroys them. Move them off first — which is one
 * drag, or one `chat_widget` call.
 */
export async function removeCanvasPage(
  db: Database,
  input: { pageId: string; actorId: string },
): Promise<void> {
  const page = await visiblePage(db, input.pageId)
  const held = await db
    .select({ id: chatWidgets.id })
    .from(chatWidgets)
    .where(
      and(
        eq(chatWidgets.pageId, input.pageId),
        isNull(chatWidgets.dismissedAt),
      ),
    )
  if (held.length > 0) {
    throw new Error(
      `“${page.title}” still has widgets on it — move them off first`,
    )
  }
  await db.delete(chatCanvasPages).where(eq(chatCanvasPages.id, input.pageId))
  await emitCanvasChanged(db, page.chatId, input.actorId)
}

/**
 * Every widget arranged on a chat's canvas, across all its pages, in
 * **arrangement order**: top row first, then left to right. That order is not a
 * detail — it IS the single column a phone renders the page as, so the two
 * surfaces can never disagree about what comes first.
 *
 * All pages in one read, so switching tabs is instant and needs no refetch.
 * Dismissed rows are excluded, like the stack's read.
 */
export async function listCanvasWidgets(
  db: Database,
  chatId: string,
): Promise<ChatWidgetView[]> {
  return db
    .select(widgetViewColumns)
    .from(chatWidgets)
    .innerJoin(users, eq(chatWidgets.createdById, users.id))
    .where(
      and(
        eq(chatWidgets.chatId, chatId),
        eq(chatWidgets.placement, CANVAS_PLACEMENT),
        isNull(chatWidgets.dismissedAt),
      ),
    )
    .orderBy(
      asc(chatWidgets.gridY),
      asc(chatWidgets.gridX),
      asc(chatWidgets.id),
    )
}

/**
 * Put a widget on a canvas page, or move/resize one already there — one
 * ordinary row update, whichever it is.
 *
 * A box the caller didn't give is found for them (`nextCanvasSlot`, first free
 * cell) and a box they did give is clamped into the grid rather than refused:
 * agents write these coordinates by hand, and a tile the crew can drag beats a
 * rejected write whose result the writer never sees.
 */
export async function placeWidget(
  db: Database,
  input: {
    widgetId: string
    actorId: string
    pageId: string
  } & Partial<CanvasBox>,
): Promise<void> {
  const widget = await visibleWidget(db, input.widgetId)
  const page = await visiblePage(db, input.pageId)
  if (page.chatId !== widget.chatId) {
    throw new Error('that page is not in this widget’s chat')
  }
  // Everything else already on this page — what the new box has to fit around.
  // The widget itself is excluded: a resize must not collide with where it is.
  const taken = (await listCanvasWidgets(db, widget.chatId)).filter(
    (w) => w.pageId === input.pageId && w.id !== input.widgetId,
  )
  const size = clampCanvasBox({ gridW: input.gridW, gridH: input.gridH })
  const corner =
    input.gridX === undefined && input.gridY === undefined
      ? nextCanvasSlot(taken, size)
      : {
          gridX: input.gridX ?? widget.gridX,
          gridY: input.gridY ?? widget.gridY,
        }
  const box = freeCanvasBox(taken, clampCanvasBox({ ...size, ...corner }))
  await db
    .update(chatWidgets)
    .set({ placement: CANVAS_PLACEMENT, pageId: input.pageId, ...box })
    .where(eq(chatWidgets.id, input.widgetId))
  await emitWidgetChanged(db, widget, 'placed', input.actorId)
}

/**
 * Move a widget back to the stack, off whatever page it was on. The same
 * ordinary update as `placeWidget` in the other direction — and the move an
 * agent makes when a readout you arranged has become something it needs you to
 * look at right now.
 */
export async function stackWidget(
  db: Database,
  input: { widgetId: string; actorId: string; stackOrder?: number },
): Promise<void> {
  const widget = await visibleWidget(db, input.widgetId)
  await db
    .update(chatWidgets)
    .set({
      placement: STACK_PLACEMENT,
      pageId: null,
      stackOrder: input.stackOrder ?? widget.stackOrder,
      ...DEFAULT_CANVAS_BOX,
    })
    .where(eq(chatWidgets.id, input.widgetId))
  await emitWidgetChanged(db, widget, 'placed', input.actorId)
}

/**
 * Which canvas page this ONE person has open in this chat, or null if they
 * haven't opened one. Per viewer, never per chat: three members can be on three
 * different pages, so "what page is open" is a property of the person.
 */
export async function getViewPage(
  db: Database,
  chatId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ pageId: chatViewState.pageId })
    .from(chatViewState)
    .where(
      and(eq(chatViewState.chatId, chatId), eq(chatViewState.userId, userId)),
    )
  // `row` is undefined when there's no row at all — drizzle's select type says
  // otherwise, so the read is spelled out rather than optional-chained.
  return (row as { pageId: string | null } | undefined)?.pageId ?? null
}

/**
 * Remember the page this person is looking at, so a reload puts them back.
 *
 * Emits NOTHING. Your attention is not news for the rest of the crew, and an
 * event would make it so — every other member's browser would refetch because
 * you swiped a tab. The one reader outside your own browser is the orchestrator,
 * which looks the row up when it briefs an agent about the person it's answering.
 */
export async function setViewPage(
  db: Database,
  input: { chatId: string; userId: string; pageId: string | null },
): Promise<void> {
  await db
    .insert(chatViewState)
    .values({
      chatId: input.chatId,
      userId: input.userId,
      pageId: input.pageId,
    })
    .onConflictDoUpdate({
      target: [chatViewState.chatId, chatViewState.userId],
      set: { pageId: input.pageId, updatedAt: new Date() },
    })
}

/** A human member and the canvas page in front of them right now. */
export interface ChatViewerView {
  handle: string
  /** The page's NAME (an id would mean nothing to an agent), or null for the thread. */
  pageTitle: string | null
}

/**
 * What each human in the chat is looking at — the line the orchestrator puts in
 * a turn's context so an agent asked "what's this?" knows what's in front of
 * that person.
 *
 * Humans only: an agent has no eyes, and listing it would be noise. Read on the
 * orchestrator's superuser connection, which is a different thing from members
 * watching each other — RLS keeps a member's own reads to their own row.
 */
export async function listChatViewers(
  db: Database,
  chatId: string,
): Promise<ChatViewerView[]> {
  const members = await listMembers(db, chatId)
  const rows = await db
    .select({ userId: chatViewState.userId, title: chatCanvasPages.title })
    .from(chatViewState)
    .innerJoin(chatCanvasPages, eq(chatViewState.pageId, chatCanvasPages.id))
    .where(eq(chatViewState.chatId, chatId))
  return members
    .filter((m) => m.type === 'human')
    .map((m) => ({
      handle: m.handle,
      pageTitle: rows.find((r) => r.userId === m.userId)?.title ?? null,
    }))
}
