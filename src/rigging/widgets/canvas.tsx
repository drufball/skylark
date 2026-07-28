import { ArrowUpToLine, Home, Plus } from 'lucide-react'

import type { CanvasBox } from '@hull/chat/widgets'
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
} from './grid'
import { resolveWidget } from './registry'
import { ResolvedWidgetBody } from './resolved-widget-body'
import { useWidgetLiveRevision } from './use-widget-live-revision'
import type { WidgetItem } from './stack'

/**
 * The **canvas**: the chat's spatial surface. Pages of tiles the crew arranged
 * and keep coming back to — the app you and these people built for this task,
 * sitting beside the conversation rather than replacing it.
 *
 * It is the state-shaped half of the pair. The stack above the composer is
 * turn-shaped: something an agent needs from you right now, gone once you answer
 * it. A canvas widget is a readout you put somewhere and expect to find again —
 * and, since #cse6, an answered choice STAYS here and shows the decision it
 * recorded, because on a spatial surface an answered question is state, not a
 * spent turn (the rule itself is the hull's: `answerDismisses`).
 *
 * The page behaviour — the strip, the desktop grid, the phone's column — is
 * `grid.tsx`, shared with the home canvas. What's left here is what a CHAT tile
 * means: a widget row, resolved through the catalog.
 */

/** One page of the canvas, as the view shows it. */
export interface CanvasPageItem {
  id: string
  title: string
}

/** A widget arranged on a page: the stack's item plus where it sits. */
export interface CanvasWidgetItem extends WidgetItem, CanvasBox {
  pageId: string
  /** The decision recorded on this tile, or null if it hasn't been answered. */
  answerValue: string | null
}

export interface WidgetCanvasProps {
  pages: CanvasPageItem[]
  /** Every canvas widget in the chat, all pages at once — switching is instant. */
  widgets: CanvasWidgetItem[]
  /**
   * The page THIS viewer has open. Per person, never per chat: the host persists
   * it against (chat, user) so a reload lands you back on it, and nobody else's
   * view moves when yours does.
   */
  activePageId: string | null
  busy: boolean
  onSelectPage: (pageId: string) => void
  /** Add a page. The view asks for the name, so both entry points agree on it. */
  onNewPage: (title: string) => void
  onRenamePage: (pageId: string, title: string) => void
  onRemovePage: (pageId: string) => void
  /** Commit an arrangement — a drag, a resize, or an arrow-key nudge. */
  onPlaceWidget: (widgetId: string, box: CanvasBox & { pageId: string }) => void
  /** Take a tile off the canvas, back to the stack above the composer. */
  onStackWidget: (widgetId: string) => void
  onAnswerWidget: (widgetId: string, value: string) => void
  /**
   * Pin this widget onto the viewer's own home canvas — a POINTER at it, not a
   * copy. Omitted when the host has no home surface wired up.
   */
  onPinHome?: (widgetId: string) => void
  eventSourceFactory?: EventSourceFactory
}

export function WidgetCanvas({
  pages,
  widgets,
  activePageId,
  busy,
  onSelectPage,
  onNewPage,
  onRenamePage,
  onRemovePage,
  onPlaceWidget,
  onStackWidget,
  onAnswerWidget,
  onPinHome,
  eventSourceFactory,
}: WidgetCanvasProps) {
  const isMobile = useIsMobile()
  // The same guard the stack holds, for the same reason: these are the same
  // rows and the same door, so a double tap has to mean the same thing here.
  const answers = useAnswerGuard(busy)
  const { activePage, onPage, step } = usePages(
    pages,
    activePageId,
    widgets,
    onSelectPage,
  )

  // One subscription for the whole page, over the union of its tiles' topics —
  // the same machinery the stack holds, and for the same reason: one
  // EventSource, never one per widget, and no polling anywhere.
  const revision = useWidgetLiveRevision(onPage, eventSourceFactory)

  function answer(widgetId: string, value: string) {
    answers.mark(widgetId)
    onAnswerWidget(widgetId, value)
  }

  function tile(widget: CanvasWidgetItem, handles?: GridHandles) {
    return (
      <CanvasTile
        widget={widget}
        revision={revision}
        spent={answers.spent(widget.id)}
        handles={handles}
        onStack={() => {
          onStackWidget(widget.id)
        }}
        onPinHome={
          onPinHome &&
          (() => {
            onPinHome(widget.id)
          })
        }
        onAnswer={(value) => {
          answer(widget.id, value)
        }}
      />
    )
  }

  return (
    <section
      data-testid="widget-canvas"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <PageStrip
        pages={pages}
        activeId={activePage?.id}
        busy={busy}
        onSelectPage={onSelectPage}
        onNewPage={onNewPage}
        onRenamePage={onRenamePage}
        onRemovePage={onRemovePage}
      />
      {!activePage ? (
        <Empty onNewPage={onNewPage} busy={busy} />
      ) : isMobile ? (
        <SwipeColumn testId="canvas-column" onSwipe={step}>
          {onPage.length === 0 && <PageEmpty />}
          {onPage.map((widget) => (
            <div key={widget.id}>{tile(widget)}</div>
          ))}
        </SwipeColumn>
      ) : (
        <ArrangeableGrid
          items={onPage}
          testId="canvas-grid"
          empty={<PageEmpty />}
          onPlace={(widgetId, box) => {
            onPlaceWidget(widgetId, { pageId: activePage.id, ...box })
          }}
          renderTile={tile}
        />
      )}
    </section>
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
        <p className="text-sm font-medium">No canvas yet</p>
        <p className="mb-3 text-xs text-muted-foreground">
          A page is somewhere to keep the readouts and controls this chat is
          about, so you don’t have to ask for them again.
        </p>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            askForPage(onNewPage, 'Page 1')
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
      Nothing on this page yet. Send a widget here from the stack, or ask an
      agent to put one up.
    </p>
  )
}

/**
 * One tile. Unlike a stack tile it is **open by default** — a canvas widget is a
 * readout you arranged precisely so you could see it without tapping, so a
 * collapsed one would defeat the surface. It knows no kind by name: every row
 * goes through `resolveWidget`, and the two honest failure tiles are the same
 * designed states the stack shows.
 */
function CanvasTile({
  widget,
  revision,
  spent,
  handles,
  onStack,
  onPinHome,
  onAnswer,
}: {
  widget: CanvasWidgetItem
  revision: number
  spent: boolean
  handles?: GridHandles
  onStack: () => void
  onPinHome?: () => void
  onAnswer: (value: string) => void
}) {
  // Only the headline is read here — the body itself is `ResolvedWidgetBody`,
  // which owns the load-bearing memoisation of the resolve.
  const resolution = resolveWidget(widget.kind, widget.props)
  const headline = resolution.ok ? resolution.view.headline : widget.kind

  // No grip means the phone layout, where these are the tile's ONLY controls
  // and have to be thumb-sized. On a desktop pane they stay dense: a 44px
  // header on a 104px row is most of the tile.
  const button = cn(
    'shrink-0 px-2 py-1 text-muted-foreground hover:text-foreground',
    !handles && cn('px-4', TAP_TARGET),
  )

  return (
    <TileFrame
      headline={headline}
      handles={handles}
      // No grip means the phone column, which bounds nothing of its own — so the
      // tile takes the height its arrangement asked for. A desktop grid cell
      // already does that job.
      capPx={handles ? undefined : phoneTileCapPx(widget.gridH)}
      actions={
        <>
          {onPinHome && (
            <button
              type="button"
              aria-label={`Pin ${headline} to your home`}
              onClick={onPinHome}
              className={button}
            >
              <Home className="size-4" />
            </button>
          )}
          <button
            type="button"
            aria-label={`Send ${headline} to the stack`}
            onClick={onStack}
            className={button}
          >
            <ArrowUpToLine className="size-4" />
          </button>
        </>
      }
    >
      <ResolvedWidgetBody
        widget={widget}
        revision={revision}
        spent={spent}
        onAnswer={onAnswer}
      />
    </TileFrame>
  )
}
