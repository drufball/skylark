import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useCallback } from 'react'

import { answerChatWidget, listChats } from '@hull/chat/server'
import {
  createHomeCanvasPage,
  getHomeCanvas,
  moveHomeCanvasTile,
  pinHomeCanvasTile,
  removeHomeCanvasPage,
  renameHomeCanvasPage,
  unpinHomeCanvasTile,
} from '@hull/home-canvas/server'
import { Dock } from '@rigging/views/dock'
import { HomeCanvas, type HomeTileItem } from '@rigging/widgets/home-canvas'
import { useBehindOrigin } from '@rigging/lib/use-behind-origin'
import { useLogout } from '@rigging/lib/use-logout'
import { useServerAction } from '@rigging/lib/use-server-action'
import { useShipLog } from '@rigging/lib/use-ship-log'

// **The front door: your home canvas.** Pages of POINTERS at widgets that live
// in chats you're in — a heads-up display of your software, with the agents
// that run it one tap away. This is what six slices of chat-native work were
// for, so it's what you land on.
//
// `/` used to be the chat front door and took a `?chat=<id>` search param.
// Agents posted those links into conversations and the crew bookmarked them, so
// the old shape is not dropped: it redirects to `/chat` with the parameter
// carried across (below). One redirect is cheap; a dead link in a year-old
// conversation is not.
//
// Which page you're on lives in the URL rather than in a table. On a shared
// surface that had to be per-viewer state (chat_view_state); home has exactly
// one viewer, so the URL is the honest home for it — and it hands us back and
// forward for free, which is what makes tapping through to a chat and coming
// back land you where you were.

interface HomeSearch {
  page?: string
  /** Legacy `/?chat=<id>` — read only so `beforeLoad` can forward it. */
  chat?: string
  /** Legacy `/?new=true` — the old "compose a chat" front door. */
  new?: boolean
}

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    page: typeof search.page === 'string' ? search.page : undefined,
    chat: typeof search.chat === 'string' ? search.chat : undefined,
    new: search.new === true || search.new === 'true' ? true : undefined,
  }),
  /**
   * The old front door, forwarded. Redirecting in `beforeLoad` means the home
   * canvas is never read for a request that was always going to end up in a
   * chat — and the parameter travels, so `/?chat=abc` lands in that
   * conversation rather than on a home screen that silently swallowed it.
   */
  beforeLoad: ({ search }) => {
    if (search.chat !== undefined || search.new !== undefined) {
      redirect({
        to: '/chat',
        search: { chat: search.chat, new: search.new },
        throw: true,
      })
    }
  },
  loader: async () => {
    const [home, { chats }] = await Promise.all([getHomeCanvas(), listChats()])
    return { home, chats }
  },
  component: HomeRoute,
})

function HomeRoute() {
  const { page } = Route.useSearch()
  const { home, chats } = Route.useLoaderData()
  const navigate = useNavigate({ from: Route.fullPath })
  const router = useRouter()
  const { busy, run } = useServerAction()

  // The live half. A raise in ANY pointed-at chat has to change what a tile
  // shows, and that's a re-resolve on the server (membership is checked there),
  // so the event reloads the route rather than nudging a component. The topic
  // set comes from the server too — one per chat it could actually resolve —
  // so a tile you've lost access to contributes nothing and the stream can't
  // become the side channel the read just closed.
  const onEvent = useCallback(() => {
    void router.invalidate()
  }, [router])
  useShipLog(home.topics, onEvent)

  const tiles: HomeTileItem[] = home.tiles.map((t) => ({
    id: t.id,
    pageId: t.pageId,
    gridX: t.gridX,
    gridY: t.gridY,
    gridW: t.gridW,
    gridH: t.gridH,
    target: t.target,
  }))

  const activePageId =
    home.pages.find((p) => p.id === page)?.id ?? home.pages.at(0)?.id ?? null

  async function newPage(title: string) {
    const created = await run(() => createHomeCanvasPage({ data: { title } }))
    await router.invalidate()
    if (created) await navigate({ search: { page: created.id } })
  }

  async function act(fn: () => Promise<unknown>) {
    await run(fn)
    await router.invalidate()
  }

  const onLogout = useLogout()
  const behindOrigin = useBehindOrigin()
  return (
    <Dock
      active="home"
      Link={Link}
      onLogout={onLogout}
      behindOrigin={behindOrigin}
    >
      <HomeCanvas
        pages={home.pages.map((p) => ({ id: p.id, title: p.title }))}
        tiles={tiles}
        activePageId={activePageId}
        busy={busy}
        chats={chats.map((c) => ({
          id: c.id,
          title: c.title,
          memberHandles: c.memberHandles,
        }))}
        chatHref={(chatId) => `/chat?chat=${chatId}`}
        chatsHref="/chat"
        Link={Link}
        onSelectPage={(pageId) => {
          void navigate({ search: { page: pageId } })
        }}
        onNewPage={(title) => {
          void newPage(title)
        }}
        onRenamePage={(pageId, title) => {
          void act(() => renameHomeCanvasPage({ data: { pageId, title } }))
        }}
        onRemovePage={(pageId) => {
          void act(() => removeHomeCanvasPage({ data: { pageId } }))
        }}
        onPinChat={(chatId) => {
          if (!activePageId) return
          void act(() =>
            pinHomeCanvasTile({ data: { pageId: activePageId, chatId } }),
          )
        }}
        onMoveTile={(tileId, box) => {
          void act(() => moveHomeCanvasTile({ data: { tileId, ...box } }))
        }}
        onUnpinTile={(tileId) => {
          void act(() => unpinHomeCanvasTile({ data: { tileId } }))
        }}
        onAnswerWidget={(widgetId, value) => {
          // Chat's OWN answer door, not a home one: an answer from here is the
          // same ordinary chat message it would be from the stack or the canvas.
          // The invalidate is PART of the action so `busy` stays on until the
          // answered tile has actually changed — otherwise the buttons re-arm
          // for the few dozen milliseconds the refetch is in flight and a thumb
          // goes straight through them.
          void run(async () => {
            await answerChatWidget({ data: { widgetId, value } })
            await router.invalidate()
          })
        }}
      />
    </Dock>
  )
}
