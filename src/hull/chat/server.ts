import { uuidv7 } from '@earendil-works/pi-agent-core'
import { createServerFn } from '@tanstack/react-start'

import { bootAllReactors } from '@/boot'
import { db } from '@hull/db/client'
import { withCurrentActor } from '@hull/users/actor'
import { listUsers } from '@hull/users/service'

import { ensureChatOrchestrator } from './orchestrator-live'

// Boot all reactors eagerly when this module loads (crash-only recovery, #lo0x).
// This runs once per server process, early (the index route imports this), so
// after every reload reconcile runs immediately and the deaf window is ~0.
bootAllReactors()
import {
  addMember,
  addMessage,
  createChat,
  ensureChatVisible,
  getChat,
  listChatSummaries,
  listMembers,
  listMessages,
  removeMember,
  setTitle,
} from './service'

// The web doors onto the chat service. Every door runs under `withCurrentActor`,
// so RLS filters reads to what the actor may see and gates writes by the chat's
// membership policy — there's no in-code membership check, the policy is the
// gate. Posting a message is durable immediately (Postgres is the truth); the
// agent's reply is driven off the ship's log by the chat orchestrator (not
// inline), and both the message and the agent's live progress reach the browser
// over the ship's log (SSE), scoped to the chat.

// ensureChatOrchestrator boots + subscribes the chat orchestrator in this
// process (idempotent, synchronous) — the doors below call it so opening the
// app recovers any agent reply a restart interrupted, without blocking.

/** Everyone aboard — the picker for who's in a chat (the crew list is public). */
export const listChatCrew = createServerFn({ method: 'GET' }).handler(() =>
  listUsers(db),
)

/** The current actor's chats, newest first — the sidebar. */
export const listChats = createServerFn({ method: 'GET' }).handler(() => {
  ensureChatOrchestrator()
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
  .handler(({ data }) => {
    // Subscribe the orchestrator BEFORE the post, so the message's ship-log
    // event is heard and drives the reply — off the bus, not inline here.
    ensureChatOrchestrator()
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
