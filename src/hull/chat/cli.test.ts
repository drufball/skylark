import { describe, expect, it } from 'vitest'

import { parseShowArgs } from './cli'

describe('parseShowArgs', () => {
  it('parses a bare chat id with the default limit', () => {
    expect(parseShowArgs(['chat-1'])).toEqual({ chatId: 'chat-1', limit: 20 })
  })

  it('extracts --limit wherever it sits', () => {
    expect(parseShowArgs(['chat-1', '--limit', '5'])).toEqual({
      chatId: 'chat-1',
      limit: 5,
    })
    expect(parseShowArgs(['--limit', '5', 'chat-1'])).toEqual({
      chatId: 'chat-1',
      limit: 5,
    })
  })

  it('yields an undefined chatId (a usage error upstream) when none is given', () => {
    expect(parseShowArgs([])).toEqual({ chatId: undefined, limit: 20 })
    expect(parseShowArgs(['--limit', '5'])).toEqual({
      chatId: undefined,
      limit: 5,
    })
  })

  it('rejects a --limit with no value, or with another flag where its value goes', () => {
    expect(() => parseShowArgs(['chat-1', '--limit'])).toThrow(
      /--limit requires/,
    )
    expect(() => parseShowArgs(['chat-1', '--limit', '--other'])).toThrow(
      /--limit requires/,
    )
  })

  it('rejects a non-numeric --limit', () => {
    expect(() => parseShowArgs(['chat-1', '--limit', 'lots'])).toThrow(
      /--limit requires/,
    )
  })

  it('rejects zero or a negative --limit', () => {
    // Unguarded, --limit 0 would mean messages.slice(-0) === slice(0) — every
    // message, the opposite of "show nothing" — and a negative limit would
    // silently become an offset window instead of a validation error.
    expect(() => parseShowArgs(['chat-1', '--limit', '0'])).toThrow(
      /--limit requires a positive number/,
    )
    expect(() => parseShowArgs(['chat-1', '--limit', '-5'])).toThrow(
      /--limit requires a positive number/,
    )
  })
})
