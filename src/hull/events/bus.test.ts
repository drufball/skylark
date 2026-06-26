import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'

import { emitEvent, InProcessBus, type NotifyPayload } from './bus'
import { listEventsSince } from './service'

const note = (over: Partial<NotifyPayload> = {}): NotifyPayload => ({
  id: '1',
  type: 't',
  topic: 'issue:1',
  audience: 'public',
  ...over,
})

describe('InProcessBus', () => {
  it('delivers a notification to a subscriber', () => {
    const bus = new InProcessBus()
    const seen: NotifyPayload[] = []
    bus.subscribe((n) => {
      seen.push(n)
    })

    bus.publish(note({ id: 'a' }))
    expect(seen.map((n) => n.id)).toEqual(['a'])
  })

  it('fans out to every subscriber', () => {
    const bus = new InProcessBus()
    let one = 0
    let two = 0
    bus.subscribe(() => one++)
    bus.subscribe(() => two++)

    bus.publish(note())
    expect([one, two]).toEqual([1, 1])
  })

  it('stops delivering after unsubscribe', () => {
    const bus = new InProcessBus()
    const seen: string[] = []
    const off = bus.subscribe((n) => seen.push(n.id))

    bus.publish(note({ id: 'a' }))
    off()
    bus.publish(note({ id: 'b' }))
    expect(seen).toEqual(['a'])
  })

  it('isolates a throwing subscriber from the others', () => {
    const bus = new InProcessBus()
    const seen: string[] = []
    bus.subscribe(() => {
      throw new Error('boom')
    })
    bus.subscribe((n) => {
      seen.push(n.id)
    })

    expect(() => {
      bus.publish(note({ id: 'a' }))
    }).not.toThrow()
    expect(seen).toEqual(['a'])
  })
})

describe('emitEvent', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

  it('appends a durable row that the stream can replay', async () => {
    const row = await emitEvent(db, {
      type: 'agent.message',
      source: 'agent',
      topic: 'session:s1',
      audience: 'members',
      payload: { text: 'hi' },
    })

    expect(row.id).toBeTruthy()
    const replayed = await listEventsSince(db, {
      topicPatterns: ['session:s1'],
      audience: 'members',
    })
    expect(replayed.map((e) => e.id)).toEqual([row.id])
  })

  it('appends a system event with no topic or audience', async () => {
    const row = await emitEvent(db, {
      type: 'system.tick',
      source: 'system',
      payload: {},
    })
    expect(row.topic).toBeNull()
    expect(row.audience).toBeNull()
  })
})

describe('notifyOnly', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

  it('does NOT persist to the database', async () => {
    const { notifyOnly } = await import('./bus')

    notifyOnly({
      type: 'chat.agent_progress',
      source: 'chat',
      topic: 'chat:c1',
      audience: 'members',
      payload: { line: 'thinking…' },
    })

    // Should NOT be in the database
    const replayed = await listEventsSince(db, {
      topicPatterns: ['chat:c1'],
      audience: 'members',
    })
    expect(replayed).toHaveLength(0)
  })

  it('publishes ephemeral data with its topic + audience to the in-process bus', async () => {
    const { notifyOnly, shipLogBus } = await import('./bus')
    const received: NotifyPayload[] = []
    shipLogBus.subscribe((n) => {
      received.push(n)
    })

    notifyOnly({
      type: 'chat.agent_progress',
      source: 'chat',
      topic: 'chat:c1',
      audience: 'members',
      payload: { line: 'thinking…' },
    })

    // The note carries the topic + audience facets so the SSE route can gate
    // it exactly like a durable event, plus the full ephemeral data.
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ topic: 'chat:c1', audience: 'members' })
    expect(received[0].ephemeral).toMatchObject({
      source: 'chat',
      payload: { line: 'thinking…' },
    })
  })
})
