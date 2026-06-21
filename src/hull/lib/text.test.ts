import { describe, expect, it } from 'vitest'

import { firstLine, truncate } from './text'

describe('truncate', () => {
  it('leaves a string shorter than the limit untouched', () => {
    expect(truncate('hello', 10)).toBe('hello')
  })

  it('leaves a string exactly at the limit untouched', () => {
    // Boundary: length === max must NOT truncate (the cut is `length > max`).
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('replaces the tail with an ellipsis once over the limit', () => {
    // One past the limit: keep max-1 chars, then the single-char ellipsis.
    expect(truncate('hello', 4)).toBe('hel…')
    expect(truncate('abcdef', 3)).toBe('ab…')
  })
})

describe('firstLine', () => {
  it('returns a single trimmed line unchanged', () => {
    expect(firstLine('  hello  ')).toBe('hello')
  })

  it('takes the first line and drops the rest', () => {
    expect(firstLine('first\nsecond\nthird')).toBe('first')
  })

  it('trims the whole string before splitting, so leading blank lines are skipped', () => {
    // Without the outer trim the first "line" is the empty string before the
    // newline, so this pins that the leading newlines are stripped first.
    expect(firstLine('\n\nhello\nworld')).toBe('hello')
  })

  it('trims the chosen line itself, not just the whole string', () => {
    // The first line carries trailing spaces that the whole-string trim can't
    // reach; only the per-line trim removes them.
    expect(firstLine('  hi  \nthere')).toBe('hi')
  })
})
