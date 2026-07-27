// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CANVAS_COLUMNS } from '@hull/chat/widgets'
import { MOBILE_BREAKPOINT } from '@rigging/lib/use-is-mobile'
import type { EventSourceLike } from '@rigging/lib/use-ship-log'

import {
  cellAt,
  nudge,
  WidgetCanvas,
  type CanvasPageItem,
  type CanvasWidgetItem,
} from './canvas'

// The chat's spatial surface. Two layouts over ONE arrangement: a grid you
// arrange on a desktop pane, the same page as a single column under a thumb.
// The tests that matter most are the phone ones — a canvas that only works with
// a mouse is the failure this design is aimed at.

class FakeSource implements EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close(): void {
    /* nothing to tear down in a fake */
  }
}
const factory = () => new FakeSource()

function setWidth(width: number) {
  window.innerWidth = width
  window.dispatchEvent(new Event('resize'))
}
const DESKTOP = MOBILE_BREAKPOINT + 400
const PHONE = 390

function tile(over: Partial<CanvasWidgetItem> = {}): CanvasWidgetItem {
  return {
    id: 'w1',
    kind: 'note',
    props: { text: '# Deploys\n\nfour today' },
    createdByHandle: 'tilde',
    pageId: 'p1',
    gridX: 0,
    gridY: 0,
    gridW: 2,
    gridH: 2,
    ...over,
  }
}

const PAGES: CanvasPageItem[] = [
  { id: 'p1', title: 'Ops' },
  { id: 'p2', title: 'Numbers' },
]

function renderCanvas(
  over: {
    pages?: CanvasPageItem[]
    widgets?: Partial<CanvasWidgetItem>[]
    activePageId?: string | null
  } = {},
) {
  const handlers = {
    onSelectPage: vi.fn(),
    onNewPage: vi.fn(),
    onRenamePage: vi.fn(),
    onRemovePage: vi.fn(),
    onPlaceWidget: vi.fn(),
    onStackWidget: vi.fn(),
    onAnswerWidget: vi.fn(),
  }
  const view = render(
    <WidgetCanvas
      pages={over.pages ?? PAGES}
      widgets={(over.widgets ?? [{}]).map((w) => tile(w))}
      activePageId={over.activePageId === undefined ? 'p1' : over.activePageId}
      busy={false}
      eventSourceFactory={factory}
      {...handlers}
    />,
  )
  return { ...view, ...handlers }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setWidth(1024)
})

describe('cellAt', () => {
  it('reads the cell a pointer is over', () => {
    // A 400px-wide four-column grid: 102px a column once the gutter is counted.
    expect(
      cellAt(
        { left: 0, top: 0, width: 400 },
        { clientX: 210, clientY: 120 },
        0,
      ),
    ).toEqual({ gridX: 2, gridY: 1 })
  })

  it('counts the grid’s own scroll, so a dragged tile lands where you see it', () => {
    expect(
      cellAt({ left: 0, top: 0, width: 400 }, { clientX: 0, clientY: 0 }, 224),
    ).toEqual({ gridX: 0, gridY: 2 })
  })

  it('refuses to guess from a grid with no width', () => {
    // A zero-width box (unlaid-out, or jsdom) would divide every column into
    // nothing and slam the tile to 0,0 — worse than not moving it.
    expect(
      cellAt({ left: 0, top: 0, width: 0 }, { clientX: 50, clientY: 50 }, 0),
    ).toBeNull()
  })
})

describe('nudge', () => {
  const box = { gridX: 1, gridY: 1, gridW: 2, gridH: 2 }

  it('moves a cell per arrow', () => {
    expect(nudge(box, 'ArrowRight', false)).toMatchObject({
      gridX: 2,
      gridY: 1,
    })
    expect(nudge(box, 'ArrowUp', false)).toMatchObject({ gridX: 1, gridY: 0 })
  })

  it('resizes with shift held', () => {
    expect(nudge(box, 'ArrowRight', true)).toMatchObject({ gridW: 3, gridH: 2 })
    expect(nudge(box, 'ArrowUp', true)).toMatchObject({ gridW: 2, gridH: 1 })
  })

  it('parks against an edge instead of walking off it', () => {
    const edge = { gridX: CANVAS_COLUMNS - 1, gridY: 0, gridW: 1, gridH: 1 }
    expect(nudge(edge, 'ArrowRight', false)).toMatchObject({
      gridX: CANVAS_COLUMNS - 1,
    })
    expect(nudge(edge, 'ArrowUp', false)).toMatchObject({ gridY: 0 })
  })

  it('ignores a key that isn’t an arrow', () => {
    expect(nudge(box, 'Enter', false)).toBeNull()
  })
})

describe('WidgetCanvas: the pages', () => {
  it('tabs between pages, marking the one you are on', () => {
    const { onSelectPage } = renderCanvas()
    expect(screen.getByRole('button', { name: 'Ops' })).toHaveProperty(
      'ariaCurrent',
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Numbers' }))
    expect(onSelectPage).toHaveBeenCalledWith('p2')
  })

  it('offers to start a canvas when the chat has no pages at all', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Ops')
    const { onNewPage } = renderCanvas({ pages: [], widgets: [] })
    expect(screen.getByText('No canvas yet')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /New page/ }))
    expect(onNewPage).toHaveBeenCalledWith('Ops')
  })

  it('adds nothing when the name prompt is dismissed', () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null)
    const { onNewPage } = renderCanvas()
    fireEvent.click(screen.getByLabelText('Add a page'))
    expect(onNewPage).not.toHaveBeenCalled()
  })

  it('renames the page you are on', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Ops room')
    const { onRenamePage } = renderCanvas()
    fireEvent.click(screen.getByLabelText('Rename page Ops'))
    expect(onRenamePage).toHaveBeenCalledWith('p1', 'Ops room')
  })

  it('removes the page you are on', () => {
    const { onRemovePage } = renderCanvas()
    fireEvent.click(screen.getByLabelText('Remove page Ops'))
    expect(onRemovePage).toHaveBeenCalledWith('p1')
  })

  it('shows an empty page rather than skipping past it', () => {
    // An empty page is the reason pages are rows at all: you make one, then
    // fill it.
    renderCanvas({ activePageId: 'p2' })
    expect(screen.getByText(/Nothing on this page yet/)).toBeTruthy()
  })

  it('falls back to the first page when this viewer has opened none', () => {
    renderCanvas({ activePageId: null })
    expect(screen.getByRole('button', { name: 'Ops' })).toHaveProperty(
      'ariaCurrent',
      'true',
    )
  })
})

describe('WidgetCanvas: the desktop grid', () => {
  it('places each tile at its own cells', () => {
    act(() => {
      setWidth(DESKTOP)
    })
    renderCanvas({
      widgets: [
        { id: 'w1', gridX: 0, gridY: 0, gridW: 2, gridH: 2 },
        { id: 'w2', gridX: 2, gridY: 1, gridW: 1, gridH: 3 },
      ],
    })
    const cells = screen
      .getAllByLabelText(/^Send widget/)
      .map((btn) =>
        btn.closest('[style*="grid-column"]')?.getAttribute('style'),
      )
    expect(cells[0]).toContain('grid-column: 1 / span 2')
    expect(cells[1]).toContain('grid-row: 2 / span 3')
  })

  it('arranges from the keyboard, committing one write', () => {
    // The mouse-free path — and the honest one to test, since a drag needs a
    // laid-out box jsdom never gives.
    act(() => {
      setWidth(DESKTOP)
    })
    const { onPlaceWidget } = renderCanvas({
      widgets: [{ id: 'w1', gridX: 0, gridY: 0, gridW: 2, gridH: 2 }],
    })
    fireEvent.keyDown(screen.getByLabelText(/^Move /), { key: 'ArrowRight' })
    expect(onPlaceWidget).toHaveBeenCalledWith('w1', {
      pageId: 'p1',
      gridX: 1,
      gridY: 0,
      gridW: 2,
      gridH: 2,
    })
  })

  it('sends a tile back to the stack — the same row, the other surface', () => {
    act(() => {
      setWidth(DESKTOP)
    })
    const { onStackWidget } = renderCanvas()
    fireEvent.click(screen.getByLabelText('Send widget w1 to the stack'))
    expect(onStackWidget).toHaveBeenCalledWith('w1')
  })

  it('renders a body open, without being tapped', () => {
    // The opposite of a stack tile: you arranged this precisely so you could
    // see it at a glance.
    act(() => {
      setWidth(DESKTOP)
    })
    renderCanvas()
    expect(screen.getByText('four today')).toBeTruthy()
  })

  it('renders an honest tile for a kind this ship doesn’t know', () => {
    act(() => {
      setWidth(DESKTOP)
    })
    renderCanvas({ widgets: [{ kind: 'hologram', props: {} }] })
    expect(screen.getByText(/doesn’t know this widget kind/)).toBeTruthy()
  })
})

describe('WidgetCanvas: the phone', () => {
  it('renders the page as ONE column, in arrangement order', () => {
    act(() => {
      setWidth(PHONE)
    })
    renderCanvas({
      widgets: [
        { id: 'w1', props: { text: 'top left' }, gridX: 0, gridY: 0 },
        { id: 'w2', props: { text: 'top right' }, gridX: 2, gridY: 0 },
      ],
    })
    const column = screen.getByTestId('canvas-column')
    expect(screen.queryByTestId('canvas-grid')).toBeNull()
    expect(column.textContent).toMatch(/top left[\s\S]*top right/)
  })

  it('offers no drag or resize targets under a thumb', () => {
    // Both are desktop idioms. A 44px thumb cannot place a tile in a
    // four-column grid, and shipping the handles anyway is how a "responsive"
    // canvas becomes unusable on the device that matters most.
    act(() => {
      setWidth(PHONE)
    })
    renderCanvas()
    expect(screen.queryByLabelText(/^Move /)).toBeNull()
    expect(screen.queryByLabelText(/^Resize /)).toBeNull()
  })

  it('swipes left to the next page', () => {
    act(() => {
      setWidth(PHONE)
    })
    const { onSelectPage } = renderCanvas()
    const column = screen.getByTestId('canvas-column')
    fireEvent.pointerDown(column, { clientX: 300, clientY: 400 })
    fireEvent.pointerUp(column, { clientX: 120, clientY: 410 })
    expect(onSelectPage).toHaveBeenCalledWith('p2')
  })

  it('swipes right back to the previous page', () => {
    act(() => {
      setWidth(PHONE)
    })
    const { onSelectPage } = renderCanvas({ activePageId: 'p2' })
    const column = screen.getByTestId('canvas-column')
    fireEvent.pointerDown(column, { clientX: 80, clientY: 400 })
    fireEvent.pointerUp(column, { clientX: 300, clientY: 400 })
    expect(onSelectPage).toHaveBeenCalledWith('p1')
  })

  it('ignores a vertical drag — that is a scroll, not a page turn', () => {
    act(() => {
      setWidth(PHONE)
    })
    const { onSelectPage } = renderCanvas()
    const column = screen.getByTestId('canvas-column')
    fireEvent.pointerDown(column, { clientX: 200, clientY: 600 })
    fireEvent.pointerUp(column, { clientX: 130, clientY: 200 })
    expect(onSelectPage).not.toHaveBeenCalled()
  })

  it('ignores a nudge too small to be meant', () => {
    act(() => {
      setWidth(PHONE)
    })
    const { onSelectPage } = renderCanvas()
    const column = screen.getByTestId('canvas-column')
    fireEvent.pointerDown(column, { clientX: 200, clientY: 400 })
    fireEvent.pointerUp(column, { clientX: 180, clientY: 400 })
    expect(onSelectPage).not.toHaveBeenCalled()
  })

  it('still lets a thumb send a tile back to the stack', () => {
    act(() => {
      setWidth(PHONE)
    })
    const { onStackWidget } = renderCanvas()
    fireEvent.click(screen.getByLabelText('Send widget w1 to the stack'))
    expect(onStackWidget).toHaveBeenCalledWith('w1')
  })
})

describe('WidgetCanvas: thumb-sized where it has to be', () => {
  it('gives the phone tile’s only control a full tap target', () => {
    // Measured at 390×844: it was a 24px-tall icon, which is not a button you
    // can hit while walking.
    act(() => {
      setWidth(PHONE)
    })
    renderCanvas()
    expect(
      screen.getByLabelText('Send widget w1 to the stack').className,
    ).toContain('min-h-11')
  })

  it('keeps the desktop tile header dense', () => {
    // A 44px header on a 104px row is most of the tile, and a mouse doesn't
    // need it.
    act(() => {
      setWidth(DESKTOP)
    })
    renderCanvas()
    expect(
      screen.getByLabelText('Send widget w1 to the stack').className,
    ).not.toContain('min-h-11')
  })
})

describe('WidgetCanvas: dragging and resizing with a pointer', () => {
  /**
   * jsdom lays nothing out, so a grid has no box and `cellAt` (rightly) refuses
   * to guess. Stubbing the ONE measurement the drag maths takes is what lets the
   * real pointer path — capture, preview, commit — be driven here instead of
   * only in a browser.
   */
  function layOutGrid(width = 400) {
    const grid = screen.getByTestId('canvas-grid')
    grid.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width, height: 600 }) as DOMRect
    return grid
  }

  function pointer(
    el: Element,
    type: 'down' | 'move' | 'up',
    at: [number, number],
  ) {
    const init = { clientX: at[0], clientY: at[1], pointerId: 1, bubbles: true }
    if (type === 'down') fireEvent.pointerDown(el, init)
    if (type === 'move') fireEvent.pointerMove(el, init)
    if (type === 'up') fireEvent.pointerUp(el, init)
  }

  beforeEach(() => {
    act(() => {
      setWidth(DESKTOP)
    })
    // jsdom has no pointer capture.
    Element.prototype.setPointerCapture = vi.fn()
  })

  it('drags a tile to the cell you let go over', () => {
    const { onPlaceWidget } = renderCanvas({
      widgets: [{ id: 'w1', gridX: 0, gridY: 0, gridW: 2, gridH: 2 }],
    })
    const grid = layOutGrid()
    const grip = screen.getByLabelText(/^Move /)
    // Grab at cell 0,0 and let go two columns over and one row down.
    pointer(grip, 'down', [10, 10])
    pointer(grid, 'move', [215, 130])
    pointer(grid, 'up', [215, 130])
    expect(onPlaceWidget).toHaveBeenCalledWith('w1', {
      pageId: 'p1',
      gridX: 2,
      gridY: 1,
      gridW: 2,
      gridH: 2,
    })
  })

  it('keeps the grab offset, so the tile doesn’t jump under the cursor', () => {
    const { onPlaceWidget } = renderCanvas({
      widgets: [{ id: 'w1', gridX: 0, gridY: 0, gridW: 2, gridH: 2 }],
    })
    const grid = layOutGrid()
    // Grabbed at the tile's SECOND column; dropping at column 3 must put the
    // tile's left edge at column 2, not at 3.
    pointer(screen.getByLabelText(/^Move /), 'down', [110, 10])
    pointer(grid, 'move', [320, 10])
    pointer(grid, 'up', [320, 10])
    expect(onPlaceWidget).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ gridX: 2, gridY: 0 }),
    )
  })

  it('resizes from the corner', () => {
    const { onPlaceWidget } = renderCanvas({
      widgets: [{ id: 'w1', gridX: 0, gridY: 0, gridW: 1, gridH: 1 }],
    })
    const grid = layOutGrid()
    pointer(screen.getByLabelText(/^Resize /), 'down', [90, 90])
    pointer(grid, 'move', [320, 250])
    pointer(grid, 'up', [320, 250])
    expect(onPlaceWidget).toHaveBeenCalledWith('w1', {
      pageId: 'p1',
      gridX: 0,
      gridY: 0,
      gridW: 4,
      gridH: 3,
    })
  })

  it('writes once, at the end — not on every pointer move', () => {
    // A drag across the pane is one row update, not twenty round trips.
    const { onPlaceWidget } = renderCanvas({
      widgets: [{ id: 'w1', gridX: 0, gridY: 0, gridW: 2, gridH: 2 }],
    })
    const grid = layOutGrid()
    pointer(screen.getByLabelText(/^Move /), 'down', [10, 10])
    for (const x of [60, 120, 180, 240]) pointer(grid, 'move', [x, 10])
    expect(onPlaceWidget).not.toHaveBeenCalled()
    pointer(grid, 'up', [240, 10])
    expect(onPlaceWidget).toHaveBeenCalledTimes(1)
  })

  it('abandons a drag the browser cancels, writing nothing', () => {
    const { onPlaceWidget } = renderCanvas()
    const grid = layOutGrid()
    pointer(screen.getByLabelText(/^Move /), 'down', [10, 10])
    pointer(grid, 'move', [215, 130])
    fireEvent.pointerCancel(grid)
    pointer(grid, 'up', [215, 130])
    expect(onPlaceWidget).not.toHaveBeenCalled()
  })

  it('ignores a pointer move when nothing is being dragged', () => {
    const { onPlaceWidget } = renderCanvas()
    const grid = layOutGrid()
    pointer(grid, 'move', [215, 130])
    pointer(grid, 'up', [215, 130])
    expect(onPlaceWidget).not.toHaveBeenCalled()
  })

  it('leaves the tile where it was when the grid has no box to measure', () => {
    // The zero-width guard, end to end: a drag on an unlaid-out grid must not
    // slam the tile to 0,0.
    const { onPlaceWidget } = renderCanvas({
      widgets: [{ id: 'w1', gridX: 2, gridY: 1, gridW: 2, gridH: 2 }],
    })
    const grid = screen.getByTestId('canvas-grid')
    pointer(screen.getByLabelText(/^Move /), 'down', [10, 10])
    pointer(grid, 'move', [215, 130])
    pointer(grid, 'up', [215, 130])
    expect(onPlaceWidget).toHaveBeenCalledWith('w1', {
      pageId: 'p1',
      gridX: 2,
      gridY: 1,
      gridW: 2,
      gridH: 2,
    })
  })

  it('ignores a non-arrow keypress on the grip', () => {
    const { onPlaceWidget } = renderCanvas()
    layOutGrid()
    fireEvent.keyDown(screen.getByLabelText(/^Move /), { key: 'a' })
    expect(onPlaceWidget).not.toHaveBeenCalled()
  })
})
