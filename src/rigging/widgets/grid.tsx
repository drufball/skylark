import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'

import {
  CANVAS_COLUMNS,
  clampCanvasBox,
  type CanvasBox,
} from '@hull/chat/widgets'
import { TAP_TARGET } from '@rigging/lib/tap-target'
import { cn } from '@rigging/lib/utils'
import { Button } from '@rigging/components/ui/button'

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

/** The fewest rows a phone tile is drawn at, however short its arrangement. */
const MIN_PHONE_ROWS = 2

/** Slack, in px, before a capped body counts as hiding something. */
const OVERFLOW_SLACK_PX = 4

/**
 * How tall a tile's body may get in the phone column.
 *
 * The desktop grid gives a tile exactly `gridH` rows, so its body is bounded and
 * scrolls inside a box somebody sized. The phone column had no such bound at
 * all: a `files` tile holding eighteen documents grew into a tall scrolling
 * column, inside a tile, inside a scrolling page — three nested scrolls on a
 * device with one thumb. Borrowing the arranged height is the honest fix,
 * because it's the same claim the desktop already makes about how much room the
 * tile is meant to take.
 *
 * The floor is two rows: a tile squashed to one is 104px, under three tap
 * targets, and a `choice` you can't answer with a thumb is a worse outcome than
 * a tile slightly taller than somebody's desktop arrangement.
 */
export function phoneTileCapPx(rows: number): number {
  const capped = Math.max(rows, MIN_PHONE_ROWS)
  return capped * ROW_PX + (capped - 1) * GAP_PX
}

/**
 * Is a capped body hiding content below its fold? The slack matters: borders and
 * fractional line heights make a body that fits perfectly overshoot by a hair,
 * and a tile that cried "more below" over two pixels would be the same
 * dishonesty this line exists to fix, in reverse.
 */
export function isOverflowing(box: {
  scrollHeight: number
  clientHeight: number
}): boolean {
  return box.scrollHeight - box.clientHeight > OVERFLOW_SLACK_PX
}

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
 * Which page is open, what's arranged on it, and how a swipe moves between
 * pages — the page behaviour both canvases share, in the one place it lives.
 *
 * `activePageId` is the page THIS viewer has open (per person, never per
 * surface); a viewer who has opened none — or whose page is gone — lands on
 * the first page rather than a blank. `step` is the swipe: a page over in
 * either direction, wrapping at the ends, and a no-op when there's nowhere
 * else to go.
 */
export function usePages<T extends { pageId: string }>(
  pages: GridPage[],
  activePageId: string | null,
  items: T[],
  onSelectPage: (pageId: string) => void,
): {
  activePage: GridPage | undefined
  onPage: T[]
  step: (by: number) => void
} {
  const activePage = pages.find((p) => p.id === activePageId) ?? pages.at(0)
  const activeId = activePage?.id
  const onPage = useMemo(
    () => items.filter((item) => item.pageId === activeId),
    [items, activeId],
  )
  function step(by: number) {
    if (!activePage) return
    const at = pages.findIndex((p) => p.id === activePage.id)
    const next = pages.at((at + by) % pages.length)
    if (next && next.id !== activePage.id) onSelectPage(next.id)
  }
  return { activePage, onPage, step }
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
      {/* `size="sm"` is a 32px button, which is under the thumb floor — the
          strip is the one row a phone drives this surface from, so it keeps
          the dense look and gains the height. */}
      <Button
        variant="outline"
        size="sm"
        className={cn('shrink-0', TAP_TARGET)}
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
 * The one place a tile scrolls, and the line it owes you when it's hiding
 * something.
 *
 * A tile is a fixed box and its contents are not. On a desktop pane the grid
 * cell bounded it; the phone column didn't bound it at all, so a long body just
 * grew — and the kinds had each grown their own inner cap to compensate, which
 * is how one tile ended up with three nested scrolls. So the FRAME owns the cap
 * and the scroll, the kinds own neither, and when there's more inside than the
 * box shows, the tile says so. Same rule the `files` list already keeps for its
 * item count ("and N more"), applied to the tile's own height.
 */
function TileBody({
  capPx,
  children,
}: {
  capPx?: number
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [clipped, setClipped] = useState(false)

  // No dependency list on purpose. A widget body fills itself in AFTER it mounts
  // (a `files` tile reads the shelf, an `issue-list` its issues) and does it in
  // its OWN state, which never re-runs an effect up here — so the measurement
  // has to be taken again on every render, and watched in between. The container
  // itself never resizes (it's capped), so what's observed is what's inside it.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    function measure() {
      if (el) setClipped(isOverflowing(el))
    }
    measure()
    // jsdom has no ResizeObserver; the measurement above still runs, so a test
    // sees the state a body's first paint puts it in.
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    for (const child of el.children) observer.observe(child)
    return () => {
      observer.disconnect()
    }
  })

  return (
    <>
      <div
        ref={ref}
        data-testid="tile-body"
        className="min-h-0 flex-1 overflow-auto"
        // Inline rather than a class: the cap is the tile's ARRANGED height in
        // px, which is a number the grid computes, not one of a fixed set.
        style={capPx === undefined ? undefined : { maxHeight: capPx }}
      >
        {children}
      </div>
      {clipped && (
        <p
          data-testid="tile-clipped"
          className="shrink-0 border-t px-3 py-1 text-[11px] text-muted-foreground"
        >
          More below — scroll inside this tile.
        </p>
      )}
    </>
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
  capPx,
  footer,
  children,
}: {
  headline: string
  /** The surface's own buttons, at the right of the title bar. */
  actions?: ReactNode
  /** Desktop arrangement. Omitted on a phone, which has no drag or resize. */
  handles?: GridHandles
  /**
   * How tall the body may get, in px. Omitted where the surface already sizes
   * the tile (a desktop grid cell), given on the phone column, which doesn't —
   * see `phoneTileCapPx`.
   */
  capPx?: number
  /**
   * A line the surface keeps BELOW the scrolling body — home's "which chat does
   * this live in?". Outside the scroll because it's the answer to the question a
   * home screen makes people ask constantly, and an answer you have to scroll to
   * find isn't one.
   */
  footer?: ReactNode
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
      <TileBody capPx={capPx}>{children}</TileBody>
      {footer}
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
