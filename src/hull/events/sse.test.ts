import { describe, expect, it } from 'vitest'

import type { EventRow } from './schema'
import { parseTopics, sseFrame, toStreamEvent, type StreamEvent } from './sse'

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
  topic: 'session:s1',
  audience: 'members',
  actorId: null,
  payload: { text: 'hi' },
  createdAt: new Date(0),
  ...over,
})

const event = (over: Partial<StreamEvent> = {}): StreamEvent => ({
  id: '01',
  type: 'agent.message',
  source: 'agent',
  topic: 'session:s1',
  payload: { text: 'hi' },
  ...over,
})

describe('toStreamEvent', () => {
  it('lifts the fields a client sees from a durable row', () => {
    const e = toStreamEvent(row({ id: 'abc', actorId: 'u1' }))
    expect(e.id).toBe('abc')
    // actorId and createdAt are NOT in StreamEvent — clients don't see them.
    expect('actorId' in e).toBe(false)
    expect('createdAt' in e).toBe(false)
  })

  it('maps a null topic/audience to undefined', () => {
    const e = toStreamEvent(row({ topic: null, audience: null }))
    expect(e.topic).toBeUndefined()
    expect(e.audience).toBeUndefined()
  })
})

describe('sseFrame', () => {
  it('encodes the id and a JSON data line, no named event', () => {
    const frame = sseFrame(event({ id: 'abc', type: 'agent.status' }))
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

  it('carries the topic and payload in the data JSON', () => {
    const frame = sseFrame(event({ topic: 'issue:7', payload: { n: 7 } }))
    const dataLine = dataLineOf(frame)
    const parsed = JSON.parse(dataLine.slice('data: '.length)) as {
      topic: string
      payload: { n: number }
    }
    expect(parsed.topic).toBe('issue:7')
    expect(parsed.payload.n).toBe(7)
  })
})

describe('parseTopics', () => {
  it('splits a comma-separated topics param', () => {
    expect(parseTopics('issue:*,chat:c1')).toEqual(['issue:*', 'chat:c1'])
  })

  it('trims whitespace and drops empties', () => {
    expect(parseTopics(' issue:* , , chat:c1 ')).toEqual(['issue:*', 'chat:c1'])
  })

  it('returns the empty set when nothing is requested', () => {
    expect(parseTopics(null)).toEqual([])
    expect(parseTopics('')).toEqual([])
  })
})
