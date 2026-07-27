import { useRef, useState, type ReactNode } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'

import {
  CANVAS_COLUMNS,
  clampCanvasBox,
  type CanvasBox,
} from '@hull/chat/widgets'
import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'

import { TAP_TARGET } from './kind'

/**
 * The layout engine both canvases share: pages of tiles you arrange.
 *
 * There are two of them now — a **chat**'s canvas, which contains its widgets
 * directly, and a **home** canvas, which holds pointers at widgets living in
 * chats. They differ entirely in what a tile MEANS and not at all in how a page
 * behaves, so the page behaviour lives here and each surface brings its own
 * tiles. A second layout engine kept "in step" with this one would be two
 * engines drifting.
 *
 * What's here: the page strip, the desktop grid with its drag/resize/keyboard
 * arrangement, the phone's single swipeable column, and the tile chrome. What
 * isn't: anything that knows a widget kind, a chat, or a pointer.
 *
 * The arithmetic itself is the HULL's (`clampCanvasBox` in `hull/chat/widgets`),
 * because the doors clamp with it and the browser draws from it — one home, so a
 * dragged tile and a stored row can't disagree.
 */

/** Row height and gutter in px — the grid's own units, and the drag maths'. */
const ROW_PX = 104
const GAP_PX = 8

/** Anything this engine can place: an identity and a box. */
export interface GridItem extends CanvasBox {
  id: string
}

/** One page, as a strip tab shows it. */
export interface GridPage {
  id: string
  title: string
}

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

/**
 * Ask for a page name and pass it up, or do nothing. One helper so the places
 * you can add a page (the strip's `+`, an empty state's button) can't drift into
 * asking differently.
 */
export function askForPage(
  onNewPage: (title: string) => void,
  suggestion: string,
): void {
  const title = window.prompt('Name the new page', suggestion)
  if (title?.trim()) onNewPage(title.trim())
}

/**
 * The page tabs. Horizontally scrollable and thumb-sized, so a phone tabs
 * between pages with the same control a desktop clicks — no separate mobile
 * navigation to keep in step.
 */
export function PageStrip({
  pages,
  activeId,
  busy,
  onSelectPage,
  onNewPage,
  onRenamePage,
  onRemovePage,
  children,
}: {
  pages: GridPage[]
  activeId?: string
  busy: boolean
  onSelectPage: (id: string) => void
  onNewPage: (title: string) => void
  onRenamePage: (id: string, title: string) => void
  onRemovePage: (id: string) => void
  /** Extra controls for the surface that owns the strip (home's "add a tile"). */
  children?: ReactNode
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
      {children}
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

/** What a tile gets so it can be dragged, resized, or nudged from the keyboard. */
export interface GridHandles {
  onGrab: (
    e: { clientX: number; clientY: number },
    mode: 'move' | 'resize',
  ) => void
  onNudge: (key: string, resize: boolean) => void
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
 *
 * A pointer drag is LOCAL until you let go, so a drag across the pane is one
 * write rather than twenty round trips.
 */
export function ArrangeableGrid<T extends GridItem>({
  items,
  testId,
  empty,
  onPlace,
  renderTile,
}: {
  items: T[]
  testId: string
  empty: ReactNode
  onPlace: (id: string, box: CanvasBox) => void
  renderTile: (item: T, handles: GridHandles) => ReactNode
}) {
  // The tile being dragged or resized, at the cell the pointer is currently
  // over. Local until pointerup, so a drag across the pane is one write.
  //
  // `grabX/grabY` — where inside the tile you took hold of it — are resolved on
  // the FIRST pointermove rather than at grab time, from `grabAt`. That's not a
  // nicety: working out which cell a point is in needs the grid's own box, and
  // the grab is raised by a child tile, where reading the grid element would be
  // a ref read during render. Every measurement below happens inside a real
  // event handler on the grid itself, off `e.currentTarget`.
  const [preview, setPreview] = useState<
    | ({
        id: string
        mode: 'move' | 'resize'
        grabAt: { clientX: number; clientY: number }
        grabX: number | null
        grabY: number | null
      } & CanvasBox)
    | null
  >(null)

  return (
    <div
      data-testid={testId}
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
        const grid = e.currentTarget
        const rect = grid.getBoundingClientRect()
        const cell = cellAt(rect, e, grid.scrollTop)
        if (!cell) return
        // First move of this drag: work out where inside the tile it was taken
        // hold of, from the point the grab recorded.
        const held = cellAt(rect, preview.grabAt, grid.scrollTop)
        const grabX = preview.grabX ?? (held ? held.gridX - preview.gridX : 0)
        const grabY = preview.grabY ?? (held ? held.gridY - preview.gridY : 0)
        const held0 = { ...preview, grabX, grabY }
        setPreview(
          preview.mode === 'move'
            ? {
                ...held0,
                ...clampCanvasBox({
                  ...held0,
                  gridX: cell.gridX - grabX,
                  gridY: cell.gridY - grabY,
                }),
              }
            : {
                ...held0,
                ...clampCanvasBox({
                  ...held0,
                  gridW: cell.gridX - preview.gridX + 1,
                  gridH: cell.gridY - preview.gridY + 1,
                }),
              },
        )
      }}
      onPointerUp={() => {
        if (preview) onPlace(preview.id, boxOf(preview))
        setPreview(null)
      }}
      onPointerCancel={() => {
        setPreview(null)
      }}
    >
      {items.length === 0 && (
        <div style={{ gridColumn: `1 / span ${String(CANVAS_COLUMNS)}` }}>
          {empty}
        </div>
      )}
      {items.map((item) => {
        const box: CanvasBox = preview?.id === item.id ? preview : item
        return (
          <div
            key={item.id}
            style={{
              gridColumn: `${String(box.gridX + 1)} / span ${String(box.gridW)}`,
              gridRow: `${String(box.gridY + 1)} / span ${String(box.gridH)}`,
            }}
            className={cn('min-w-0', preview?.id === item.id && 'opacity-70')}
          >
            {renderTile(item, {
              onGrab: (e, mode) => {
                setPreview({
                  id: item.id,
                  mode,
                  grabAt: { clientX: e.clientX, clientY: e.clientY },
                  grabX: null,
                  grabY: null,
                  ...boxOf(item),
                })
              },
              onNudge: (key, resize) => {
                const moved = nudge(item, key, resize)
                if (moved) onPlace(item.id, moved)
              },
            })}
          </div>
        )
      })}
    </div>
  )
}

/** Just the four box fields — never a spread of a richer object. */
function boxOf(box: CanvasBox): CanvasBox {
  return {
    gridX: box.gridX,
    gridY: box.gridY,
    gridW: box.gridW,
    gridH: box.gridH,
  }
}

/**
 * The phone layout: one column, in arrangement order, with a horizontal swipe
 * between pages. No drag targets and no resize handles — a 44px thumb cannot
 * place a tile in a four-column grid, and pretending otherwise is how a
 * "responsive" canvas becomes unusable on the device it matters most on.
 */
export function SwipeColumn({
  testId,
  onSwipe,
  children,
}: {
  testId: string
  onSwipe: (by: number) => void
  children: ReactNode
}) {
  const start = useRef<{ x: number; y: number } | null>(null)
  return (
    <div
      data-testid={testId}
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
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  )
}

/**
 * One tile's chrome: a title bar that doubles as the drag grip, whatever
 * controls the surface puts beside it, the body, and (on a desktop pane) the
 * resize corner.
 *
 * Every label here is built from the tile's **headline**, never its id. A row's
 * primary key read aloud — "Dismiss widget 019fa5b1-f0f1-…" — is a database
 * column escaping into the UI, and it's the one thing a screen reader user
 * would hear about a tile.
 */
export function TileFrame({
  headline,
  actions,
  handles,
  children,
}: {
  headline: string
  /** The surface's own buttons, at the right of the title bar. */
  actions?: ReactNode
  /** Desktop arrangement. Omitted on a phone, which has no drag or resize. */
  handles?: GridHandles
  children: ReactNode
}) {
  const grip = handles ? (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Move ${headline}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        handles.onGrab(e, 'move')
      }}
      onKeyDown={(e) => {
        if (e.key.startsWith('Arrow')) {
          e.preventDefault()
          handles.onNudge(e.key, e.shiftKey)
        }
      }}
      className="min-w-0 flex-1 cursor-grab truncate px-2 py-1 text-xs font-medium"
    >
      {headline}
    </div>
  ) : (
    <div className="min-w-0 flex-1 truncate px-2 py-1 text-xs font-medium">
      {headline}
    </div>
  )

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-lg border bg-background">
      <div className="flex shrink-0 items-center border-b bg-muted/30">
        {grip}
        {actions}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      {handles && (
        // The resize corner. Pointer-only on purpose: shift+arrows on the title
        // bar is the keyboard path, and a phone gets neither (see SwipeColumn).
        <div
          role="button"
          tabIndex={-1}
          aria-label={`Resize ${headline}`}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            handles.onGrab(e, 'resize')
          }}
          className="absolute bottom-0 right-0 flex size-4 cursor-se-resize items-end justify-end text-[10px] leading-none text-muted-foreground"
        >
          ◢
        </div>
      )}
    </div>
  )
}
