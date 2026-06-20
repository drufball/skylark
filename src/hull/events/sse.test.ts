import { describe, expect, it } from 'vitest'

import type { EventRow } from './schema'
import { parseTopics, sseFrame } from './sse'

/** Pull the `data:` line out of an SSE frame, failing loudly if it's missing. */
function dataLineOf(frame: string): string {
  const line = frame.split('\n').find((l) => l.startsWith('data: '))
  if (!line) throw new Error('no data line in frame')
  return line
}

const row = (over: Partial<EventRow> = {}): EventRow => ({
  id: '01',
  type: 'agent.message',
  source: 'agent',
  scope: 'session:s1',
  topic: null,
  audience: null,
  actorId: null,
  payload: { text: 'hi' },
  createdAt: new Date(0),
  ...over,
})

describe('sseFrame', () => {
  it('encodes the id and a JSON data line, no named event', () => {
    const frame = sseFrame(row({ id: 'abc', type: 'agent.status' }))
    expect(frame).toContain('id: abc\n')
    // No named event line — everything arrives as the default `message` event.
    expect(frame).not.toContain('event:')
    expect(frame).toContain('data: ')
    // The type travels inside the data JSON, not as an SSE event name.
    const dataLine = dataLineOf(frame)
    const parsed = JSON.parse(dataLine.slice('data: '.length)) as {
      type: string
    }
    expect(parsed.type).toBe('agent.status')
    // terminated by a blank line, per the SSE wire format
    expect(frame.endsWith('\n\n')).toBe(true)
  })

  it('carries the scope and payload in the data JSON', () => {
    const frame = sseFrame(row({ scope: 'public', payload: { n: 7 } }))
    const dataLine = dataLineOf(frame)
    const parsed = JSON.parse(dataLine.slice('data: '.length)) as {
      scope: string
      payload: { n: number }
    }
    expect(parsed.scope).toBe('public')
    expect(parsed.payload.n).toBe(7)
  })
})

describe('parseTopics', () => {
  it('splits a comma-separated topics param', () => {
    expect(parseTopics('public,session:s1')).toEqual(['public', 'session:s1'])
  })

  it('trims whitespace and drops empties', () => {
    expect(parseTopics(' public , , session:s1 ')).toEqual([
      'public',
      'session:s1',
    ])
  })

  it('returns the public scope when nothing is requested', () => {
    expect(parseTopics(null)).toEqual(['public'])
    expect(parseTopics('')).toEqual(['public'])
  })
})
