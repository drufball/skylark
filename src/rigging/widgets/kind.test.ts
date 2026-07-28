import { describe, expect, it } from 'vitest'

import { parseLimit, parseStringList } from './kind'

// The shared prop parsers the kinds compose. Each kind's own tests pin its
// refusal strings end to end; these pin the helpers' contracts directly.

describe('parseStringList', () => {
  it('accepts absence — the field is optional', () => {
    expect(parseStringList(undefined, 'statuses')).toEqual({ ok: true })
  })

  it('accepts a list of filled strings, handing it back', () => {
    expect(parseStringList(['open', 'building'], 'statuses')).toEqual({
      ok: true,
      list: ['open', 'building'],
    })
  })

  it.each([
    ['not an array', 'open'],
    ['an empty array', []],
    ['holding a non-string', ['open', 3]],
    ['holding a blank string', ['open', '  ']],
  ])('refuses %s, naming the field', (_label, value) => {
    expect(parseStringList(value, 'issueIds')).toEqual({
      ok: false,
      detail: 'issueIds must be a non-empty array of non-empty strings',
    })
  })
})

describe('parseLimit', () => {
  it('accepts absence — a kind falls back to its own default', () => {
    expect(parseLimit(undefined, 20)).toEqual({ ok: true })
  })

  it('accepts a whole number inside the bounds, handing it back', () => {
    expect(parseLimit(1, 20)).toEqual({ ok: true, limit: 1 })
    expect(parseLimit(20, 20)).toEqual({ ok: true, limit: 20 })
  })

  it.each([
    ['not a number', 'five'],
    ['zero', 0],
    ['negative', -2],
    ['fractional', 2.5],
    ['over the cap', 5000],
  ])('refuses a limit that is %s, spelling the bounds', (_label, value) => {
    expect(parseLimit(value, 50)).toEqual({
      ok: false,
      detail: 'limit must be a whole number from 1 to 50',
    })
  })
})
