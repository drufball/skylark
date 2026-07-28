import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
} from 'react'
import { AlertTriangle, ArrowUpRight, EyeOff, Plus, X } from 'lucide-react'

import type { CanvasBox } from '@hull/chat/widgets'
import type { HomeTileTarget } from '@hull/home-canvas/service'
import { useIsMobile } from '@rigging/lib/use-is-mobile'
import { useShipLog, type EventSourceFactory } from '@rigging/lib/use-ship-log'
import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'

import { useAnswerGuard } from './answer-guard'
import {
  ArrangeableGrid,
  askForPage,
  PageStrip,
  SwipeColumn,
  TileFrame,
  type GridHandles,
  type GridPage,
} from './grid'
import { TAP_TARGET } from './kind'
import { resolveWidget } from './registry'

/**
 * The **home canvas**: your own screen, and the one surface in the ship that
 * holds pointers instead of things.
 *
 * A widget instance always lives in exactly one chat. A tile here is a
 * *placement* pointing at one — the iOS model, where your home screen holds live
 * views onto apps whose real home is elsewhere. Two pointer modes: at one
 * specific widget (stable), or at a **chat** (live — whatever is at the top of
 * its stack right now). The second is the point of the whole product: an agent
 * raises a question in a conversation and it lands on your home screen, and you
 * answer it with a thumb without ever opening the chat.
 *
 * **A tile renders only if the server said it could.** This component never
 * decides access; it draws what `readHomeCanvas` resolved from the viewer's
 * CURRENT chat membership. A pointer whose chat you've left arrives as
 * `{ mode: 'lost' }` carrying nothing at all, and shows an honest placeholder —
 * safe here, and only here, because a home canvas is personal (see the zine).
 *
 * The page behaviour is `grid.tsx`, shared with the chat canvas.
 */

/** A tile as the view draws it: a box, and whatever the server resolved it to. */
export interface HomeTileItem extends CanvasBox {
  id: string
  pageId: string
  target: HomeTileTarget
}

/** A chat you could pin, as the picker lists it. */
export interface HomePinnableChat {
  id: string
  title: string | null
  memberHandles: string[]
}

/** A navigation link, injected so this view doesn't depend on a router. */
export type HomeLink = ComponentType<{
  to: string
  className?: string
  'aria-label'?: string
  children: ReactNode
}>

export interface HomeCanvasProps {
  pages: GridPage[]
  tiles: HomeTileItem[]
  activePageId: string | null
  busy: boolean
  onSelectPage: (pageId: string) => void
  onNewPage: (title: string) => void
  onRenamePage: (pageId: string, title: string) => void
  onRemovePage: (pageId: string) => void
  onMoveTile: (tileId: string, box: CanvasBox & { pageId: string }) => void
  onUnpinTile: (tileId: string) => void
  /**
   * Answer the widget a tile is showing. The host wires this to chat's OWN
   * answer door — the same one the stack and the canvas call — so an answer
   * from home is an ordinary chat message in the owning chat and nothing else.
   */
  onAnswerWidget: (widgetId: string, value: string) => void
  /** The chats this person could pin, for the picker. */
  chats: HomePinnableChat[]
  onPinChat: (chatId: string) => void
  /** Where a tile's "open the chat" link goes. */
  chatHref: (chatId: string) => string
  Link: HomeLink
  eventSourceFactory?: EventSourceFactory
}

/** A chat's display name: its title, or the members it's with. */
export function homeChatName(chat: {
  title: string | null
  memberHandles: string[]
}): string {
  if (chat.title) return chat.title
  return chat.memberHandles.length > 0
    ? chat.memberHandles.map((h) => `@${h}`).join(', ')
    : 'New chat'
}

/** The line a tile's title bar shows — what's IN it, not where it lives. */
export function homeTileHeadline(target: HomeTileTarget): string {
  if (target.mode === 'lost') return 'No longer available'
  if (target.widget) {
    const resolution = resolveWidget(target.widget.kind, target.widget.props)
    if (resolution.ok) return resolution.view.headline
    return target.widget.kind
  }
  return homeChatName(target.chat)
}

export function HomeCanvas({
  pages,
  tiles,
  activePageId,
  busy,
  onSelectPage,
  onNewPage,
  onRenamePage,
  onRemovePage,
  onMoveTile,
  onUnpinTile,
  onAnswerWidget,
  chats,
  onPinChat,
  chatHref,
  Link,
  eventSourceFactory,
}: HomeCanvasProps) {
  const isMobile = useIsMobile()
  const answers = useAnswerGuard(busy)
  const [picking, setPicking] = useState(false)
  const activePage = pages.find((p) => p.id === activePageId) ?? pages.at(0)
  const onPage = useMemo(
    () => tiles.filter((t) => t.pageId === activePage?.id),
    [tiles, activePage?.id],
  )

  // One subscription for the page, over the union of the kinds' own topics —
  // the same shape the stack and the chat canvas use. The CHAT topics (a raise
  // landing in a pointed-at conversation) are the host's: they need a reload of
  // the resolved tiles, not just a redraw, so the route owns them.
  const topics = [
    ...new Set(
      onPage.flatMap((tile) => {
        if (tile.target.mode === 'lost' || !tile.target.widget) return []
        const resolution = resolveWidget(
          tile.target.widget.kind,
          tile.target.widget.props,
        )
        return resolution.ok ? resolution.view.topics : []
      }),
    ),
  ]
  const [revision, setRevision] = useState(0)
  const onEvent = useCallback(() => {
    setRevision((n) => n + 1)
  }, [])
  useShipLog(topics, onEvent, eventSourceFactory)

  function step(by: number) {
    if (!activePage) return
    const at = pages.findIndex((p) => p.id === activePage.id)
    const next = pages.at((at + by) % pages.length)
    if (next && next.id !== activePage.id) onSelectPage(next.id)
  }

  function tile(item: HomeTileItem, handles?: GridHandles) {
    return (
      <HomeTile
        tile={item}
        revision={revision}
        spent={(widgetId) => answers.spent(widgetId)}
        handles={handles}
        chatHref={chatHref}
        Link={Link}
        onUnpin={() => {
          onUnpinTile(item.id)
        }}
        onAnswer={(widgetId, value) => {
          answers.mark(widgetId)
          onAnswerWidget(widgetId, value)
        }}
      />
    )
  }

  return (
    <section
      data-testid="home-canvas"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <PageStrip
        pages={pages}
        activeId={activePage?.id}
        busy={busy}
        onSelectPage={onSelectPage}
        onNewPage={onNewPage}
        onRenamePage={onRenamePage}
        onRemovePage={onRemovePage}
      >
        {activePage && (
          <Button
            variant="outline"
            size="sm"
            className={cn('shrink-0', TAP_TARGET)}
            disabled={busy}
            aria-label="Add a tile"
            onClick={() => {
              setPicking((open) => !open)
            }}
          >
            <Plus className="size-4" />
            Tile
          </Button>
        )}
      </PageStrip>
      {picking && activePage && (
        <ChatPicker
          chats={chats}
          busy={busy}
          onPick={(chatId) => {
            setPicking(false)
            onPinChat(chatId)
          }}
          onClose={() => {
            setPicking(false)
          }}
        />
      )}
      {!activePage ? (
        <Empty onNewPage={onNewPage} busy={busy} />
      ) : isMobile ? (
        <SwipeColumn testId="home-column" onSwipe={step}>
          {onPage.length === 0 && <PageEmpty />}
          {onPage.map((item) => (
            <div key={item.id}>{tile(item)}</div>
          ))}
        </SwipeColumn>
      ) : (
        <ArrangeableGrid
          items={onPage}
          testId="home-grid"
          empty={<PageEmpty />}
          onPlace={(tileId, box) => {
            onMoveTile(tileId, { pageId: activePage.id, ...box })
          }}
          renderTile={tile}
        />
      )}
    </section>
  )
}

/**
 * Pick a conversation to put on your home. Deliberately a list of CHATS rather
 * than of widgets: a chat pointer is live, so pinning one is a standing "show me
 * whatever this conversation needs from me" — the thing you actually want on a
 * home screen. Pinning one specific widget is the rarer, more deliberate move,
 * and its door is the pin button on that widget's own canvas tile.
 */
function ChatPicker({
  chats,
  busy,
  onPick,
  onClose,
}: {
  chats: HomePinnableChat[]
  busy: boolean
  onPick: (chatId: string) => void
  onClose: () => void
}) {
  return (
    <div className="shrink-0 border-b bg-muted/20 p-2">
      <div className="mb-1 flex items-center justify-between px-1">
        <p className="text-xs text-muted-foreground">
          Put a conversation on this page — it shows whatever it needs from you.
        </p>
        <button
          type="button"
          aria-label="Close the tile picker"
          onClick={onClose}
          className={cn(
            'shrink-0 px-2 text-muted-foreground hover:text-foreground',
            TAP_TARGET,
          )}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {chats.length === 0 && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No conversations yet. Start one from Chat and it can live here.
          </p>
        )}
        {chats.map((chat) => (
          <button
            key={chat.id}
            type="button"
            disabled={busy}
            onClick={() => {
              onPick(chat.id)
            }}
            className={cn(
              'flex items-center rounded-md border bg-background px-3 text-left text-sm hover:bg-accent',
              TAP_TARGET,
            )}
          >
            {homeChatName(chat)}
          </button>
        ))}
      </div>
    </div>
  )
}

function Empty({
  onNewPage,
  busy,
}: {
  onNewPage: (title: string) => void
  busy: boolean
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center">
      <div className="max-w-xs">
        <p className="text-sm font-medium">Your home is empty</p>
        <p className="mb-3 text-xs text-muted-foreground">
          Make a page, then put your conversations on it. Whatever they need
          from you turns up here — you answer with a thumb, and it lands in the
          chat as an ordinary message.
        </p>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            askForPage(onNewPage, 'Home')
          }}
        >
          <Plus className="size-4" />
          New page
        </Button>
      </div>
    </div>
  )
}

function PageEmpty() {
  return (
    <p className="p-4 text-center text-xs text-muted-foreground">
      Nothing on this page yet. Add a conversation with the Tile button above.
    </p>
  )
}

/**
 * One tile: a pointer, drawn. The title bar says what's IN it; the footer always
 * says which conversation it lives in and takes you there, because "which chat
 * does this thing belong to?" is the question a home screen makes people ask
 * constantly.
 */
function HomeTile({
  tile,
  revision,
  spent,
  handles,
  chatHref,
  Link,
  onUnpin,
  onAnswer,
}: {
  tile: HomeTileItem
  revision: number
  spent: (widgetId: string) => boolean
  handles?: GridHandles
  chatHref: (chatId: string) => string
  Link: HomeLink
  onUnpin: () => void
  onAnswer: (widgetId: string, value: string) => void
}) {
  const { target } = tile
  const headline = homeTileHeadline(target)
  const unpin = (
    <button
      type="button"
      aria-label={`Unpin ${headline} from your home`}
      onClick={onUnpin}
      className={cn(
        'shrink-0 px-2 py-1 text-muted-foreground hover:text-destructive',
        // No grip means the phone layout, where this is a thumb target. On a
        // desktop pane it stays dense: a 44px header on a 104px row is most of
        // the tile.
        !handles && cn('px-4', TAP_TARGET),
      )}
    >
      <X className="size-4" />
    </button>
  )

  return (
    <TileFrame headline={headline} handles={handles} actions={unpin}>
      {target.mode === 'lost' ? (
        <Lost />
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-auto">
            {target.widget ? (
              <TileBody
                widget={target.widget}
                revision={revision}
                spent={spent(target.widget.id)}
                onAnswer={onAnswer}
              />
            ) : (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                Nothing raised right now. This tile shows whatever this
                conversation next needs from you.
              </p>
            )}
          </div>
          <Link
            to={chatHref(target.chat.id)}
            aria-label={`Open the chat ${homeChatName(target.chat)}`}
            className={cn(
              'flex shrink-0 items-center gap-1 border-t px-3 text-xs',
              'text-muted-foreground hover:text-foreground',
              !handles && TAP_TARGET,
            )}
          >
            <span className="min-w-0 truncate">
              {homeChatName(target.chat)}
            </span>
            <ArrowUpRight className="size-3 shrink-0" />
          </Link>
        </div>
      )}
    </TileFrame>
  )
}

/**
 * The honest placeholder for a pointer you've lost access to. It names nothing
 * — not the chat, not the question — because the server sent nothing. On a
 * PERSONAL surface saying "there was something here" beats a tile silently
 * vanishing out of an arrangement you made; on a shared one it would not be
 * safe, and this is why home is the only place with pointers.
 */
function Lost() {
  return (
    <div className="flex h-full flex-col items-start gap-1 p-3 text-xs text-muted-foreground">
      <EyeOff className="size-4 shrink-0" />
      <p>You no longer have access to this.</p>
      <p>Unpin it, or ask to be added back to the conversation.</p>
    </div>
  )
}

/** The widget a tile is showing, resolved through the catalog like anywhere else. */
function TileBody({
  widget,
  revision,
  spent,
  onAnswer,
}: {
  widget: {
    id: string
    kind: string
    props: unknown
    answerValue: string | null
  }
  revision: number
  spent: boolean
  onAnswer: (widgetId: string, value: string) => void
}) {
  // Memoised for the load-bearing reason the other surfaces memoise: `parse`
  // returns a fresh `Body` closure, and a new component identity remounts the
  // body, throwing away a live kind's fetched contents on every render.
  const resolution = useMemo(
    () => resolveWidget(widget.kind, widget.props),
    [widget.kind, widget.props],
  )
  if (!resolution.ok) {
    return (
      <p className="flex items-start gap-1 p-2 text-xs text-muted-foreground">
        <AlertTriangle className="size-4 shrink-0" />
        {resolution.fault === 'unknown-kind'
          ? 'This ship doesn’t know this widget kind'
          : 'These props don’t parse'}
        : {resolution.detail}
      </p>
    )
  }
  return (
    <resolution.view.Body
      revision={revision}
      spent={spent}
      answer={widget.answerValue}
      onAnswer={(value) => {
        onAnswer(widget.id, value)
      }}
    />
  )
}
