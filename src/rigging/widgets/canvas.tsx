import { useCallback, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpToLine,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'

import {
  CANVAS_COLUMNS,
  clampCanvasBox,
  type CanvasBox,
} from '@hull/chat/widgets'
import { useIsMobile } from '@rigging/lib/use-is-mobile'
import { useShipLog, type EventSourceFactory } from '@rigging/lib/use-ship-log'
import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'

import { useAnswerGuard } from './answer-guard'
import { TAP_TARGET } from './kind'
import { resolveWidget } from './registry'
import type { WidgetItem } from './stack'

/**
 * The **canvas**: the chat's spatial surface. Pages of tiles the crew arranged
 * and keep coming back to — the app you and these people built for this task,
 * sitting beside the conversation rather than replacing it.
 *
 * It is the state-shaped half of the pair. The stack above the composer is
 * turn-shaped: something an agent needs from you right now, gone once you answer
 * it. A canvas widget is a readout you put somewhere and expect to find again.
 * Same rows, same catalog, same live transport — only `placement` differs.
 *
 * **Two layouts, one arrangement.** On a desktop pane the page is a grid you
 * arrange: drag a tile by its title, resize it from its corner, or nudge it with
 * the arrow keys. On a phone the exact same page is ONE column in arrangement
 * order (top row first, then left to right — the order the service already reads
 * rows in), and there is no dragging or pinch-resizing at all, because both are
 * desktop idioms that fail under a thumb. You swipe or tap between pages instead.
 */

/** One page of the canvas, as the view shows it. */
export interface CanvasPageItem {
  id: string
  title: string
}

/** A widget arranged on a page: the stack's item plus where it sits. */
export interface CanvasWidgetItem extends WidgetItem, CanvasBox {
  pageId: string
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
  eventSourceFactory?: EventSourceFactory
}

/** Row height and gutter in px — the grid's own units, and the drag maths'. */
const ROW_PX = 104
const GAP_PX = 8

/**
 * The cell a pointer is over, from the grid's own box. Returns null when the
 * grid has no width yet (an unlaid-out or jsdom element), because a zero-width
 * grid would divide every column into nothing and slam the tile to 0,0.
 */
export function cellAt(
  rect: { left: number; top: number; width: number },
  point: { clientX: number; clientY: number },
  scrollTop: number,
): { gridX: number; gridY: number } | null {
  if (rect.width <= 0) return null
  const colPx = (rect.width + GAP_PX) / CANVAS_COLUMNS
  return {
    gridX: Math.floor((point.clientX - rect.left) / colPx),
    gridY: Math.floor(
      (point.clientY - rect.top + scrollTop) / (ROW_PX + GAP_PX),
    ),
  }
}

/**
 * Where an arrow key sends a tile. Plain arrows move it a cell; with shift they
 * grow or shrink it. Clamped like every other write, so a held key parks the tile
 * against an edge instead of walking it out of the grid.
 *
 * This exists because a drag handle is unusable without a mouse — and it's also
 * the honest way to test arrangement, since a drag needs a laid-out box.
 */
export function nudge(
  box: CanvasBox,
  key: string,
  resize: boolean,
): CanvasBox | null {
  const delta: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }
  const step = delta[key] as [number, number] | undefined
  if (!step) return null
  const moved = resize
    ? { ...box, gridW: box.gridW + step[0], gridH: box.gridH + step[1] }
    : { ...box, gridX: box.gridX + step[0], gridY: box.gridY + step[1] }
  return clampCanvasBox(moved)
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
  eventSourceFactory,
}: WidgetCanvasProps) {
  const isMobile = useIsMobile()
  // The same guard the stack holds, for the same reason: these are the same
  // rows and the same door, so a double tap has to mean the same thing here.
  const answers = useAnswerGuard(busy)
  const activePage = pages.find((p) => p.id === activePageId) ?? pages.at(0)
  const onPage = useMemo(
    () => widgets.filter((w) => w.pageId === activePage?.id),
    [widgets, activePage?.id],
  )

  // One subscription for the whole page, over the union of its tiles' topics —
  // the same shape the stack uses, and for the same reason: one EventSource,
  // never one per widget, and no polling anywhere.
  const topics = [
    ...new Set(
      onPage.flatMap((widget) => {
        const resolution = resolveWidget(widget.kind, widget.props)
        return resolution.ok ? resolution.view.topics : []
      }),
    ),
  ]
  const [revision, setRevision] = useState(0)
  const onEvent = useCallback(() => {
    setRevision((n) => n + 1)
  }, [])
  useShipLog(topics, onEvent, eventSourceFactory)

  function answer(widgetId: string, value: string) {
    answers.mark(widgetId)
    onAnswerWidget(widgetId, value)
  }

  function step(by: number) {
    if (!activePage) return
    const at = pages.findIndex((p) => p.id === activePage.id)
    const next = pages.at((at + by) % pages.length)
    if (next && next.id !== activePage.id) onSelectPage(next.id)
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
        <MobilePage
          widgets={onPage}
          revision={revision}
          spent={answers.spent}
          onStackWidget={onStackWidget}
          onAnswerWidget={answer}
          onSwipe={step}
        />
      ) : (
        <DesktopPage
          pageId={activePage.id}
          widgets={onPage}
          revision={revision}
          spent={answers.spent}
          onPlaceWidget={onPlaceWidget}
          onStackWidget={onStackWidget}
          onAnswerWidget={answer}
        />
      )}
    </section>
  )
}

/**
 * The page tabs. Horizontally scrollable and thumb-sized, so a phone tabs
 * between pages with the same control a desktop clicks — no separate mobile
 * navigation to keep in step.
 */
function PageStrip({
  pages,
  activeId,
  busy,
  onSelectPage,
  onNewPage,
  onRenamePage,
  onRemovePage,
}: {
  pages: CanvasPageItem[]
  activeId?: string
  busy: boolean
  onSelectPage: (id: string) => void
  onNewPage: (title: string) => void
  onRenamePage: (id: string, title: string) => void
  onRemovePage: (id: string) => void
}) {
  const active = pages.find((p) => p.id === activeId)
  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-2">
      <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
        {pages.map((page) => (
          <button
            key={page.id}
            type="button"
            aria-current={page.id === activeId}
            onClick={() => {
              onSelectPage(page.id)
            }}
            className={cn(
              'shrink-0 whitespace-nowrap rounded-t-md border-b-2 px-3 text-sm',
              TAP_TARGET,
              page.id === activeId
                ? 'border-primary font-medium'
                : 'border-transparent text-muted-foreground',
            )}
          >
            {page.title}
          </button>
        ))}
      </div>
      {active && (
        <>
          {/* An icon, not the word: on a 390px phone the page tabs and these
              controls share one row, and "Rename" spelled out cost the tab
              strip about a page-name's worth of width. */}
          <button
            type="button"
            aria-label={`Rename page ${active.title}`}
            onClick={() => {
              const title = window.prompt('Page name', active.title)
              if (title?.trim()) onRenamePage(active.id, title.trim())
            }}
            className={cn(
              'shrink-0 px-2 text-muted-foreground hover:text-foreground',
              TAP_TARGET,
            )}
          >
            <Pencil className="size-4" />
          </button>
          <button
            type="button"
            aria-label={`Remove page ${active.title}`}
            onClick={() => {
              onRemovePage(active.id)
            }}
            className={cn(
              'shrink-0 px-2 text-muted-foreground hover:text-destructive',
              TAP_TARGET,
            )}
          >
            <Trash2 className="size-4" />
          </button>
        </>
      )}
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={busy}
        aria-label="Add a page"
        onClick={() => {
          askForPage(onNewPage, `Page ${String(pages.length + 1)}`)
        }}
      >
        <Plus className="size-4" />
      </Button>
    </div>
  )
}

/**
 * Ask for a page name and pass it up, or do nothing. One helper so the two
 * places you can add a page (the strip's `+`, the empty state's button) can't
 * drift into asking differently.
 */
function askForPage(onNewPage: (title: string) => void, suggestion: string) {
  const title = window.prompt('Name the new page', suggestion)
  if (title?.trim()) onNewPage(title.trim())
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

/**
 * The phone layout: one column, in arrangement order, with a horizontal swipe
 * between pages. No drag targets and no resize handles — a 44px thumb cannot
 * place a tile in a four-column grid, and pretending otherwise is how a
 * "responsive" canvas becomes unusable on the device it matters most on.
 */
function MobilePage({
  widgets,
  revision,
  spent,
  onStackWidget,
  onAnswerWidget,
  onSwipe,
}: {
  widgets: CanvasWidgetItem[]
  revision: number
  spent: (id: string) => boolean
  onStackWidget: (id: string) => void
  onAnswerWidget: (id: string, value: string) => void
  onSwipe: (by: number) => void
}) {
  const start = useRef<{ x: number; y: number } | null>(null)
  return (
    <div
      data-testid="canvas-column"
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-3"
      onPointerDown={(e) => {
        start.current = { x: e.clientX, y: e.clientY }
      }}
      onPointerUp={(e) => {
        const from = start.current
        start.current = null
        if (!from) return
        const dx = e.clientX - from.x
        // Horizontal-dominant only, or every scroll would flick the page over.
        if (
          Math.abs(dx) > 60 &&
          Math.abs(dx) > Math.abs(e.clientY - from.y) * 2
        )
          onSwipe(dx < 0 ? 1 : -1)
      }}
    >
      <div className="flex flex-col gap-3">
        {widgets.length === 0 && <PageEmpty />}
        {widgets.map((widget) => (
          <CanvasTile
            key={widget.id}
            widget={widget}
            revision={revision}
            spent={spent(widget.id)}
            onStack={() => {
              onStackWidget(widget.id)
            }}
            onAnswer={(value) => {
              onAnswerWidget(widget.id, value)
            }}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * The desktop layout: a real grid you arrange. A tile is dragged by its title
 * bar and resized from its bottom-right corner with the pointer; both also work
 * from the keyboard (arrows to move, shift+arrows to resize) on the focused
 * title bar, which is what makes the surface usable without a mouse.
 *
 * No drag library. The whole interaction is "which cell is the pointer over",
 * which CSS grid already answers from one `getBoundingClientRect` — a dependency
 * would buy animation polish in exchange for a layout engine we'd have to keep
 * in step with the two clamped writes the server does anyway.
 */
function DesktopPage({
  pageId,
  widgets,
  revision,
  spent,
  onPlaceWidget,
  onStackWidget,
  onAnswerWidget,
}: {
  pageId: string
  widgets: CanvasWidgetItem[]
  revision: number
  spent: (id: string) => boolean
  onPlaceWidget: (id: string, box: CanvasBox & { pageId: string }) => void
  onStackWidget: (id: string) => void
  onAnswerWidget: (id: string, value: string) => void
}) {
  const gridRef = useRef<HTMLDivElement>(null)
  // The tile being dragged or resized, at the cell the pointer is currently
  // over. Local until pointerup: the row is written once, when you let go, so a
  // drag across the pane isn't twenty round trips.
  const [preview, setPreview] = useState<
    | ({
        id: string
        mode: 'move' | 'resize'
        grabX: number
        grabY: number
      } & CanvasBox)
    | null
  >(null)

  function pointerCell(e: { clientX: number; clientY: number }) {
    const grid = gridRef.current
    if (!grid) return null
    return cellAt(grid.getBoundingClientRect(), e, grid.scrollTop)
  }

  function commit(box: CanvasBox & { id: string }) {
    onPlaceWidget(box.id, {
      pageId,
      gridX: box.gridX,
      gridY: box.gridY,
      gridW: box.gridW,
      gridH: box.gridH,
    })
  }

  return (
    <div
      ref={gridRef}
      data-testid="canvas-grid"
      className="min-h-0 flex-1 overflow-y-auto p-3"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${String(CANVAS_COLUMNS)}, minmax(0, 1fr))`,
        gridAutoRows: `${String(ROW_PX)}px`,
        gap: `${String(GAP_PX)}px`,
        alignContent: 'start',
      }}
      onPointerMove={(e) => {
        if (!preview) return
        const cell = pointerCell(e)
        if (!cell) return
        setPreview(
          preview.mode === 'move'
            ? {
                ...preview,
                ...clampCanvasBox({
                  ...preview,
                  gridX: cell.gridX - preview.grabX,
                  gridY: cell.gridY - preview.grabY,
                }),
              }
            : {
                ...preview,
                ...clampCanvasBox({
                  ...preview,
                  gridW: cell.gridX - preview.gridX + 1,
                  gridH: cell.gridY - preview.gridY + 1,
                }),
              },
        )
      }}
      onPointerUp={() => {
        if (preview) commit(preview)
        setPreview(null)
      }}
      onPointerCancel={() => {
        setPreview(null)
      }}
    >
      {widgets.length === 0 && (
        <div style={{ gridColumn: `1 / span ${String(CANVAS_COLUMNS)}` }}>
          <PageEmpty />
        </div>
      )}
      {widgets.map((widget) => {
        const box: CanvasBox = preview?.id === widget.id ? preview : widget
        return (
          <div
            key={widget.id}
            style={{
              gridColumn: `${String(box.gridX + 1)} / span ${String(box.gridW)}`,
              gridRow: `${String(box.gridY + 1)} / span ${String(box.gridH)}`,
            }}
            className={cn('min-w-0', preview?.id === widget.id && 'opacity-70')}
          >
            <CanvasTile
              widget={widget}
              revision={revision}
              spent={spent(widget.id)}
              onStack={() => {
                onStackWidget(widget.id)
              }}
              onAnswer={(value) => {
                onAnswerWidget(widget.id, value)
              }}
              onGrab={(e, mode) => {
                const cell = pointerCell(e)
                setPreview({
                  id: widget.id,
                  mode,
                  grabX: cell ? cell.gridX - widget.gridX : 0,
                  grabY: cell ? cell.gridY - widget.gridY : 0,
                  gridX: widget.gridX,
                  gridY: widget.gridY,
                  gridW: widget.gridW,
                  gridH: widget.gridH,
                })
              }}
              onNudge={(key, resize) => {
                const moved = nudge(widget, key, resize)
                if (moved) commit({ id: widget.id, ...moved })
              }}
            />
          </div>
        )
      })}
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
  onStack,
  onAnswer,
  onGrab,
  onNudge,
}: {
  widget: CanvasWidgetItem
  revision: number
  spent: boolean
  onStack: () => void
  onAnswer: (value: string) => void
  onGrab?: (
    e: { clientX: number; clientY: number },
    mode: 'move' | 'resize',
  ) => void
  onNudge?: (key: string, resize: boolean) => void
}) {
  // Memoised for the same load-bearing reason the stack memoises: `parse`
  // returns a fresh `Body` closure, and a new component identity would remount
  // the body — throwing away a live kind's fetched contents on every render.
  const resolution = useMemo(
    () => resolveWidget(widget.kind, widget.props),
    [widget.kind, widget.props],
  )

  const grip = onGrab ? (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Move ${resolution.ok ? resolution.view.headline : widget.kind}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        onGrab(e, 'move')
      }}
      onKeyDown={(e) => {
        if (!onNudge) return
        if (e.key.startsWith('Arrow')) {
          e.preventDefault()
          onNudge(e.key, e.shiftKey)
        }
      }}
      className="min-w-0 flex-1 cursor-grab truncate px-2 py-1 text-xs font-medium"
    >
      {resolution.ok ? resolution.view.headline : widget.kind}
    </div>
  ) : (
    <div className="min-w-0 flex-1 truncate px-2 py-1 text-xs font-medium">
      {resolution.ok ? resolution.view.headline : widget.kind}
    </div>
  )

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-lg border bg-background">
      <div className="flex shrink-0 items-center border-b bg-muted/30">
        {grip}
        <button
          type="button"
          aria-label={`Send widget ${widget.id} to the stack`}
          onClick={onStack}
          className={cn(
            'shrink-0 px-2 py-1 text-muted-foreground hover:text-foreground',
            // No grip means the phone layout, where this is the tile's ONLY
            // control and has to be thumb-sized. On a desktop pane it stays
            // dense: a 44px header on a 104px row is most of the tile.
            !onGrab && cn('px-4', TAP_TARGET),
          )}
        >
          <ArrowUpToLine className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {resolution.ok ? (
          <resolution.view.Body
            revision={revision}
            onAnswer={onAnswer}
            spent={spent}
          />
        ) : (
          <p className="flex items-start gap-1 p-2 text-xs text-muted-foreground">
            <AlertTriangle className="size-4 shrink-0" />
            {resolution.fault === 'unknown-kind'
              ? 'This ship doesn’t know this widget kind'
              : 'These props don’t parse'}
            : {resolution.detail}
          </p>
        )}
      </div>
      {onGrab && (
        // The resize corner. Pointer-only on purpose: shift+arrows on the title
        // bar is the keyboard path, and a phone gets neither (see MobilePage).
        <div
          role="button"
          tabIndex={-1}
          aria-label={`Resize widget ${widget.id}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            onGrab(e, 'resize')
          }}
          className="absolute bottom-0 right-0 flex size-4 cursor-se-resize items-end justify-end text-[10px] leading-none text-muted-foreground"
        >
          ◢
        </div>
      )}
    </div>
  )
}
