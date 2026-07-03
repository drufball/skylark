import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'

import {
  emitEvent,
  InProcessBus,
  shipLogBus,
  subscribeToShipLog,
  type NotifyPayload,
  type ShipLogReactor,
} from './bus'
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

describe('subscribeToShipLog', () => {
  /** Wait for the microtask queue so a handler's rejection settles. */
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  const reactor = (over: Partial<ShipLogReactor> = {}): ShipLogReactor => ({
    handleBusNote: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    ...over,
  })

  let errors: MockInstance
  const cleanups: (() => void)[] = []

  beforeEach(() => {
    errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })
  afterEach(() => {
    for (const off of cleanups.splice(0)) off()
    errors.mockRestore()
  })

  it('arms the listener and drives the reactor with published notes', async () => {
    const ensureListener = vi.fn()
    const seen: string[] = []
    cleanups.push(
      subscribeToShipLog(
        reactor({
          handleBusNote: (n) => {
            seen.push(n.id)
            return Promise.resolve()
          },
        }),
        'test',
        ensureListener,
      ),
    )

    shipLogBus.publish(note({ id: 'a' }))
    await settle()
    expect(seen).toEqual(['a'])
    expect(ensureListener).toHaveBeenCalledTimes(1)
  })

  it('isolates a REJECTING handleBusNote: other subscribers still get the note, the failure is logged', async () => {
    cleanups.push(
      subscribeToShipLog(
        reactor({
          handleBusNote: () => Promise.reject(new Error('reactor boom')),
        }),
        'issues orchestrator',
        vi.fn(),
      ),
    )
    const seen: string[] = []
    cleanups.push(shipLogBus.subscribe((n) => seen.push(n.id)))

    // Vitest fails a test on an unhandled rejection — surviving `settle` IS
    // the "no unhandled rejection" assertion.
    shipLogBus.publish(note({ id: 'a' }))
    await settle()
    expect(seen).toEqual(['a'])
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('issues orchestrator bus handler failed'),
    )
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('reactor boom'))
  })

  it('isolates a SYNCHRONOUSLY throwing handleBusNote the same way', async () => {
    cleanups.push(
      subscribeToShipLog(
        reactor({
          handleBusNote: () => {
            throw new Error('sync boom')
          },
        }),
        'notifications',
        vi.fn(),
      ),
    )
    const seen: string[] = []
    cleanups.push(shipLogBus.subscribe((n) => seen.push(n.id)))

    shipLogBus.publish(note({ id: 'a' }))
    await settle()
    expect(seen).toEqual(['a'])
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('notifications bus handler failed'),
    )
  })

  it('logs a rejecting reconcile instead of throwing', async () => {
    expect(() => {
      cleanups.push(
        subscribeToShipLog(
          reactor({
            reconcile: () => Promise.reject(new Error('reconcile boom')),
          }),
          'issues orchestrator',
          vi.fn(),
        ),
      )
    }).not.toThrow()

    await settle()
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('issues orchestrator reconcile failed'),
    )
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('reconcile boom'),
    )
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
    const unsubscribe = shipLogBus.subscribe((n) => {
      received.push(n)
    })

    try {
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
      expect(received[0]).toMatchObject({
        topic: 'chat:c1',
        audience: 'members',
      })
      expect(received[0].ephemeral).toMatchObject({
        source: 'chat',
        payload: { line: 'thinking…' },
      })
    } finally {
      unsubscribe()
    }
  })
})
