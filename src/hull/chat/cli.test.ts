import { describe, expect, it } from 'vitest'

import { parseScheduleNewArgs, parseShowArgs, parseWidgetNewArgs } from './cli'

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

describe('parseScheduleNewArgs', () => {
  it('parses a one-shot with --at, body being the trailing words', () => {
    expect(
      parseScheduleNewArgs([
        'chat-1',
        '--at',
        '2026-07-19T09:00:00Z',
        'good',
        'morning',
      ]),
    ).toEqual({
      chatId: 'chat-1',
      at: '2026-07-19T09:00:00Z',
      every: undefined,
      as: undefined,
      body: 'good morning',
    })
  })

  it('parses a recurring --every and a --as author, flags in any position', () => {
    expect(
      parseScheduleNewArgs([
        '--every',
        '30',
        'chat-1',
        '--as',
        '@tilde',
        'ping',
      ]),
    ).toEqual({
      chatId: 'chat-1',
      at: undefined,
      every: 30,
      as: '@tilde',
      body: 'ping',
    })
  })

  it('yields an undefined chatId / empty body upstream when args are missing', () => {
    expect(parseScheduleNewArgs([])).toEqual({
      chatId: undefined,
      at: undefined,
      every: undefined,
      as: undefined,
      body: '',
    })
  })

  it('rejects a flag with no value', () => {
    expect(() => parseScheduleNewArgs(['chat-1', '--at'])).toThrow(
      /--at requires a value/,
    )
  })

  it('rejects a non-numeric --every', () => {
    expect(() => parseScheduleNewArgs(['chat-1', '--every', 'lots'])).toThrow(
      /--every requires a number/,
    )
  })
})

describe('parseWidgetNewArgs', () => {
  it('parses a chat id, a question, and repeated --option flags in order', () => {
    expect(
      parseWidgetNewArgs([
        'chat-1',
        '--option',
        'Yes',
        '--option',
        'No',
        'Ship',
        'it?',
      ]),
    ).toEqual({
      chatId: 'chat-1',
      question: 'Ship it?',
      options: ['Yes', 'No'],
      order: undefined,
    })
  })

  it('takes --order for a position in the stack', () => {
    expect(
      parseWidgetNewArgs(['chat-1', '--option', 'Ok', '--order', '3', 'Seen?']),
    ).toEqual({
      chatId: 'chat-1',
      question: 'Seen?',
      options: ['Ok'],
      order: 3,
    })
  })

  it('accepts a comma-separated option list as one flag', () => {
    // The shorthand an agent reaches for first; both spellings must work.
    expect(
      parseWidgetNewArgs(['chat-1', '--options', 'Yes,No,Later', 'Ship it?']),
    ).toEqual({
      chatId: 'chat-1',
      question: 'Ship it?',
      options: ['Yes', 'No', 'Later'],
      order: undefined,
    })
  })

  it('yields no options / an empty question upstream when args are missing', () => {
    expect(parseWidgetNewArgs([])).toEqual({
      chatId: undefined,
      question: '',
      options: [],
      order: undefined,
    })
  })

  it('rejects a flag with no value', () => {
    expect(() => parseWidgetNewArgs(['chat-1', '--option'])).toThrow(
      /--option requires a value/,
    )
  })

  it('rejects a non-numeric --order', () => {
    expect(() =>
      parseWidgetNewArgs(['chat-1', '--option', 'Ok', '--order', 'top', 'Q?']),
    ).toThrow(/--order requires a number/)
  })
})
