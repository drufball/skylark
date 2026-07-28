// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CANVAS_COLUMNS } from '@hull/chat/widgets'

import { cellAt, isOverflowing, nudge, phoneTileCapPx, TileFrame } from './grid'

// The two pure halves of arranging a tile, shared by the chat canvas and the
// home canvas. They're the honest way to TEST arrangement at all: a pointer drag
// needs a laid-out box, which jsdom never gives, so the keyboard path is what
// pins the maths down.

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

describe('phoneTileCapPx', () => {
  it('gives a tile the height its arrangement asked for', () => {
    // Two 104px rows and the 8px gutter between them — exactly what the desktop
    // grid draws for `gridH: 2`, so the two layouts agree on how much room a
    // tile is meant to take.
    expect(phoneTileCapPx(2)).toBe(216)
    expect(phoneTileCapPx(3)).toBe(328)
  })

  it('never squashes a tile below two rows', () => {
    // A one-row tile is 104px, which is under three tap targets — and a tile you
    // can't answer with a thumb is worse than one that's slightly taller than
    // somebody's desktop arrangement.
    expect(phoneTileCapPx(1)).toBe(phoneTileCapPx(2))
  })
})

describe('isOverflowing', () => {
  it('is true when a capped body has more inside than it shows', () => {
    expect(isOverflowing({ scrollHeight: 600, clientHeight: 320 })).toBe(true)
  })

  it('forgives a hair of sub-pixel rounding', () => {
    // A body that fits perfectly still overshoots by a fraction once borders and
    // fractional line heights are counted; claiming "more below" there would be
    // the dishonesty this line exists to fix, in reverse.
    expect(isOverflowing({ scrollHeight: 322, clientHeight: 320 })).toBe(false)
    expect(isOverflowing({ scrollHeight: 320, clientHeight: 320 })).toBe(false)
  })
})

describe('TileFrame', () => {
  afterEach(cleanup)

  /** Make every element in jsdom report a fixed scroll/client height. */
  function stubHeights(scrollHeight: number, clientHeight: number) {
    for (const [prop, value] of [
      ['scrollHeight', scrollHeight],
      ['clientHeight', clientHeight],
    ] as const) {
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get: () => value,
      })
    }
  }

  afterEach(() => {
    for (const prop of ['scrollHeight', 'clientHeight']) {
      Reflect.deleteProperty(HTMLElement.prototype, prop)
    }
  })

  it('caps the body and says so when the tile is hiding content', () => {
    stubHeights(900, 320)
    render(
      <TileFrame headline="Files · all" capPx={320}>
        <p>eighteen documents</p>
      </TileFrame>,
    )
    const body = screen.getByTestId('tile-body')
    expect(body.style.maxHeight).toBe('320px')
    // The same honesty the `files` list already owes its item count — "and N
    // more" — owed for the tile's own height.
    expect(screen.getByTestId('tile-clipped')).toBeTruthy()
  })

  it('says nothing when everything fits', () => {
    stubHeights(120, 320)
    render(
      <TileFrame headline="Ship it?" capPx={320}>
        <p>two options</p>
      </TileFrame>,
    )
    expect(screen.queryByTestId('tile-clipped')).toBeNull()
  })

  it('leaves the body uncapped when the surface sizes it (a desktop cell)', () => {
    stubHeights(120, 320)
    render(
      <TileFrame headline="Ship it?">
        <p>two options</p>
      </TileFrame>,
    )
    expect(screen.getByTestId('tile-body').style.maxHeight).toBe('')
  })

  it('keeps a footer out of the scrolling half', () => {
    // A home tile's "which chat is this?" line has to stay on screen while the
    // body scrolls — it's the answer to the question a home screen makes people
    // ask constantly.
    stubHeights(900, 320)
    render(
      <TileFrame
        headline="Files · all"
        capPx={320}
        footer={<a href="/chat">Files</a>}
      >
        <p>eighteen documents</p>
      </TileFrame>,
    )
    expect(
      screen.getByTestId('tile-body').contains(screen.getByRole('link')),
    ).toBe(false)
  })

  /**
   * The measurement has to survive the body filling itself in LATER, which is
   * the normal case rather than the edge one: a `files` tile reads the shelf
   * after it mounts and an `issue-list` reads its issues, both in their own
   * state, which never re-runs an effect up in the frame. So the frame watches
   * what's inside the body.
   *
   * jsdom has no `ResizeObserver`, so the test brings one — a stand-in for a
   * missing platform API, the same shape as the `scrollHeight` stubs above,
   * rather than a stand-in for a collaborator.
   */
  describe('when the body fills itself in after mount', () => {
    class FakeResizeObserver {
      static live: FakeResizeObserver[] = []
      readonly observed: Element[] = []
      disconnected = false
      constructor(readonly onResize: () => void) {
        FakeResizeObserver.live.push(this)
      }
      observe(el: Element) {
        this.observed.push(el)
      }
      disconnect() {
        this.disconnected = true
      }
    }
    /** The observer the frame is currently watching with. */
    const latest = () => FakeResizeObserver.live.at(-1)

    beforeEach(() => {
      FakeResizeObserver.live = []
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: FakeResizeObserver,
      })
    })
    afterEach(() => {
      Reflect.deleteProperty(globalThis, 'ResizeObserver')
    })

    it('watches what is inside the body, not the body itself', () => {
      // The container is capped, so it never resizes — its CONTENTS do.
      stubHeights(120, 320)
      render(
        <TileFrame headline="Files · all" capPx={320}>
          <ul data-testid="the-list" />
        </TileFrame>,
      )
      expect(latest()?.observed).toEqual([screen.getByTestId('the-list')])
    })

    it('says “more below” once the contents outgrow the cap', () => {
      stubHeights(120, 320)
      render(
        <TileFrame headline="Files · all" capPx={320}>
          <ul data-testid="the-list" />
        </TileFrame>,
      )
      expect(screen.queryByTestId('tile-clipped')).toBeNull()

      // Eighteen documents land.
      stubHeights(900, 320)
      act(() => {
        latest()?.onResize()
      })
      expect(screen.getByTestId('tile-clipped')).toBeTruthy()
    })

    it('stops watching when the tile goes', () => {
      stubHeights(120, 320)
      const { unmount } = render(
        <TileFrame headline="Files · all" capPx={320}>
          <ul />
        </TileFrame>,
      )
      const observer = latest()
      unmount()
      expect(observer?.disconnected).toBe(true)
    })
  })
})
