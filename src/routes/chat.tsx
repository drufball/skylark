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
  createChatPage,
  createChatSchedule,
  deleteChatSchedule,
  dismissChatWidget,
  getChatCanvas,
  getChatThread,
  listChatCrew,
  listChats,
  listChatSchedules,
  listChatWidgets,
  placeChatWidget,
  postChatMessage,
  removeChatPage,
  renameChatPage,
  setChatScheduleEnabled,
  setChatViewPage,
  stackChatWidget,
  updateChat,
} from '@hull/chat/server'
import {
  CHAT_AGENT_PROGRESS,
  CHAT_CANVAS_CHANGED,
  CHAT_WIDGET_CHANGED,
  chatTopic,
  type ChatAgentProgressPayload,
} from '@hull/chat/topic'
import { pinHomeCanvasTile } from '@hull/home-canvas/server'
import {
  ChatView,
  type ChatListItem,
  type ChatMemberItem,
  type ChatMsg,
  type CrewMember,
  type NewSchedule,
  type ScheduleItem,
  workingFromMembers,
} from '@rigging/views/chat'
import type { CanvasWidgetItem } from '@rigging/widgets/canvas'
import type { WidgetItem } from '@rigging/widgets/stack'
import { Dock } from '@rigging/views/dock'
import { roomViewLink } from '@rigging/rooms/rooms'
import { useInvalidatingAction } from '@rigging/lib/use-invalidating-action'
import { useShipLog, type ShipLogEvent } from '@rigging/lib/use-ship-log'
import { useBehindOrigin } from '@rigging/lib/use-behind-origin'
import { useLogout } from '@rigging/lib/use-logout'

// Every conversation on the ship. Participant-focused — it opens your most
// recent one, since you keep messaging the same people with new tasks. Live
// messages and an agent's "working…" progress ride the ship's log (SSE), scoped
// to the chat.
//
// This used to be `/`. It moved here when the home canvas took the front door,
// and `/` now redirects any `?chat=<id>` link straight back to this route with
// the parameter intact — an agent posted plenty of those into conversations
// before the move, and a dead bookmark is a worse thing to ship than a
// redirect. See `routes/index.tsx`.
//
// A chat that is one of the ship's DEFAULT ROOMS also links through to the
// richer view it's the room for (`/issues`, `/files`, `/inbox`) — those views
// left the rail when the rooms arrived, and the room is now the way in.

interface ChatSearch {
  chat?: string
  new?: boolean
}

export const Route = createFileRoute('/chat')({
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
    // The thread gates the rest (a chat we can't see fetches nothing more);
    // the other three depend only on the id, so they come down TOGETHER — one
    // round trip, not three queued behind each other. The canvas is among
    // them, not a second navigation: it lives INSIDE the chat.
    const [schedules, widgets, canvas] =
      thread && activeId
        ? await Promise.all([
            listChatSchedules({ data: activeId }),
            listChatWidgets({ data: activeId }),
            getChatCanvas({ data: activeId }),
          ])
        : [[], [], { pages: [], widgets: [], viewPageId: null }]
    return {
      me,
      chats,
      crew,
      thread,
      schedules,
      widgets,
      canvas,
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
  const { me, chats, crew, thread, schedules, widgets, canvas, activeId } =
    Route.useLoaderData()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()
  const { busy, run, act } = useInvalidatingAction()

  // The progress bubble remembers WHICH chat it belongs to: it's cleared by a
  // posted message, not by switching chats, so without the chatId a bubble
  // from chat A would keep rendering inside chat B after a switch.
  const [working, setWorking] = useState<{
    chatId: string
    handle: string
    line: string
  } | null>(null)

  // The canvas page THIS person has open, held locally so a tab tap is instant,
  // and carrying its chatId for the same reason `working` does — a page from
  // chat A must not be treated as chat B's after a switch.
  const [viewPage, setViewPage] = useState<{
    chatId: string
    pageId: string
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
  // The canvas page rides the same seam, for the same reason.
  const [seededFor, setSeededFor] = useState<string | undefined>(undefined)
  if (seededFor !== activeId) {
    setSeededFor(activeId)
    const seeded = activeId ? workingFromMembers(members) : null
    setWorking(seeded && activeId ? { chatId: activeId, ...seeded } : null)
    // The durable half: which page this person left open here last time.
    setViewPage(
      activeId && canvas.viewPageId
        ? { chatId: activeId, pageId: canvas.viewPageId }
        : null,
    )
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
      } else if (
        event.type === CHAT_WIDGET_CHANGED ||
        event.type === CHAT_CANVAS_CHANGED
      ) {
        // A widget was raised, answered, waved away, moved or placed, or the
        // canvas pages changed. Both ride the same chat:<id> topic as messages,
        // so the stack and the canvas refresh off the stream we're already
        // listening on — no new transport. (Which page somebody is LOOKING at
        // deliberately emits nothing: that's their view, not chat news.)
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

  // Every small action below is `act`: run the door, re-run the loader, one
  // busy window — see useInvalidatingAction for why the refresh is inside.

  async function changeMembers(input: {
    addMemberId?: string
    removeMemberId?: string
  }) {
    if (!activeId) return
    await act(() => updateChat({ data: { chatId: activeId, ...input } }))
  }

  async function addSchedule(input: NewSchedule) {
    if (!activeId) return
    await act(() =>
      createChatSchedule({ data: { chatId: activeId, ...input } }),
    )
  }

  async function toggleSchedule(scheduleId: string, enabled: boolean) {
    await act(() => setChatScheduleEnabled({ data: { scheduleId, enabled } }))
  }

  async function removeSchedule(scheduleId: string) {
    await act(() => deleteChatSchedule({ data: { scheduleId } }))
  }

  async function answerWidget(widgetId: string, value: string) {
    await act(() => answerChatWidget({ data: { widgetId, value } }))
  }

  async function dismissWidget(widgetId: string) {
    await act(() => dismissChatWidget({ data: { widgetId } }))
  }

  async function newPage(title: string) {
    if (!activeId) return
    const created = await act(() =>
      createChatPage({ data: { chatId: activeId, title } }),
    )
    // Land on the page you just made — your own view, so nobody else moves.
    if (created) await selectPage(created.id)
  }

  async function renamePage(pageId: string, title: string) {
    await act(() => renameChatPage({ data: { pageId, title } }))
  }

  async function removePage(pageId: string) {
    await act(() => removeChatPage({ data: { pageId } }))
  }

  async function placeWidget(
    widgetId: string,
    box: {
      pageId: string
      gridX?: number
      gridY?: number
      gridW?: number
      gridH?: number
    },
  ) {
    await act(() => placeChatWidget({ data: { widgetId, ...box } }))
  }

  async function stackWidget(widgetId: string) {
    await act(() => stackChatWidget({ data: { widgetId } }))
  }

  /**
   * Open a canvas page — MY view, not the chat's. Optimistic locally (a tab tap
   * must not wait on a round trip) and persisted against (chat, me) so a reload
   * lands back here. Deliberately does NOT invalidate: nothing else on the page
   * depends on it, and nobody else's view moves because mine did.
   */
  async function selectPage(pageId: string) {
    if (!activeId) return
    setViewPage({ chatId: activeId, pageId })
    await setChatViewPage({ data: { chatId: activeId, pageId } })
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
    answerValue: w.answerValue,
  }))
  const canvasItems: CanvasWidgetItem[] = canvas.widgets.map((w) => ({
    id: w.id,
    kind: w.kind,
    props: w.props,
    createdByHandle: w.createdByHandle,
    // An answered choice STAYS on a canvas and shows what was decided (the
    // hull's `answerDismisses`), so the row's decision has to come down too.
    answerValue: w.answerValue,
    // A canvas row always carries a page; the column is nullable only because a
    // STACK row has none.
    pageId: w.pageId ?? '',
    gridX: w.gridX,
    gridY: w.gridY,
    gridW: w.gridW,
    gridH: w.gridH,
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
      active="chats"
      Link={Link}
      onLogout={onLogout}
      behindOrigin={behindOrigin}
    >
      <ChatView
        chats={chatItems}
        activeId={activeId}
        // A default room links through to the surface it's the room for. Null
        // for an ordinary chat, which is most of them.
        viewLink={activeId ? roomViewLink(activeId) : null}
        Link={Link}
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
        canvasPages={canvas.pages}
        canvasWidgets={canvasItems}
        activePageId={
          viewPage && viewPage.chatId === activeId ? viewPage.pageId : null
        }
        onSelectPage={(pageId) => {
          void selectPage(pageId)
        }}
        onNewPage={(title) => {
          void newPage(title)
        }}
        onRenamePage={(pageId, title) => {
          void renamePage(pageId, title)
        }}
        onRemovePage={(pageId) => {
          void removePage(pageId)
        }}
        onPlaceWidget={(widgetId, box) => {
          void placeWidget(widgetId, box)
        }}
        onStackWidget={(widgetId) => {
          void stackWidget(widgetId)
        }}
        onPinHomeWidget={(widgetId) => {
          // A POINTER on your own home, not a move: the widget stays right
          // here. No page named — the door lands it on your first one (and
          // makes you one if this is your first pin).
          void act(() => pinHomeCanvasTile({ data: { widgetId } }))
        }}
      />
    </Dock>
  )
}
