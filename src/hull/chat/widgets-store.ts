import { uuidv7 } from '@earendil-works/pi-agent-core'
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import { emitEvent } from '@hull/events/bus'
import { MEMBERS_AUDIENCE } from '@hull/events/service'
import { users } from '@hull/users/schema'

import { emitMessagePosted, writeMessage } from './messages'
import { chatWidgets, type ChatMessageRow, type ChatWidgetRow } from './schema'
import { CHAT_WIDGET_CHANGED, chatTopic, type ChatWidgetChange } from './topic'
import {
  answerDismisses,
  answerMessageBody,
  offeredAnswer,
  STACK_PLACEMENT,
  type JsonValue,
} from './widgets'

// --- Widgets ---------------------------------------------------------------

/**
 * A widget joined with the handle of whoever raised it — view/CLI ready. `props`
 * stays opaque JSON: only the rigging catalog gives it meaning, and it does that
 * at the edge that renders, so an unparseable blob costs one honest tile rather
 * than failing the whole list.
 */
export interface ChatWidgetView extends ChatWidgetRow {
  createdByHandle: string
}

/** Widget columns + the raiser's handle — one projection for every list read. */
export const widgetViewColumns = {
  id: chatWidgets.id,
  chatId: chatWidgets.chatId,
  kind: chatWidgets.kind,
  props: chatWidgets.props,
  placement: chatWidgets.placement,
  stackOrder: chatWidgets.stackOrder,
  pageId: chatWidgets.pageId,
  gridX: chatWidgets.gridX,
  gridY: chatWidgets.gridY,
  gridW: chatWidgets.gridW,
  gridH: chatWidgets.gridH,
  dismissedAt: chatWidgets.dismissedAt,
  answeredAt: chatWidgets.answeredAt,
  answerValue: chatWidgets.answerValue,
  createdById: chatWidgets.createdById,
  createdAt: chatWidgets.createdAt,
  createdByHandle: users.handle,
}

/**
 * Announce that a chat's widget stack changed, on the chat's own ship-log topic
 * — so the browser's existing `chat:<id>` subscription refreshes the stack with
 * no new transport of any kind. Emitted AFTER the write, like a posted message.
 *
 * Every widget mutation below announces itself rather than leaving it to the
 * door, so a second door (the CLI, an agent's own hands) can't quietly ship a
 * change nobody's browser hears.
 */
export async function emitWidgetChanged(
  db: Database,
  widget: { id: string; chatId: string },
  change: ChatWidgetChange,
  actorId: string,
): Promise<void> {
  await emitEvent(db, {
    type: CHAT_WIDGET_CHANGED,
    source: 'chat',
    topic: chatTopic(widget.chatId),
    audience: MEMBERS_AUDIENCE,
    actorId,
    payload: { chatId: widget.chatId, widgetId: widget.id, change },
  })
}

/**
 * Raise a widget in a chat. `createdById` is the actor who put it there — a
 * widget is always somebody's judgment, never a service's (see the zine).
 * `props` is written as given; validity is the rigging catalog's business at
 * render time, so a wrong blob is a visible tile the author can SEE and fix,
 * rather than a rejected write an agent gets no feedback from.
 */
export async function addWidget(
  db: Database,
  input: {
    id: string
    chatId: string
    kind: string
    props: JsonValue
    placement?: string
    stackOrder?: number
    createdById: string
  },
): Promise<ChatWidgetRow> {
  const [row] = await db
    .insert(chatWidgets)
    .values({
      id: input.id,
      chatId: input.chatId,
      kind: input.kind,
      props: input.props,
      placement: input.placement ?? STACK_PLACEMENT,
      stackOrder: input.stackOrder ?? 0,
      createdById: input.createdById,
    })
    .returning()
  await emitWidgetChanged(db, row, 'raised', input.createdById)
  return row
}

/** One widget by id — RLS-filtered, so a non-member sees undefined. */
export async function getWidget(
  db: Database,
  id: string,
): Promise<ChatWidgetRow | undefined> {
  const [row] = await db
    .select()
    .from(chatWidgets)
    .where(eq(chatWidgets.id, id))
  return row
}

/**
 * The widget, or a clean refusal. Under RLS the read IS the access check: a
 * non-member sees no row, and neither does anyone once the widget's chat is
 * deleted (the FK cascade takes it along — the never-orphaned invariant). So a
 * stale button in a long-open tab lands on "no such widget", not a raw error.
 */
export async function visibleWidget(
  db: Database,
  id: string,
): Promise<ChatWidgetRow> {
  const row = await getWidget(db, id)
  if (!row) throw new Error('no such widget (or not a member of its chat)')
  return row
}

/**
 * Every widget on a chat, dismissed ones included — the history view (the CLI
 * lists it). Ordered the way the stack renders so the two reads agree.
 */
export async function listWidgets(
  db: Database,
  chatId: string,
): Promise<ChatWidgetView[]> {
  return db
    .select(widgetViewColumns)
    .from(chatWidgets)
    .innerJoin(users, eq(chatWidgets.createdById, users.id))
    .where(eq(chatWidgets.chatId, chatId))
    .orderBy(asc(chatWidgets.stackOrder), asc(chatWidgets.id))
}

/**
 * The stack: a chat's open widgets in render order (low `stackOrder` first, then
 * oldest). Dismissed rows are excluded — they left the stack when they were
 * answered — and so is anything not placed in the stack, so a later canvas
 * placement can't leak into it.
 */
export async function listOpenWidgets(
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
        eq(chatWidgets.placement, STACK_PLACEMENT),
        isNull(chatWidgets.dismissedAt),
      ),
    )
    .orderBy(asc(chatWidgets.stackOrder), asc(chatWidgets.id))
}

/**
 * These exact widgets, whichever chats they live in — RLS-filtered, so a row in
 * a chat the actor is not (or is no longer) in simply doesn't come back.
 *
 * The read the home canvas resolves a **widget pointer** through. It is asked of
 * chat rather than joined from outside because a widget is chat's row and chat's
 * access: "may this person see it?" is answered by chat's own policies, at read
 * time, from the viewer's CURRENT membership. A caller that got a shorter list
 * than it asked for has learned exactly one thing, which is the right thing —
 * some of those are not yours any more.
 */
export async function listWidgetsByIds(
  db: Database,
  widgetIds: string[],
): Promise<ChatWidgetView[]> {
  if (widgetIds.length === 0) return []
  return db
    .select(widgetViewColumns)
    .from(chatWidgets)
    .innerJoin(users, eq(chatWidgets.createdById, users.id))
    .where(inArray(chatWidgets.id, widgetIds))
}

/**
 * The open stack widgets of several chats at once, in render order — the read a
 * **chat pointer** resolves through: whatever is currently at the top of that
 * chat's stack. RLS-filtered like every chat read, so a chat the actor has left
 * contributes nothing at all.
 *
 * One query for many chats rather than one per chat, because a home screen may
 * point into a dozen conversations and the point of it is that it's cheap to
 * look at.
 */
export async function listOpenWidgetsForChats(
  db: Database,
  chatIds: string[],
): Promise<ChatWidgetView[]> {
  if (chatIds.length === 0) return []
  return db
    .select(widgetViewColumns)
    .from(chatWidgets)
    .innerJoin(users, eq(chatWidgets.createdById, users.id))
    .where(
      and(
        inArray(chatWidgets.chatId, chatIds),
        eq(chatWidgets.placement, STACK_PLACEMENT),
        isNull(chatWidgets.dismissedAt),
      ),
    )
    .orderBy(asc(chatWidgets.stackOrder), asc(chatWidgets.id))
}

/** Move a widget within its placement — how an agent reorders the stack. */
export async function reorderWidget(
  db: Database,
  input: { widgetId: string; actorId: string; stackOrder: number },
): Promise<void> {
  const widget = await visibleWidget(db, input.widgetId)
  await db
    .update(chatWidgets)
    .set({ stackOrder: input.stackOrder })
    .where(eq(chatWidgets.id, input.widgetId))
  await emitWidgetChanged(db, widget, 'reordered', input.actorId)
}

/**
 * Take a widget out of the stack without answering it — waved away. The row
 * stays as history. First dismissal wins (`dismissed_at is null` in the where),
 * so waving away a widget twice doesn't rewrite when it stopped being open.
 */
export async function dismissWidget(
  db: Database,
  input: { widgetId: string; actorId: string },
): Promise<void> {
  const widget = await visibleWidget(db, input.widgetId)
  const dismissed = await db
    .update(chatWidgets)
    .set({ dismissedAt: new Date() })
    .where(
      and(eq(chatWidgets.id, input.widgetId), isNull(chatWidgets.dismissedAt)),
    )
    .returning({ id: chatWidgets.id })
  // Nothing changed → nothing to announce. An event saying a widget was
  // dismissed when it was already gone would send every member's browser to
  // refetch a stack that didn't move.
  if (dismissed.length > 0) {
    await emitWidgetChanged(db, widget, 'dismissed', input.actorId)
  }
}

/**
 * Answer a widget: post the answer as an ORDINARY chat message and mark the
 * decision on the row — in ONE transaction.
 *
 * "Ordinary message" is the whole design. Answering reuses chat's own message
 * write, authored by the ANSWERING actor, so the unseen-message diffing, reply
 * targeting, the no-agent-cascade rule, RLS, SSE delivery and the orchestrator's
 * reconcile all apply with zero new code — the same reasoning as a schedule
 * firing. There is no separate answer table and no separate delivery path.
 *
 * **What answering DOES to the tile depends on the surface it's on**, and that
 * distinction lives in the row's contract (`answerDismisses`), not in whichever
 * component draws it. On the turn-shaped **stack** the widget also leaves: the
 * question was dealt with. On a **canvas** page it stays exactly where somebody
 * put it and shows `answerValue` — a page is a layout the crew made, and a tile
 * that vanished when you answered it punched a hole in it.
 *
 * The guards, in order: the widget must be visible (RLS hides a non-member's, and
 * the chat's deletion cascades the row away entirely), the row must actually
 * offer answers, the value must be one of them, and the ANSWER must win the race
 * — the update is conditional on `answered_at is null and dismissed_at is null`,
 * so a double submit (two taps, two tabs) touches no rows the second time and
 * rolls back without posting a second message. That the guard is the answer mark
 * rather than the dismissal is what a canvas answer needs: the tile is still on
 * screen afterwards, so "is it dismissed?" stopped being the question. Marking
 * BEFORE writing the message is deliberate: the row lock serializes the attempts.
 *
 * The offer is read structurally (`offeredAnswer`), so the whitelist holds for
 * every answerable kind without the hull knowing one by name — and a `note`, an
 * `issue-list` or a blob an agent malformed all land on the same clean refusal
 * rather than posting a value nobody offered.
 */
export async function answerWidget(
  db: Database,
  input: { widgetId: string; actorId: string; value: string },
): Promise<ChatMessageRow> {
  const row = await db.transaction(async (tx) => {
    const widget = await visibleWidget(tx, input.widgetId)
    const offer = offeredAnswer(widget.props)
    if (!offer) {
      throw new Error('this widget offers nothing to answer')
    }
    if (!offer.options.includes(input.value)) {
      throw new Error(`“${input.value}” is not one of this widget’s options`)
    }
    const now = new Date()
    const answered = await tx
      .update(chatWidgets)
      .set({
        answeredAt: now,
        answerValue: input.value,
        // The turn-shaped surface clears; the state-shaped one keeps the tile.
        ...(answerDismisses(widget.placement) ? { dismissedAt: now } : {}),
      })
      .where(
        and(
          eq(chatWidgets.id, input.widgetId),
          isNull(chatWidgets.answeredAt),
          isNull(chatWidgets.dismissedAt),
        ),
      )
      .returning({ id: chatWidgets.id })
    if (answered.length === 0) {
      throw new Error('this widget has already been answered')
    }
    return writeMessage(tx, {
      id: uuidv7(),
      chatId: widget.chatId,
      authorId: input.actorId,
      body: answerMessageBody(offer.question, input.value),
    })
  })
  await emitMessagePosted(db, row)
  await emitWidgetChanged(
    db,
    { id: input.widgetId, chatId: row.chatId },
    'answered',
    input.actorId,
  )
  return row
}
