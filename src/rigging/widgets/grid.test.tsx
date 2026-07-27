import { describe, expect, it } from 'vitest'

import { CANVAS_COLUMNS } from '@hull/chat/widgets'

import { cellAt, nudge } from './grid'

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
