import { describe, expect, it } from 'vitest'

import {
  answerMessageBody,
  CANVAS_COLUMNS,
  CANVAS_PLACEMENT,
  clampCanvasBox,
  DEFAULT_CANVAS_BOX,
  freeCanvasBox,
  nextCanvasSlot,
  offeredAnswer,
  STACK_PLACEMENT,
} from './widgets'

// What the hull enforces about a widget ROW without knowing any kind by name:
// you may only post back an answer the row itself offered, and the answer quotes
// the question so the transcript stands alone. Everything about what a kind
// MEANS — how it renders, which service it reads — is the rigging registry's
// (see rigging/widgets/zine.md); this is the row half that stayed here.
//
// The exhaustive cases are the malformed ones, because AGENTS write these props
// and get them wrong: every shape must come back as "nothing on offer", never a
// throw the answer door would turn into a 500.

describe('offeredAnswer', () => {
  it('reads the question and options a row offers', () => {
    expect(
      offeredAnswer({ question: 'Ship it?', options: ['Yes', 'No'] }),
    ).toEqual({ question: 'Ship it?', options: ['Yes', 'No'] })
  })

  it('keeps a single option — a one-button acknowledgement is legal', () => {
    expect(offeredAnswer({ question: 'Seen?', options: ['Ok'] })).toEqual({
      question: 'Seen?',
      options: ['Ok'],
    })
  })

  it('lifts out only the offer, never an agent’s extra keys', () => {
    expect(
      offeredAnswer({ question: 'Ship it?', options: ['Yes'], colour: 'red' }),
    ).toEqual({ question: 'Ship it?', options: ['Yes'] })
  })

  it('offers nothing for a row that carries no answers at all', () => {
    // A `note` or an `issue-list` is read, not answered. Structurally that's
    // just "no options on the blob", which is why the hull needs no kind names.
    expect(offeredAnswer({ text: 'Standup at 09:30' })).toBeNull()
    expect(offeredAnswer({ statuses: ['open'] })).toBeNull()
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '{"question":"q"}'],
    ['a number', 7],
    ['an array', ['Yes', 'No']],
  ])('offers nothing when props are %s, not an object', (_label, json) => {
    expect(offeredAnswer(json)).toBeNull()
  })

  it.each([
    ['missing', { options: ['Yes'] }],
    ['not a string', { question: 42, options: ['Yes'] }],
    ['blank', { question: '   ', options: ['Yes'] }],
  ])('offers nothing when the question is %s', (_label, json) => {
    expect(offeredAnswer(json)).toBeNull()
  })

  it.each([
    ['missing', { question: 'q' }],
    ['not an array', { question: 'q', options: 'Yes,No' }],
    ['empty', { question: 'q', options: [] }],
    ['holding a non-string', { question: 'q', options: ['Yes', 3] }],
    ['holding a blank string', { question: 'q', options: ['Yes', ' '] }],
  ])('offers nothing when the options are %s', (_label, json) => {
    expect(offeredAnswer(json)).toBeNull()
  })
})

describe('answerMessageBody', () => {
  it('quotes the question above the answer, so the transcript stands alone', () => {
    expect(answerMessageBody('Ship it?', 'Yes')).toBe('> Ship it?\n\nYes')
  })

  it('quotes every line of a multi-line question', () => {
    // Without per-line quoting the second line reads as the answer.
    expect(answerMessageBody('Ship it?\nReally?', 'No')).toBe(
      '> Ship it?\n> Really?\n\nNo',
    )
  })
})

describe('placements', () => {
  it('names the two surfaces a widget can be on', () => {
    // The stack is turn-shaped (answer this now); the canvas is state-shaped
    // (you arranged this and it stays). `placement` is the discriminator, and
    // moving between them is an ordinary row update.
    expect(STACK_PLACEMENT).toBe('stack')
    expect(CANVAS_PLACEMENT).toBe('canvas')
  })
})

describe('clampCanvasBox', () => {
  it('fills in the default box when nothing is asked for', () => {
    expect(clampCanvasBox({})).toEqual(DEFAULT_CANVAS_BOX)
  })

  it('keeps a box that already fits', () => {
    expect(clampCanvasBox({ gridX: 1, gridY: 3, gridW: 2, gridH: 1 })).toEqual({
      gridX: 1,
      gridY: 3,
      gridW: 2,
      gridH: 1,
    })
  })

  it('pulls a box back inside the grid rather than refusing it', () => {
    // An agent writing coordinates by hand will overshoot; a clamped tile the
    // crew can then drag beats a rejected write it never sees the result of.
    expect(
      clampCanvasBox({ gridX: 9, gridY: -4, gridW: 99, gridH: 0 }),
    ).toEqual({ gridX: CANVAS_COLUMNS - 1, gridY: 0, gridW: 1, gridH: 1 })
  })

  it('narrows a wide tile that starts near the right edge', () => {
    expect(clampCanvasBox({ gridX: 3, gridY: 0, gridW: 3, gridH: 2 })).toEqual({
      gridX: 3,
      gridY: 0,
      gridW: 1,
      gridH: 2,
    })
  })

  it('rounds fractional cells — the grid has no half squares', () => {
    expect(
      clampCanvasBox({ gridX: 1.6, gridY: 0.2, gridW: 2.4, gridH: 1.5 }),
    ).toEqual({ gridX: 2, gridY: 0, gridW: 2, gridH: 2 })
  })
})

describe('nextCanvasSlot', () => {
  it('puts the first widget in the top-left corner', () => {
    expect(nextCanvasSlot([], DEFAULT_CANVAS_BOX)).toEqual({
      gridX: 0,
      gridY: 0,
    })
  })

  it('fills the gap beside an existing tile before starting a new row', () => {
    const taken = [{ gridX: 0, gridY: 0, gridW: 2, gridH: 2 }]
    expect(nextCanvasSlot(taken, { gridW: 2, gridH: 2 })).toEqual({
      gridX: 2,
      gridY: 0,
    })
  })

  it('drops to the next row when the first one is full', () => {
    const taken = [
      { gridX: 0, gridY: 0, gridW: 2, gridH: 2 },
      { gridX: 2, gridY: 0, gridW: 2, gridH: 2 },
    ]
    expect(nextCanvasSlot(taken, { gridW: 2, gridH: 2 })).toEqual({
      gridX: 0,
      gridY: 2,
    })
  })

  it('slots a narrow tile into a hole a wide one could not use', () => {
    const taken = [{ gridX: 0, gridY: 0, gridW: 3, gridH: 1 }]
    expect(nextCanvasSlot(taken, { gridW: 1, gridH: 1 })).toEqual({
      gridX: 3,
      gridY: 0,
    })
  })

  it('reads only the SIZE off a whole box, not the corner it came with', () => {
    // The place door hands over a clamped box, corner and all. If the scan
    // spread that in, every widget would be tested at 0,0 and land on top of
    // the last one.
    const taken = [{ gridX: 0, gridY: 0, gridW: 2, gridH: 2 }]
    expect(nextCanvasSlot(taken, DEFAULT_CANVAS_BOX)).toEqual({
      gridX: 2,
      gridY: 0,
    })
  })

  it('never overlaps a tile that spans several rows', () => {
    const taken = [{ gridX: 0, gridY: 0, gridW: 1, gridH: 3 }]
    expect(nextCanvasSlot(taken, { gridW: CANVAS_COLUMNS, gridH: 1 })).toEqual({
      gridX: 0,
      gridY: 3,
    })
  })
})

describe('freeCanvasBox', () => {
  const taken = [{ gridX: 0, gridY: 0, gridW: 2, gridH: 2 }]

  it('honours a box that lands on free cells', () => {
    const desired = { gridX: 2, gridY: 0, gridW: 2, gridH: 2 }
    expect(freeCanvasBox(taken, desired)).toEqual(desired)
  })

  it('yields to a tile already there rather than stacking on top of it', () => {
    // Observed live: CSS grid draws the two on top of each other and it reads
    // as a rendering bug. The tile being MOVED is the one that gives way —
    // shoving the neighbours would rearrange a page somebody laid out.
    expect(
      freeCanvasBox(taken, { gridX: 1, gridY: 1, gridW: 2, gridH: 2 }),
    ).toEqual({ gridX: 2, gridY: 0, gridW: 2, gridH: 2 })
  })

  it('keeps the size it was asked for while it looks for room', () => {
    expect(
      freeCanvasBox(taken, { gridX: 0, gridY: 0, gridW: 4, gridH: 1 }),
    ).toEqual({ gridX: 0, gridY: 2, gridW: 4, gridH: 1 })
  })
})
