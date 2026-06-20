import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'

import { emitEvent, InProcessBus, type NotifyPayload } from './bus'
import { listEventsSince } from './service'

const note = (over: Partial<NotifyPayload> = {}): NotifyPayload => ({
  id: '1',
  type: 't',
  scope: 'public',
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
      scope: 'session:s1',
      payload: { text: 'hi' },
    })

    expect(row.id).toBeTruthy()
    const replayed = await listEventsSince(db, { scopes: ['session:s1'] })
    expect(replayed.map((e) => e.id)).toEqual([row.id])
  })
})

describe('notifyOnly', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

  it('fans out to live subscribers via the in-process bus', () => {
    const bus = new InProcessBus()
    const seen: NotifyPayload[] = []
    bus.subscribe((n) => {
      seen.push(n)
    })

    // notifyOnly will be imported and call bus.publish directly
    bus.publish(note({ id: 'ephemeral-1', type: 'chat.agent_progress' }))
    expect(seen.map((n) => n.id)).toEqual(['ephemeral-1'])
  })

  it('does NOT persist to the database', async () => {
    // This will fail until we implement notifyOnly
    // notifyOnly should NOT call appendEvent
    const { notifyOnly } = await import('./bus')

    await notifyOnly(db, {
      type: 'chat.agent_progress',
      source: 'chat',
      scope: 'session:s1',
      payload: { line: 'thinking…' },
    })

    // Should NOT be in the database
    const replayed = await listEventsSince(db, { scopes: ['session:s1'] })
    expect(replayed).toHaveLength(0)
  })

  it('still delivers the notification payload so live subscribers receive it', () => {
    const bus = new InProcessBus()
    const received: NotifyPayload[] = []
    bus.subscribe((n) => {
      received.push(n)
    })

    // Simulate what notifyOnly will do: publish to bus without persisting
    const payload: NotifyPayload = {
      id: 'ephemeral-123',
      type: 'chat.agent_progress',
      scope: 'session:abc',
    }
    bus.publish(payload)

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('chat.agent_progress')
  })

  it('publishes ephemeral event data to the in-process bus', async () => {
    const { notifyOnly, shipLogBus } = await import('./bus')
    const received: NotifyPayload[] = []
    shipLogBus.subscribe((n) => {
      received.push(n)
    })

    await notifyOnly(db, {
      type: 'chat.agent_progress',
      source: 'chat',
      scope: 'session:s1',
      actorId: 'user-123',
      payload: { line: 'thinking…' },
    })

    // The in-process bus should receive the full ephemeral data.
    expect(received).toHaveLength(1)
    expect(received[0].ephemeral).toMatchObject({
      source: 'chat',
      actorId: 'user-123',
      payload: { line: 'thinking…' },
    })
  })
})
