import { describe, expect, it } from 'vitest'

import { formatAge, parseShowArgs } from './cli'

describe('parseShowArgs', () => {
  it('parses a bare session ref with the default tail', () => {
    expect(parseShowArgs(['abc123'])).toEqual({ ref: 'abc123', tail: 10 })
  })

  it('extracts --tail wherever it sits', () => {
    expect(parseShowArgs(['abc123', '--tail', '5'])).toEqual({
      ref: 'abc123',
      tail: 5,
    })
    expect(parseShowArgs(['--tail', '5', 'abc123'])).toEqual({
      ref: 'abc123',
      tail: 5,
    })
  })

  it('yields an undefined ref (a usage error upstream) when none is given', () => {
    expect(parseShowArgs([])).toEqual({ ref: undefined, tail: 10 })
    expect(parseShowArgs(['--tail', '5'])).toEqual({
      ref: undefined,
      tail: 5,
    })
  })

  it('rejects a --tail with no value, or with another flag where its value goes', () => {
    expect(() => parseShowArgs(['abc123', '--tail'])).toThrow(/--tail requires/)
    expect(() => parseShowArgs(['abc123', '--tail', '--other'])).toThrow(
      /--tail requires/,
    )
  })

  it('rejects a non-numeric --tail', () => {
    expect(() => parseShowArgs(['abc123', '--tail', 'lots'])).toThrow(
      /--tail requires/,
    )
  })

  it('rejects zero or a negative --tail', () => {
    expect(() => parseShowArgs(['abc123', '--tail', '0'])).toThrow(
      /--tail requires a positive number/,
    )
    expect(() => parseShowArgs(['abc123', '--tail', '-5'])).toThrow(
      /--tail requires a positive number/,
    )
  })
})

describe('formatAge', () => {
  const now = new Date('2026-07-18T12:00:00Z')

  it('renders seconds under a minute', () => {
    expect(formatAge(new Date('2026-07-18T11:59:45Z'), now)).toBe('15s ago')
  })

  it('renders minutes under an hour', () => {
    expect(formatAge(new Date('2026-07-18T11:45:00Z'), now)).toBe('15m ago')
  })

  it('renders hours under a day', () => {
    expect(formatAge(new Date('2026-07-18T04:00:00Z'), now)).toBe('8h ago')
  })

  it('renders days beyond that', () => {
    expect(formatAge(new Date('2026-07-15T12:00:00Z'), now)).toBe('3d ago')
  })

  it('clamps a future timestamp (clock skew) to zero rather than negative', () => {
    expect(formatAge(new Date('2026-07-18T12:00:05Z'), now)).toBe('0s ago')
  })
})
