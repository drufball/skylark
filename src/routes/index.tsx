import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'

import {
  createChatFn,
  getChatThread,
  listChatCrew,
  listChats,
  postChatMessage,
  updateChat,
} from '@hull/chat/server'
import {
  CHAT_AGENT_PROGRESS,
  chatTopic,
  type ChatAgentProgressPayload,
} from '@hull/chat/topic'
import {
  ChatView,
  type ChatListItem,
  type ChatMemberItem,
  type ChatMsg,
  type CrewMember,
} from '@rigging/views/chat'
import { Dock } from '@rigging/views/dock'
import { useServerAction } from '@rigging/lib/use-server-action'
import { useShipLog, type ShipLogEvent } from '@rigging/lib/use-ship-log'
import { useLogout } from '@rigging/lib/use-logout'

// The ship's front door: chat with the crew. Participant-focused — it opens your
// most recent conversation, since you keep messaging the same people with new
// tasks. Live messages and an agent's "working…" progress ride the ship's log
// (SSE), scoped to the chat. The dock switches to Issues and Agents.

interface ChatSearch {
  chat?: string
  new?: boolean
}

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): ChatSearch => ({
    chat: typeof search.chat === 'string' ? search.chat : undefined,
    new: search.new === true || search.new === 'true' ? true : undefined,
  }),
  loaderDeps: ({ search }) => ({ chat: search.chat, composing: search.new }),
  loader: async ({ deps }) => {
    const [{ me, chats }, crew] = await Promise.all([
      listChats(),
      listChatCrew(),
    ])
    // Default to the most recent chat unless we're composing a new one.
    const activeId = deps.composing ? undefined : (deps.chat ?? chats[0]?.id)
    const thread = activeId ? await getChatThread({ data: activeId }) : null
    return { me, chats, crew, thread, activeId: thread ? activeId : undefined }
  },
  component: ChatRoute,
})

function readProgress(payload: unknown): ChatAgentProgressPayload | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as Record<string, unknown>
  if (
    typeof p.chatId === 'string' &&
    typeof p.agentUserId === 'string' &&
    typeof p.line === 'string'
  ) {
    return { chatId: p.chatId, agentUserId: p.agentUserId, line: p.line }
  }
  return null
}

function ChatRoute() {
  const { new: composing } = Route.useSearch()
  const { me, chats, crew, thread, activeId } = Route.useLoaderData()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()
  const { busy, run } = useServerAction()

  // The progress bubble remembers WHICH chat it belongs to: it's cleared by a
  // posted message, not by switching chats, so without the chatId a bubble
  // from chat A would keep rendering inside chat B after a switch.
  const [working, setWorking] = useState<{
    chatId: string
    handle: string
    line: string
  } | null>(null)

  const members = useMemo(() => thread?.members ?? [], [thread])
  const topics = activeId ? [chatTopic(activeId)] : []
  const onEvent = useCallback(
    (event: ShipLogEvent) => {
      if (event.type === CHAT_AGENT_PROGRESS) {
        const progress = readProgress(event.payload)
        if (progress) {
          const handle =
            members.find((m) => m.userId === progress.agentUserId)?.handle ??
            '?'
          setWorking({ chatId: progress.chatId, handle, line: progress.line })
        }
      } else if (event.type === 'chat.message_posted') {
        setWorking(null)
        void router.invalidate()
      }
    },
    [members, router],
  )
  useShipLog(topics, onEvent)

  async function send(text: string) {
    if (!activeId) return
    await run(() => postChatMessage({ data: { chatId: activeId, body: text } }))
  }

  async function create(memberIds: string[], title: string) {
    const result = await run(() => createChatFn({ data: { memberIds, title } }))
    if (result) {
      await navigate({ search: { chat: result.id } })
    }
  }

  async function changeMembers(input: {
    addMemberId?: string
    removeMemberId?: string
  }) {
    if (!activeId) return
    await updateChat({ data: { chatId: activeId, ...input } })
    await router.invalidate()
  }

  const chatItems: ChatListItem[] = chats.map((c) => ({
    id: c.id,
    title: c.title,
    memberHandles: c.memberHandles,
  }))
  const memberItems: ChatMemberItem[] = members.map((m) => ({
    userId: m.userId,
    handle: m.handle,
    type: m.type,
  }))
  const messageItems: ChatMsg[] = (thread?.messages ?? []).map((m) => ({
    id: m.id,
    authorHandle: m.authorHandle,
    body: m.body,
    mine: m.authorId === me.id,
  }))
  const crewItems: CrewMember[] = crew.map((c) => ({
    id: c.id,
    handle: c.handle,
    displayName: c.displayName,
    type: c.type,
  }))

  const onLogout = useLogout()
  return (
    <Dock active="chat" Link={Link} onLogout={onLogout}>
      <ChatView
        chats={chatItems}
        activeId={activeId}
        title={thread?.chat.title ?? null}
        members={memberItems}
        messages={messageItems}
        working={
          working && working.chatId === activeId
            ? { handle: working.handle, line: working.line }
            : null
        }
        crew={crewItems}
        composing={composing === true}
        busy={busy}
        onSelect={(id) => {
          void navigate({ search: { chat: id } })
        }}
        onNew={() => {
          void navigate({ search: { new: true } })
        }}
        onSend={(text) => {
          void send(text)
        }}
        onCreate={(memberIds, title) => {
          void create(memberIds, title)
        }}
        onAddMember={(userId) => {
          void changeMembers({ addMemberId: userId })
        }}
        onRemoveMember={(userId) => {
          void changeMembers({ removeMemberId: userId })
        }}
      />
    </Dock>
  )
}
