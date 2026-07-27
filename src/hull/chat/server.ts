import { uuidv7 } from '@earendil-works/pi-agent-core'
import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'
import { withCurrentActor } from '@hull/users/actor'
import { listUsers } from '@hull/users/service'

import {
  addMember,
  addMessage,
  answerWidget,
  canAuthorSchedule,
  createCanvasPage,
  createChat,
  createSchedule,
  deleteSchedule,
  dismissWidget,
  ensureChatVisible,
  getChat,
  getSchedule,
  getViewPage,
  listCanvasPages,
  listCanvasWidgets,
  listChatSummaries,
  listMembers,
  listMessages,
  listOpenWidgets,
  listSchedules,
  placeWidget,
  removeCanvasPage,
  removeMember,
  renameCanvasPage,
  scheduleTiming,
  setScheduleEnabled,
  setTitle,
  setViewPage,
  stackWidget,
} from './service'

// The web doors onto the chat service. Every door runs under `withCurrentActor`,
// so RLS filters reads to what the actor may see and gates writes by the chat's
// membership policy — there's no in-code membership check, the policy is the
// gate. Posting a message is durable immediately (Postgres is the truth); the
// agent's reply is driven off the ship's log by the chat orchestrator (not
// inline), and both the message and the agent's live progress reach the browser
// over the ship's log (SSE), scoped to the chat.

// bootOrchestrator boots + subscribes the chat orchestrator in this
// process (idempotent, synchronous) — the doors below call it so opening the
// app recovers any agent reply a restart interrupted, without blocking.
// Uses dynamic import to keep node builtins out of client bundle.
async function bootOrchestrator(): Promise<void> {
  const { ensureChatOrchestrator } = await import('./orchestrator-live')
  ensureChatOrchestrator()
}

/** Everyone aboard — the picker for who's in a chat (the crew list is public). */
export const listChatCrew = createServerFn({ method: 'GET' }).handler(() =>
  listUsers(db),
)

/** The current actor's chats, newest first — the sidebar. */
export const listChats = createServerFn({ method: 'GET' }).handler(async () => {
  await bootOrchestrator()
  return withCurrentActor(async (tx, me) => {
    const chats = await listChatSummaries(tx, me.id)
    return { me: { id: me.id, handle: me.handle }, chats }
  })
})

/**
 * A chat's members + messages — RLS-filtered to the current actor. A non-member
 * sees no chat row and gets null (the route falls back rather than leaking that
 * the chat exists); the policy is the gate, not an in-code check.
 */
export const getChatThread = createServerFn({ method: 'GET' })
  .validator((chatId: string) => chatId)
  .handler(({ data: chatId }) =>
    withCurrentActor(async (tx, me) => {
      const chat = await getChat(tx, chatId)
      if (!chat) return null
      // Sequential, not Promise.all: a transaction is one connection, so its
      // queries can't run concurrently the way the pooled `db` could.
      const members = await listMembers(tx, chatId)
      const messages = await listMessages(tx, chatId)
      return {
        chat,
        members: members.map((m) => ({
          userId: m.userId,
          handle: m.handle,
          type: m.type,
          progressLine: m.progressLine,
          // How far this member's turns have read — what lets the thread say
          // "seen by @tilde" when an agent read something and chose not to
          // answer, rather than leaving the silence looking like a fault.
          lastSeenMessageId: m.lastSeenMessageId,
        })),
        messages,
        meId: me.id,
      }
    }),
  )

/**
 * Create a chat. The current actor is always a member (you never tell the
 * system it's you); any other selected users join too.
 */
export const createChatFn = createServerFn({ method: 'POST' })
  .validator((input: { title?: string; memberIds: string[] }) => input)
  .handler(({ data }) => {
    const id = uuidv7()
    return withCurrentActor(async (tx, me) => {
      await createChat(tx, {
        id,
        title: data.title?.trim() ? data.title.trim() : null,
        memberIds: [me.id, ...data.memberIds],
      })
      return { id }
    })
  })

/** Post a message as the current actor, then let agents respond in the background. */
export const postChatMessage = createServerFn({ method: 'POST' })
  .validator((input: { chatId: string; body: string }) => input)
  .handler(async ({ data }) => {
    // Subscribe the orchestrator BEFORE the post, so the message's ship-log
    // event is heard and drives the reply — off the bus, not inline here.
    await bootOrchestrator()
    return withCurrentActor(async (tx, me) => {
      // A non-member can't see the chat → clean refusal (the chat_messages
      // WITH CHECK policy would reject the insert regardless).
      await ensureChatVisible(tx, data.chatId)
      await addMessage(tx, {
        id: uuidv7(),
        chatId: data.chatId,
        authorId: me.id,
        body: data.body,
      })
      return { ok: true }
    })
  })

/** A chat's schedules — RLS-filtered to the current actor (a member). */
export const listChatSchedules = createServerFn({ method: 'GET' })
  .validator((chatId: string) => chatId)
  .handler(({ data: chatId }) =>
    withCurrentActor(async (tx) => {
      await ensureChatVisible(tx, chatId)
      return listSchedules(tx, chatId)
    }),
  )

/**
 * Create a schedule: a message queued to post itself later, one-shot (`fireAt`)
 * or recurring (`intervalMinutes`). `authorId` defaults to you; naming another
 * is allowed only for an agent member of the chat (never another human — a
 * schedule posts in its author's name). Timing is validated at the door.
 */
export const createChatSchedule = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      chatId: string
      body: string
      authorId?: string
      /** ISO timestamp for a one-shot fire; XOR intervalMinutes. */
      fireAt?: string
      /** Whole minutes between fires for a recurring schedule; XOR fireAt. */
      intervalMinutes?: number
    }) => input,
  )
  .handler(({ data }) =>
    withCurrentActor(async (tx, me) => {
      await ensureChatVisible(tx, data.chatId)
      const body = data.body.trim()
      if (!body) throw new Error('a schedule needs a message body')
      const authorId = data.authorId ?? me.id
      const members = await listMembers(tx, data.chatId)
      if (!canAuthorSchedule({ actorId: me.id, authorId, members })) {
        throw new Error(
          'a schedule may post only as yourself or an agent in this chat',
        )
      }
      const timing = scheduleTiming({
        now: new Date(),
        fireAt: data.fireAt ? new Date(data.fireAt) : null,
        intervalMinutes: data.intervalMinutes ?? null,
      })
      const row = await createSchedule(tx, {
        id: uuidv7(),
        chatId: data.chatId,
        authorId,
        body,
        createdById: me.id,
        ...timing,
      })
      return { id: row.id }
    }),
  )

/** Turn a schedule on or off — RLS gates it to a member of the schedule's chat. */
export const setChatScheduleEnabled = createServerFn({ method: 'POST' })
  .validator((input: { scheduleId: string; enabled: boolean }) => input)
  .handler(({ data }) =>
    withCurrentActor(async (tx) => {
      // getSchedule is RLS-filtered → a non-member sees undefined (clean refusal).
      if (!(await getSchedule(tx, data.scheduleId)))
        throw new Error('not a member of this chat')
      await setScheduleEnabled(tx, data.scheduleId, data.enabled)
      return { ok: true }
    }),
  )

/** Delete a schedule — RLS gates it to a member of the schedule's chat. */
export const deleteChatSchedule = createServerFn({ method: 'POST' })
  .validator((input: { scheduleId: string }) => input)
  .handler(({ data }) =>
    withCurrentActor(async (tx) => {
      if (!(await getSchedule(tx, data.scheduleId)))
        throw new Error('not a member of this chat')
      await deleteSchedule(tx, data.scheduleId)
      return { ok: true }
    }),
  )

// --- Widgets ---------------------------------------------------------------
//
// The stack of live little views a chat keeps open above its composer. Every
// door is RLS-gated by chat membership, like the rest of chat: the widget read
// IS the access check. Nothing here decides to raise a widget on its own — an
// actor asks, through a door, from their own turn.
//
// The web doors are the ones a BROWSER needs: read the stack, answer, wave away.
// Raising and reordering are agent moves, and their door is the chat CLI
// (`npm run chat -- widget new|reorder`) — the same split the schedules slice
// made, and the reason there's no unused server fn sitting here.

/** The active widget stack for a chat — dismissed ones already excluded. */
export const listChatWidgets = createServerFn({ method: 'GET' })
  .validator((chatId: string) => chatId)
  .handler(({ data: chatId }) =>
    withCurrentActor(async (tx) => {
      await ensureChatVisible(tx, chatId)
      return listOpenWidgets(tx, chatId)
    }),
  )

/**
 * Answer a widget: posts an ORDINARY chat message as the current actor and
 * dismisses the widget, atomically. Because it's an ordinary message, the reply
 * rules, unseen diffing and SSE delivery need nothing new — so the orchestrator
 * has to be subscribed first, exactly like postChatMessage.
 */
export const answerChatWidget = createServerFn({ method: 'POST' })
  .validator((input: { widgetId: string; value: string }) => input)
  .handler(async ({ data }) => {
    await bootOrchestrator()
    return withCurrentActor(async (tx, me) => {
      await answerWidget(tx, {
        widgetId: data.widgetId,
        actorId: me.id,
        value: data.value,
      })
      return { ok: true }
    })
  })

/** Wave a widget away unanswered — out of the stack, kept as history. */
export const dismissChatWidget = createServerFn({ method: 'POST' })
  .validator((input: { widgetId: string }) => input)
  .handler(({ data }) =>
    withCurrentActor(async (tx, me) => {
      await dismissWidget(tx, { widgetId: data.widgetId, actorId: me.id })
      return { ok: true }
    }),
  )

// --- The canvas ------------------------------------------------------------
//
// The chat's second surface: pages of widgets the crew arranged, beside the
// thread rather than instead of it. Every door is RLS-gated by chat membership
// like the rest of chat, and `chat_view_state` carries a tighter policy still —
// you may only touch your OWN row, because which page you're looking at is
// yours (migration 0034).
//
// Unlike the stack, arranging IS a browser move: a drag or a resize is a
// placement write. So the placement doors live here as well as on the agent's
// tool, and they're the same service call either way.

/**
 * Everything the canvas needs in one read: the chat's pages, every widget
 * arranged on them (all pages at once, so switching tabs is instant), and the
 * page THIS person had open last time. A non-member is refused before any of it.
 */
export const getChatCanvas = createServerFn({ method: 'GET' })
  .validator((chatId: string) => chatId)
  .handler(({ data: chatId }) =>
    withCurrentActor(async (tx, me) => {
      await ensureChatVisible(tx, chatId)
      const pages = await listCanvasPages(tx, chatId)
      const widgets = await listCanvasWidgets(tx, chatId)
      return {
        pages,
        widgets,
        viewPageId: await getViewPage(tx, chatId, me.id),
      }
    }),
  )

/** Add a page to the canvas — it lands at the end of the strip. */
export const createChatPage = createServerFn({ method: 'POST' })
  .validator((input: { chatId: string; title: string }) => input)
  .handler(({ data }) =>
    withCurrentActor(async (tx, me) => {
      await ensureChatVisible(tx, data.chatId)
      const row = await createCanvasPage(tx, {
        id: uuidv7(),
        chatId: data.chatId,
        title: data.title,
        actorId: me.id,
      })
      return { id: row.id }
    }),
  )

/** Rename a page — RLS gates it to a member of the page's chat. */
export const renameChatPage = createServerFn({ method: 'POST' })
  .validator((input: { pageId: string; title: string }) => input)
  .handler(({ data }) =>
    withCurrentActor(async (tx, me) => {
      await renameCanvasPage(tx, { ...data, actorId: me.id })
      return { ok: true }
    }),
  )

/** Remove an EMPTY page. One holding widgets is refused, never cascaded away. */
export const removeChatPage = createServerFn({ method: 'POST' })
  .validator((input: { pageId: string }) => input)
  .handler(({ data }) =>
    withCurrentActor(async (tx, me) => {
      await removeCanvasPage(tx, { pageId: data.pageId, actorId: me.id })
      return { ok: true }
    }),
  )

/**
 * Put a widget on a canvas page, or move/resize one already there — the write
 * behind a drag. Coordinates are clamped into the grid by the service, so a
 * pointer that overshot the pane can't store a tile off the edge.
 */
export const placeChatWidget = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      widgetId: string
      pageId: string
      gridX?: number
      gridY?: number
      gridW?: number
      gridH?: number
    }) => input,
  )
  .handler(({ data }) =>
    withCurrentActor(async (tx, me) => {
      await placeWidget(tx, { ...data, actorId: me.id })
      return { ok: true }
    }),
  )

/** Take a widget off the canvas, back to the stack above the composer. */
export const stackChatWidget = createServerFn({ method: 'POST' })
  .validator((input: { widgetId: string }) => input)
  .handler(({ data }) =>
    withCurrentActor(async (tx, me) => {
      await stackWidget(tx, { widgetId: data.widgetId, actorId: me.id })
      return { ok: true }
    }),
  )

/**
 * Remember the page THIS person is looking at, so a reload puts them back.
 * Always the current actor's own row — the door doesn't take a userId, and the
 * policy wouldn't allow another one if it did.
 */
export const setChatViewPage = createServerFn({ method: 'POST' })
  .validator((input: { chatId: string; pageId: string | null }) => input)
  .handler(({ data }) =>
    withCurrentActor(async (tx, me) => {
      await ensureChatVisible(tx, data.chatId)
      await setViewPage(tx, { ...data, userId: me.id })
      return { ok: true }
    }),
  )

/** Add or remove a member, or retitle — any member may, no per-row ACL yet. */
export const updateChat = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      chatId: string
      addMemberId?: string
      removeMemberId?: string
      title?: string | null
    }) => input,
  )
  .handler(({ data }) =>
    withCurrentActor(async (tx) => {
      await ensureChatVisible(tx, data.chatId)
      if (data.addMemberId) await addMember(tx, data.chatId, data.addMemberId)
      if (data.removeMemberId)
        await removeMember(tx, data.chatId, data.removeMemberId)
      if (data.title !== undefined) await setTitle(tx, data.chatId, data.title)
      return { ok: true }
    }),
  )
