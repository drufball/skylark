import { describe, expect, it } from 'vitest'

import { formatLocalTime } from './format-local-time'

describe('formatLocalTime', () => {
  it('formats an ISO timestamp in local time', () => {
    // A known UTC timestamp: 2024-03-15T14:30:00.000Z
    const iso = '2024-03-15T14:30:00.000Z'
    const result = formatLocalTime(iso)

    // Should return a string in the format "YYYY-MM-DD HH:MM"
    // The exact output depends on the local timezone, but we can check the format
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)

    // Verify it's a valid date conversion by round-tripping
    const parsed = new Date(iso)
    const year = String(parsed.getFullYear())
    const month = String(parsed.getMonth() + 1).padStart(2, '0')
    const day = String(parsed.getDate()).padStart(2, '0')
    const hours = String(parsed.getHours()).padStart(2, '0')
    const minutes = String(parsed.getMinutes()).padStart(2, '0')
    const expected = `${year}-${month}-${day} ${hours}:${minutes}`

    expect(result).toBe(expected)
  })

  it('handles timestamps at midnight', () => {
    const iso = '2024-01-01T00:00:00.000Z'
    const result = formatLocalTime(iso)

    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })

  it('handles timestamps with different date components', () => {
    const iso = '2023-12-31T23:59:00.000Z'
    const result = formatLocalTime(iso)

    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})
