import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'

import {
  answerChatWidget,
  createChatFn,
  createChatSchedule,
  deleteChatSchedule,
  dismissChatWidget,
  getChatThread,
  listChatCrew,
  listChats,
  listChatSchedules,
  listChatWidgets,
  postChatMessage,
  setChatScheduleEnabled,
  updateChat,
} from '@hull/chat/server'
import {
  CHAT_AGENT_PROGRESS,
  CHAT_WIDGET_CHANGED,
  chatTopic,
  type ChatAgentProgressPayload,
} from '@hull/chat/topic'
import {
  ChatView,
  type ChatListItem,
  type ChatMemberItem,
  type ChatMsg,
  type CrewMember,
  type NewSchedule,
  type ScheduleItem,
  type WidgetItem,
  workingFromMembers,
} from '@rigging/views/chat'
import { Dock } from '@rigging/views/dock'
import { useServerAction } from '@rigging/lib/use-server-action'
import { useShipLog, type ShipLogEvent } from '@rigging/lib/use-ship-log'
import { useBehindOrigin } from '@rigging/lib/use-behind-origin'
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
    const schedules =
      thread && activeId ? await listChatSchedules({ data: activeId }) : []
    const widgets =
      thread && activeId ? await listChatWidgets({ data: activeId }) : []
    return {
      me,
      chats,
      crew,
      thread,
      schedules,
      widgets,
      activeId: thread ? activeId : undefined,
    }
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
  const { me, chats, crew, thread, schedules, widgets, activeId } =
    Route.useLoaderData()
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

  // Seed (or reset) `working` from the loader's own data whenever the active
  // chat changes — including a navigate-away-and-back to the SAME chat, which
  // remounts nothing but still re-runs the loader. Without this, `working` is
  // ONLY ever set by a live SSE event, so a chat you return to (after missing
  // one) shows no bubble even though the agent is still mid-turn: the
  // loader's `getChatThread` already carries each member's durable
  // `progressLine` (chat/service.ts persists it precisely so this read-back
  // works). Compared during render (not an effect) so the very first paint
  // after a switch already reflects it, rather than flashing empty for a tick.
  const [seededFor, setSeededFor] = useState<string | undefined>(undefined)
  if (seededFor !== activeId) {
    setSeededFor(activeId)
    const seeded = activeId ? workingFromMembers(members) : null
    setWorking(seeded && activeId ? { chatId: activeId, ...seeded } : null)
  }

  const topics = activeId ? [chatTopic(activeId)] : []
  const onEvent = useCallback(
    (event: ShipLogEvent) => {
      if (event.type === CHAT_AGENT_PROGRESS) {
        const progress = readProgress(event.payload)
        if (progress) {
          // A blank line is the end of the turn — the agent isn't mid-turn any
          // more, so the status line comes down. This is the ONLY thing that
          // takes it down now: a posted message can't, since an agent posts
          // from inside its turn and may keep working (or may never post).
          if (!progress.line) {
            setWorking(null)
            // The turn ending is exactly when the agent's seen-watermark moved,
            // so refetch: it's what turns an unexplained silence into
            // "Seen by @tilde". A silent turn posts no message, so nothing else
            // would ever invalidate here.
            void router.invalidate()
          } else {
            const handle =
              members.find((m) => m.userId === progress.agentUserId)?.handle ??
              '?'
            setWorking({ chatId: progress.chatId, handle, line: progress.line })
          }
        }
      } else if (event.type === 'chat.message_posted') {
        // Deliberately does NOT clear `working`: a message landing mid-turn is
        // correct and common now, and blanking the status line here would make
        // the bubble flicker off and back on for the rest of the turn.
        void router.invalidate()
      } else if (event.type === CHAT_WIDGET_CHANGED) {
        // A widget was raised, answered, waved away or moved. It rides the same
        // chat:<id> topic as messages, so the stack refreshes off the stream
        // we're already listening on — no new transport.
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

  async function addSchedule(input: NewSchedule) {
    if (!activeId) return
    await run(() =>
      createChatSchedule({ data: { chatId: activeId, ...input } }),
    )
    await router.invalidate()
  }

  async function toggleSchedule(scheduleId: string, enabled: boolean) {
    await run(() => setChatScheduleEnabled({ data: { scheduleId, enabled } }))
    await router.invalidate()
  }

  async function removeSchedule(scheduleId: string) {
    await run(() => deleteChatSchedule({ data: { scheduleId } }))
    await router.invalidate()
  }

  async function answerWidget(widgetId: string, value: string) {
    await run(() => answerChatWidget({ data: { widgetId, value } }))
    await router.invalidate()
  }

  async function dismissWidget(widgetId: string) {
    await run(() => dismissChatWidget({ data: { widgetId } }))
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
    progressLine: m.progressLine,
    lastSeenMessageId: m.lastSeenMessageId,
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
  const widgetItems: WidgetItem[] = widgets.map((w) => ({
    id: w.id,
    kind: w.kind,
    props: w.props,
    createdByHandle: w.createdByHandle,
  }))
  const scheduleItems: ScheduleItem[] = schedules.map((s) => ({
    id: s.id,
    authorHandle: s.authorHandle,
    body: s.body,
    enabled: s.enabled,
    intervalMinutes: s.intervalMinutes,
    // Serialized over the wire: a Date | null becomes an ISO string | null.
    fireAt: s.fireAt as unknown as string | null,
    nextFireAt: s.nextFireAt as unknown as string | null,
  }))

  const onLogout = useLogout()
  const behindOrigin = useBehindOrigin()
  return (
    <Dock
      active="chat"
      Link={Link}
      onLogout={onLogout}
      behindOrigin={behindOrigin}
    >
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
        schedules={scheduleItems}
        onCreateSchedule={(input) => {
          void addSchedule(input)
        }}
        onToggleSchedule={(id, enabled) => {
          void toggleSchedule(id, enabled)
        }}
        onDeleteSchedule={(id) => {
          void removeSchedule(id)
        }}
        widgets={widgetItems}
        onAnswerWidget={(widgetId, value) => {
          void answerWidget(widgetId, value)
        }}
        onDismissWidget={(widgetId) => {
          void dismissWidget(widgetId)
        }}
      />
    </Dock>
  )
}
