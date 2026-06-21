import { uuidv7 } from '@earendil-works/pi-agent-core'
import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'
import { errorMessage } from '@hull/lib/errors'
import { currentActor } from '@hull/users/actor'
import { listUsers } from '@hull/users/service'

import { ensureChatOrchestrator } from './orchestrator-live'
import {
  addMember,
  addMessage,
  createChat,
  getChat,
  isMember,
  listChatSummaries,
  listMembers,
  listMessages,
  removeMember,
  setTitle,
} from './service'

// The web doors onto the chat service. Posting a message is durable immediately
// (Postgres is the truth); the agent's reply is driven off the ship's log by the
// chat orchestrator (not inline — the same event-driven path the issues
// orchestrator uses), and both the message and the agent's live progress reach
// the browser over the ship's log (SSE), scoped to the chat.

/**
 * Ensure the chat orchestrator is booted + subscribed to the ship's log in this
 * process (idempotent). Fire-and-forget for the GET doors: opening the app runs
 * reconcile, recovering any agent reply a restart interrupted.
 */
function bootChatOrchestrator(): void {
  void ensureChatOrchestrator().catch((err: unknown) => {
    console.error(`chat orchestrator boot failed: ${errorMessage(err)}`)
  })
}

/** Everyone aboard — the picker for who's in a chat. */
export const listChatCrew = createServerFn({ method: 'GET' }).handler(() =>
  listUsers(db),
)

/** The current actor's chats, newest first — the sidebar. */
export const listChats = createServerFn({ method: 'GET' }).handler(async () => {
  bootChatOrchestrator()
  const me = await currentActor()
  const chats = await listChatSummaries(db, me.id)
  return { me: { id: me.id, handle: me.handle }, chats }
})

/**
 * A chat's members + messages — but only if the current actor is a member
 * (membership is visibility). Returns null when they're not, so the route can
 * fall back rather than leak that the chat exists.
 */
export const getChatThread = createServerFn({ method: 'GET' })
  .validator((chatId: string) => chatId)
  .handler(async ({ data: chatId }) => {
    const me = await currentActor()
    if (!(await isMember(db, chatId, me.id))) return null
    const chat = await getChat(db, chatId)
    if (!chat) return null
    const [members, messages] = await Promise.all([
      listMembers(db, chatId),
      listMessages(db, chatId),
    ])
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
  })

/**
 * Create a chat. The current actor is always a member (you never tell the
 * system it's you); any other selected users join too.
 */
export const createChatFn = createServerFn({ method: 'POST' })
  .validator((input: { title?: string; memberIds: string[] }) => input)
  .handler(async ({ data }) => {
    const me = await currentActor()
    const id = uuidv7()
    await createChat(db, {
      id,
      title: data.title?.trim() ? data.title.trim() : null,
      memberIds: [me.id, ...data.memberIds],
    })
    return { id }
  })

/** Post a message as the current actor, then let agents respond in the background. */
export const postChatMessage = createServerFn({ method: 'POST' })
  .validator((input: { chatId: string; body: string }) => input)
  .handler(async ({ data }) => {
    const me = await currentActor()
    if (!(await isMember(db, data.chatId, me.id)))
      throw new Error('not a member of this chat')
    // Subscribe the orchestrator BEFORE the post, so the message's ship-log
    // event is heard and drives the reply. The reply runs off the bus, not from
    // an inline call here — the same path an agent's cross-process post takes.
    await ensureChatOrchestrator()
    await addMessage(db, {
      id: uuidv7(),
      chatId: data.chatId,
      authorId: me.id,
      body: data.body,
    })
    return { ok: true }
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
  .handler(async ({ data }) => {
    const me = await currentActor()
    if (!(await isMember(db, data.chatId, me.id)))
      throw new Error('not a member of this chat')
    if (data.addMemberId) await addMember(db, data.chatId, data.addMemberId)
    if (data.removeMemberId)
      await removeMember(db, data.chatId, data.removeMemberId)
    if (data.title !== undefined) await setTitle(db, data.chatId, data.title)
    return { ok: true }
  })
