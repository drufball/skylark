import { uuidv7 } from '@earendil-works/pi-agent-core'
import { asc, eq } from 'drizzle-orm'

import {
  listChatSummaries,
  listOpenWidgetsForChats,
  listWidgetsByIds,
  type ChatWidgetView,
} from '@hull/chat/service'
import { chatTopic } from '@hull/chat/topic'
import {
  clampCanvasBox,
  freeCanvasBox,
  nextCanvasSlot,
  type CanvasBox,
  type JsonValue,
} from '@hull/chat/widgets'
import type { Database } from '@hull/db/client'

import {
  homeCanvasPages,
  homeCanvasTiles,
  type HomeCanvasPageRow,
  type HomeCanvasTileRow,
} from './schema'

/**
 * The home canvas service: pages of **pointers**, and the read that resolves
 * them.
 *
 * Two rules shape everything in here.
 *
 * **1. Home holds pointers; chats hold widgets.** Nothing in this file writes a
 * widget, raises one, or moves one between chat surfaces. A tile is a
 * placement — the iOS model, where a home screen holds live views onto apps
 * that live somewhere else. Indirection exists in exactly this one place, so
 * every other surface can keep containing its widgets directly.
 *
 * **2. A pointer is not a grant.** The resolve below asks the CHAT service, on
 * the caller's own connection, so chat's RLS policies decide what comes back —
 * from the viewer's membership right now, never from what was true when they
 * pinned it. That's also why this service reads nothing of chat's tables
 * itself: "may this person see it?" has one home, and it isn't here.
 *
 * The grid arithmetic is chat's `widgets.ts` (`clampCanvasBox`, `freeCanvasBox`)
 * — the same pure module the chat canvas and the browser share, so the two
 * canvases can't drift into two layout engines.
 */

// --- Pages -----------------------------------------------------------------

/**
 * Add a page to somebody's home canvas. It lands at the END of the strip, so a
 * new page never appears in the middle of the tabs you already know.
 */
export async function createHomePage(
  db: Database,
  input: { id: string; ownerId: string; title: string; pageOrder?: number },
): Promise<HomeCanvasPageRow> {
  const title = input.title.trim()
  if (!title) throw new Error('a home page needs a name')
  const existing = await listHomePages(db, input.ownerId)
  const [row] = await db
    .insert(homeCanvasPages)
    .values({
      id: input.id,
      ownerId: input.ownerId,
      title,
      pageOrder: input.pageOrder ?? (existing.at(-1)?.pageOrder ?? -1) + 1,
    })
    .returning()
  return row
}

/** One person's home pages, in strip order (then oldest, so the order is total). */
export async function listHomePages(
  db: Database,
  ownerId: string,
): Promise<HomeCanvasPageRow[]> {
  return db
    .select()
    .from(homeCanvasPages)
    .where(eq(homeCanvasPages.ownerId, ownerId))
    .orderBy(asc(homeCanvasPages.pageOrder), asc(homeCanvasPages.id))
}

/** One page by id — RLS-filtered, so somebody else's is simply undefined. */
async function getHomePage(
  db: Database,
  pageId: string,
): Promise<HomeCanvasPageRow | undefined> {
  const [row] = await db
    .select()
    .from(homeCanvasPages)
    .where(eq(homeCanvasPages.id, pageId))
  // The declared `| undefined` is what makes the callers' `if (!row)` honest:
  // drizzle's destructure type claims a row is always there, and under RLS it
  // isn't. Same shape as chat's `getWidget`.
  return row
}

/** The page, or a clean refusal — under RLS a read IS the ownership check. */
async function visiblePage(
  db: Database,
  pageId: string,
): Promise<HomeCanvasPageRow> {
  const row = await getHomePage(db, pageId)
  if (!row) throw new Error('no such home page')
  return row
}

/** One tile by id — RLS-filtered, so somebody else's is simply undefined. */
async function getHomeTile(
  db: Database,
  tileId: string,
): Promise<HomeCanvasTileRow | undefined> {
  const [row] = await db
    .select()
    .from(homeCanvasTiles)
    .where(eq(homeCanvasTiles.id, tileId))
  return row
}

export async function renameHomePage(
  db: Database,
  input: { pageId: string; title: string },
): Promise<void> {
  await visiblePage(db, input.pageId)
  const title = input.title.trim()
  if (!title) throw new Error('a home page needs a name')
  await db
    .update(homeCanvasPages)
    .set({ title })
    .where(eq(homeCanvasPages.id, input.pageId))
}

/**
 * Remove an EMPTY page. One still holding tiles is refused rather than cascaded
 * away — the same rule the chat canvas keeps, for the same reason: tidying your
 * tabs must never be the thing that destroys an arrangement you made.
 */
export async function removeHomePage(
  db: Database,
  input: { pageId: string },
): Promise<void> {
  const page = await visiblePage(db, input.pageId)
  const held = await db
    .select({ id: homeCanvasTiles.id })
    .from(homeCanvasTiles)
    .where(eq(homeCanvasTiles.pageId, input.pageId))
  if (held.length > 0) {
    throw new Error(`“${page.title}” still has tiles on it — unpin them first`)
  }
  await db.delete(homeCanvasPages).where(eq(homeCanvasPages.id, input.pageId))
}

// --- Tiles -----------------------------------------------------------------

/** One person's home tiles, in arrangement order — top row first, then left to right. */
export async function listHomeTiles(
  db: Database,
  ownerId: string,
): Promise<HomeCanvasTileRow[]> {
  return db
    .select()
    .from(homeCanvasTiles)
    .where(eq(homeCanvasTiles.ownerId, ownerId))
    .orderBy(
      asc(homeCanvasTiles.gridY),
      asc(homeCanvasTiles.gridX),
      asc(homeCanvasTiles.id),
    )
}

/** The tiles already on a page, as boxes — what a new or moved one fits around. */
async function boxesOnPage(
  db: Database,
  pageId: string,
  except?: string,
): Promise<CanvasBox[]> {
  const rows = await db
    .select({
      id: homeCanvasTiles.id,
      gridX: homeCanvasTiles.gridX,
      gridY: homeCanvasTiles.gridY,
      gridW: homeCanvasTiles.gridW,
      gridH: homeCanvasTiles.gridH,
    })
    .from(homeCanvasTiles)
    .where(eq(homeCanvasTiles.pageId, pageId))
  return rows.filter((r) => r.id !== except)
}

/**
 * Where a pin with no page named lands: your first page, made for you if you
 * have none. The default title is deliberately dull — this page is the one you
 * never chose, and naming it something clever would be a name you then have to
 * live with.
 */
async function landingPage(db: Database, ownerId: string): Promise<string> {
  const existing = await listHomePages(db, ownerId)
  const first = existing.at(0)
  if (first) return first.id
  const made = await createHomePage(db, {
    id: uuidv7(),
    ownerId,
    title: 'Home',
  })
  return made.id
}

/**
 * Pin a pointer onto a home page — at a chat, or at one specific widget.
 *
 * **You may only pin what you can currently see.** The check is a read of the
 * target under the caller's own RLS context, so it's chat's policy answering,
 * not a rule copied over here. It is a courtesy rather than the security
 * boundary — the boundary is `readHomeCanvas` refusing to resolve content later
 * — but pinning something invisible would produce a tile that never renders,
 * and a door that lets you do that is just a trap.
 */
export async function pinHomeTile(
  db: Database,
  input: {
    id: string
    ownerId: string
    /**
     * Which page to land on. Optional, because "pin this to my home" is a move
     * you make from somewhere ELSE (a chat's canvas tile), where you have no
     * page in mind and shouldn't be asked to pick one. With none given it lands
     * on your first page — and makes you one if you have none, so the very
     * first pin doesn't dead-end on "create a page first".
     */
    pageId?: string
    chatId?: string
    widgetId?: string
  } & Partial<CanvasBox>,
): Promise<HomeCanvasTileRow> {
  if ((input.chatId == null) === (input.widgetId == null)) {
    throw new Error('a home tile points at exactly one of a chat or a widget')
  }
  const pageId = input.pageId ?? (await landingPage(db, input.ownerId))
  await visiblePage(db, pageId)
  if (input.chatId != null) {
    // RLS-filtered: a chat you're not in isn't in your own summaries.
    const summaries = await listChatSummaries(db, input.ownerId)
    if (!summaries.some((c) => c.id === input.chatId)) {
      throw new Error('not a member of this chat')
    }
  } else if (input.widgetId != null) {
    const visible = await listWidgetsByIds(db, [input.widgetId])
    if (visible.length === 0) {
      throw new Error('no such widget (or not a member of its chat)')
    }
  }
  const taken = await boxesOnPage(db, pageId)
  const size = clampCanvasBox({ gridW: input.gridW, gridH: input.gridH })
  const corner =
    input.gridX === undefined && input.gridY === undefined
      ? nextCanvasSlot(taken, size)
      : { gridX: input.gridX ?? 0, gridY: input.gridY ?? 0 }
  const box = freeCanvasBox(taken, clampCanvasBox({ ...size, ...corner }))
  const [row] = await db
    .insert(homeCanvasTiles)
    .values({
      id: input.id,
      ownerId: input.ownerId,
      pageId,
      chatId: input.chatId ?? null,
      widgetId: input.widgetId ?? null,
      ...box,
    })
    .returning()
  return row
}

/**
 * Move or resize a tile — the write behind a drag, a nudge, or a hand-off to
 * another page. Clamped and collision-yielding by exactly the arithmetic the
 * chat canvas uses, so a tile can't land off the edge or on top of a neighbour.
 */
export async function moveHomeTile(
  db: Database,
  input: { tileId: string; pageId: string } & Partial<CanvasBox>,
): Promise<void> {
  const tile = await getHomeTile(db, input.tileId)
  if (!tile) throw new Error('no such home tile')
  await visiblePage(db, input.pageId)
  const taken = await boxesOnPage(db, input.pageId, input.tileId)
  const size = clampCanvasBox({ gridW: input.gridW, gridH: input.gridH })
  const box = freeCanvasBox(
    taken,
    clampCanvasBox({
      ...size,
      gridX: input.gridX ?? tile.gridX,
      gridY: input.gridY ?? tile.gridY,
    }),
  )
  await db
    .update(homeCanvasTiles)
    .set({ pageId: input.pageId, ...box })
    .where(eq(homeCanvasTiles.id, input.tileId))
}

/**
 * Take a tile off your home. It removes the PLACEMENT and nothing else — the
 * widget goes on living in its chat, which is the whole reason pointers exist.
 */
export async function unpinHomeTile(
  db: Database,
  input: { tileId: string },
): Promise<void> {
  await db.delete(homeCanvasTiles).where(eq(homeCanvasTiles.id, input.tileId))
}

// --- Reading: resolving pointers under the viewer's own membership ---------

/** A widget as a home tile shows it — the row, never a snapshot of its contents. */
export interface HomeWidgetView {
  id: string
  kind: string
  props: JsonValue
  createdByHandle: string
  /** The decision recorded on a canvas-placed choice, or null if unanswered. */
  answerValue: string | null
}

/** The chat a tile belongs to, named the way the sidebar names it. */
export interface HomeChatView {
  id: string
  title: string | null
  memberHandles: string[]
}

/**
 * What a tile currently resolves to.
 *
 * `lost` is the honest placeholder for a pointer whose chat you're no longer in.
 * It carries NOTHING — no chat name, no question, no id — because the only
 * thing it's allowed to tell you is that there was something here. That it's
 * shown at all rather than silently vanishing is safe **because home is
 * personal**: you are the only viewer of your own home, so there is no third
 * party to leak the existence of a conversation to, and a tile that quietly
 * disappears is a worse experience than one that says what happened. The same
 * placeholder on a SHARED surface would not be safe.
 */
export type HomeTileTarget =
  | { mode: 'widget'; chat: HomeChatView; widget: HomeWidgetView }
  | { mode: 'chat'; chat: HomeChatView; widget: HomeWidgetView | null }
  | { mode: 'lost' }

/** A tile, resolved and placed — what the view draws. */
export interface HomeTileView extends CanvasBox {
  id: string
  pageId: string
  target: HomeTileTarget
}

/** One person's whole home canvas, resolved. */
export interface HomeCanvasView {
  pages: HomeCanvasPageRow[]
  tiles: HomeTileView[]
  /**
   * The ship-log topics this home needs to stay live — one per chat it can
   * actually see, deduped. Computed here rather than derived in the browser so
   * a `lost` tile contributes nothing: the live path can't become the side
   * channel the read just closed.
   */
  topics: string[]
}

function widgetView(row: ChatWidgetView): HomeWidgetView {
  return {
    id: row.id,
    kind: row.kind,
    props: row.props,
    createdByHandle: row.createdByHandle,
    answerValue: row.answerValue,
  }
}

/**
 * Read a whole home canvas, resolving every pointer against the viewer's
 * CURRENT chat membership.
 *
 * Three RLS-filtered reads, whatever the tile count: the chats this person is in
 * (which is the membership fact everything else is checked against), the pinned
 * widgets, and the open stacks of the pinned chats. A tile whose target doesn't
 * come back is `lost` — not because this function decided so, but because the
 * database declined to hand it over.
 *
 * Must be run under the viewer's own actor (`withActor`). On a superuser
 * connection RLS is bypassed and every pointer would resolve, which is exactly
 * the bug this design exists to prevent — so the doors in server.ts are the only
 * callers, and they all go through `withCurrentActor`.
 */
export async function readHomeCanvas(
  db: Database,
  ownerId: string,
): Promise<HomeCanvasView> {
  const pages = await listHomePages(db, ownerId)
  const rows = await listHomeTiles(db, ownerId)

  const summaries = await listChatSummaries(db, ownerId)
  const chats = new Map<string, HomeChatView>(
    summaries.map((c) => [
      c.id,
      { id: c.id, title: c.title, memberHandles: c.memberHandles },
    ]),
  )

  const widgetIds = rows.flatMap((t) => (t.widgetId ? [t.widgetId] : []))
  const widgets = new Map(
    (await listWidgetsByIds(db, widgetIds)).map((w) => [w.id, w]),
  )

  const chatIds = [
    ...new Set(rows.flatMap((t) => (t.chatId ? [t.chatId] : []))),
  ]
  // The stack read comes back in render order, so the FIRST row for a chat is
  // the one at the top of it — which is what a live chat pointer shows.
  const tops = new Map<string, ChatWidgetView>()
  for (const widget of await listOpenWidgetsForChats(db, chatIds)) {
    if (!tops.has(widget.chatId)) tops.set(widget.chatId, widget)
  }

  const seen = new Set<string>()
  const tiles = rows.map((row): HomeTileView => {
    const box = {
      gridX: row.gridX,
      gridY: row.gridY,
      gridW: row.gridW,
      gridH: row.gridH,
    }
    const base = { id: row.id, pageId: row.pageId, ...box }
    if (row.widgetId) {
      const widget = widgets.get(row.widgetId)
      const chat = widget && chats.get(widget.chatId)
      if (!widget || !chat) return { ...base, target: { mode: 'lost' } }
      seen.add(chat.id)
      return {
        ...base,
        target: { mode: 'widget', chat, widget: widgetView(widget) },
      }
    }
    const chat = row.chatId ? chats.get(row.chatId) : undefined
    if (!chat) return { ...base, target: { mode: 'lost' } }
    seen.add(chat.id)
    const top = tops.get(chat.id)
    return {
      ...base,
      target: { mode: 'chat', chat, widget: top ? widgetView(top) : null },
    }
  })

  return { pages, tiles, topics: [...seen].map(chatTopic) }
}
