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
