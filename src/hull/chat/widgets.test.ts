import { describe, expect, it } from 'vitest'

import {
  answerOptions,
  answerMessageBody,
  parseProps,
  STACK_PLACEMENT,
  WIDGET_KINDS,
} from './widgets'

// The whole point of parseProps is that AGENTS write these props and will get
// them wrong. So the exhaustive case here isn't "does the happy path work" —
// it's "does every malformed shape come back as an honest refusal", never a
// throw the render would turn into a white screen.

describe('parseProps: a kind this ship does not know', () => {
  it('refuses an unregistered kind, naming it', () => {
    const parsed = parseProps('poll', { question: 'q', options: ['a'] })
    expect(parsed).toEqual({
      ok: false,
      fault: 'unknown-kind',
      detail: 'poll',
    })
  })

  it('refuses the empty kind rather than guessing', () => {
    expect(parseProps('', {})).toMatchObject({ fault: 'unknown-kind' })
  })

  it('is case-sensitive — "Choice" is not "choice"', () => {
    // Kinds are opaque strings written by agents; matching loosely would let a
    // typo silently resolve to a different widget than the row says it is.
    expect(
      parseProps('Choice', { question: 'q', options: ['a'] }),
    ).toMatchObject({ fault: 'unknown-kind' })
  })

  it('knows exactly the kinds it lists', () => {
    expect([...WIDGET_KINDS]).toEqual(['choice'])
    for (const kind of WIDGET_KINDS) {
      expect(parseProps(kind, { question: 'q', options: ['a'] }).ok).toBe(true)
    }
  })
})

describe('parseProps: choice', () => {
  it('parses a well-formed choice', () => {
    expect(
      parseProps('choice', { question: 'Ship it?', options: ['Yes', 'No'] }),
    ).toEqual({
      ok: true,
      kind: 'choice',
      props: { question: 'Ship it?', options: ['Yes', 'No'] },
    })
  })

  it('keeps a single option — a one-button acknowledgement is legal', () => {
    expect(
      parseProps('choice', { question: 'Seen?', options: ['Ok'] }).ok,
    ).toBe(true)
  })

  it('ignores extra keys an agent throws in', () => {
    const parsed = parseProps('choice', {
      question: 'Ship it?',
      options: ['Yes'],
      colour: 'blue',
    })
    expect(parsed).toEqual({
      ok: true,
      kind: 'choice',
      props: { question: 'Ship it?', options: ['Yes'] },
    })
  })

  it.each([
    ['null', null],
    ['a string', '{"question":"q"}'],
    ['a number', 7],
    ['an array', [{ question: 'q' }]],
  ])('refuses props that are %s, not an object', (_label, json) => {
    expect(parseProps('choice', json)).toEqual({
      ok: false,
      fault: 'bad-props',
      detail: 'expected an object of props',
    })
  })

  it.each([
    ['missing', {}],
    ['not a string', { question: 42, options: ['Yes'] }],
    ['blank', { question: '   ', options: ['Yes'] }],
  ])('refuses a question that is %s', (_label, json) => {
    expect(parseProps('choice', json)).toEqual({
      ok: false,
      fault: 'bad-props',
      detail: 'question must be a non-empty string',
    })
  })

  it.each([
    ['missing', { question: 'q' }],
    ['not an array', { question: 'q', options: 'Yes' }],
    ['empty', { question: 'q', options: [] }],
    ['holding a non-string', { question: 'q', options: ['Yes', 3] }],
    ['holding a blank string', { question: 'q', options: ['Yes', ' '] }],
  ])('refuses options that are %s', (_label, json) => {
    expect(parseProps('choice', json)).toEqual({
      ok: false,
      fault: 'bad-props',
      detail: 'options must be a non-empty array of non-empty strings',
    })
  })

  it('reports the question fault first when both are wrong', () => {
    // One fault at a time, in field order: the tile shows one honest line.
    expect(parseProps('choice', {})).toMatchObject({
      detail: 'question must be a non-empty string',
    })
  })
})

describe('answerOptions', () => {
  it('is a choice widget’s options — the only answers it will accept', () => {
    const parsed = parseProps('choice', {
      question: 'Ship it?',
      options: ['Yes', 'No'],
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(answerOptions(parsed)).toEqual(['Yes', 'No'])
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
