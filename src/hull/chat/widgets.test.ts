import { describe, expect, it } from 'vitest'

import { answerMessageBody, offeredAnswer, STACK_PLACEMENT } from './widgets'

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

describe('STACK_PLACEMENT', () => {
  it('is the only placement that exists yet', () => {
    expect(STACK_PLACEMENT).toBe('stack')
  })
})
