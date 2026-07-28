import { useState, type ComponentType, type ReactNode } from 'react'
import { ArrowUpRight, EyeOff, Plus, X } from 'lucide-react'

import type { CanvasBox } from '@hull/chat/widgets'
import type { HomeTileTarget } from '@hull/home-canvas/service'
import { TAP_TARGET } from '@rigging/lib/tap-target'
import { useIsMobile } from '@rigging/lib/use-is-mobile'
import type { EventSourceFactory } from '@rigging/lib/use-ship-log'
import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'

import { useAnswerGuard } from './answer-guard'
import {
  ArrangeableGrid,
  askForPage,
  PageStrip,
  phoneTileCapPx,
  SwipeColumn,
  TileFrame,
  usePages,
  type GridHandles,
  type GridPage,
} from './grid'
import { resolveWidget } from './registry'
import { ResolvedWidgetBody } from './resolved-widget-body'
import { useWidgetLiveRevision } from './use-widget-live-revision'

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
  /**
   * Where "go and find a conversation" goes. The empty home is the first screen
   * anybody sees, and telling somebody to pin a chat when they have none is a
   * dead end — so the empty states link out to where chats are made.
   */
  chatsHref: string
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
  chatsHref,
  Link,
  eventSourceFactory,
}: HomeCanvasProps) {
  const isMobile = useIsMobile()
  const answers = useAnswerGuard(busy)
  const [picking, setPicking] = useState(false)
  const { activePage, onPage, step } = usePages(
    pages,
    activePageId,
    tiles,
    onSelectPage,
  )

  // One subscription for the page, over the union of the kinds' own topics —
  // the same machinery the stack and the chat canvas hold. The CHAT topics (a
  // raise landing in a pointed-at conversation) are the host's: they need a
  // reload of the resolved tiles, not just a redraw, so the route owns them.
  const revision = useWidgetLiveRevision(
    onPage.flatMap((tile) =>
      tile.target.mode === 'lost' || !tile.target.widget
        ? []
        : [tile.target.widget],
    ),
    eventSourceFactory,
  )

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
      {/* No pages means the very first screen a crew member ever sees, and a
          bare strip holding one lonely `+` above an empty state that already
          says "Make a page" is two ways to do the same thing, on the one screen
          that has to read as welcoming rather than unfinished. */}
      {pages.length > 0 && (
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
      )}
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
        <Empty
          onNewPage={onNewPage}
          busy={busy}
          hasChats={chats.length > 0}
          chatsHref={chatsHref}
          Link={Link}
        />
      ) : isMobile ? (
        <SwipeColumn testId="home-column" onSwipe={step}>
          {onPage.length === 0 && (
            <PageEmpty
              hasChats={chats.length > 0}
              chatsHref={chatsHref}
              Link={Link}
            />
          )}
          {onPage.map((item) => (
            <div key={item.id}>{tile(item)}</div>
          ))}
        </SwipeColumn>
      ) : (
        <ArrangeableGrid
          items={onPage}
          testId="home-grid"
          empty={
            <PageEmpty
              hasChats={chats.length > 0}
              chatsHref={chatsHref}
              Link={Link}
            />
          }
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
            No conversations yet. Start one from Chats and it can live here.
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

/**
 * A home with no pages at all — which, since this became the front door, is the
 * **first screen a crew member ever sees**. It has one job above all others: to
 * read as a ship waiting for you rather than a ship that failed to load. So it
 * says what this surface is for in one sentence, gives the single next move a
 * button, and — when you have no conversations to put here yet — points at
 * where conversations are made instead of at a picker that would be empty.
 *
 * The rail is on screen the whole time, so nothing here is a dead end.
 */
function Empty({
  onNewPage,
  busy,
  hasChats,
  chatsHref,
  Link,
}: {
  onNewPage: (title: string) => void
  busy: boolean
  hasChats: boolean
  chatsHref: string
  Link: HomeLink
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-center">
      <div className="max-w-xs">
        <p className="text-sm font-medium">Your home screen is empty</p>
        <p className="mb-3 text-xs text-muted-foreground">
          This is where your conversations keep their live views. Whatever the
          crew needs from you turns up here — you answer with a thumb, and it
          lands in the chat as an ordinary message.
        </p>
        {hasChats ? (
          <Button
            className={TAP_TARGET}
            disabled={busy}
            onClick={() => {
              askForPage(onNewPage, 'Home')
            }}
          >
            <Plus className="size-4" />
            Make a page
          </Button>
        ) : (
          <Link
            to={chatsHref}
            className={cn(
              'inline-flex items-center gap-1 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground',
              TAP_TARGET,
            )}
          >
            <ArrowUpRight className="size-4" />
            Start a conversation
          </Link>
        )}
      </div>
    </div>
  )
}

/** A page you made with nothing on it yet — the same job, one step further in. */
function PageEmpty({
  hasChats,
  chatsHref,
  Link,
}: {
  hasChats: boolean
  chatsHref: string
  Link: HomeLink
}) {
  return (
    <div className="p-4 text-center text-xs text-muted-foreground">
      {hasChats ? (
        <p>
          Nothing on this page yet. Put a conversation on it with the{' '}
          <span className="font-medium text-foreground">Tile</span> button
          above.
        </p>
      ) : (
        <p>
          Nothing on this page yet, and no conversations to put on it —{' '}
          <Link to={chatsHref} className="font-medium underline">
            start one
          </Link>{' '}
          and it can live here.
        </p>
      )}
    </div>
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
  // A const, so the narrowing survives into the answer closure below.
  const widget = target.mode === 'lost' ? null : target.widget
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
    <TileFrame
      headline={headline}
      handles={handles}
      actions={unpin}
      // No grip means the phone column, which sizes nothing — so the tile takes
      // the height its arrangement asked for rather than however tall eighteen
      // documents happen to be. A desktop grid cell already bounds it.
      capPx={handles ? undefined : phoneTileCapPx(tile.gridH)}
      footer={
        target.mode === 'lost' ? undefined : (
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
        )
      }
    >
      {target.mode === 'lost' ? (
        <Lost />
      ) : widget ? (
        <ResolvedWidgetBody
          widget={widget}
          revision={revision}
          spent={spent(widget.id)}
          onAnswer={(value) => {
            onAnswer(widget.id, value)
          }}
        />
      ) : (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Nothing raised right now. This tile shows whatever this conversation
          next needs from you.
        </p>
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
