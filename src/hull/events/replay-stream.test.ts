import { describe, expect, it, vi } from 'vitest'

import type { EventRow } from './schema'
import type { NotifyPayload } from './bus'
import { REPLAY_PAGE_SIZE } from './service'
import {
  noteIsVisible,
  runShipLogStream,
  type ShipLogStreamDeps,
} from './replay-stream'

/** A durable event row; only the fields toStreamEvent reads need to be real. */
function row(over: Partial<EventRow> = {}): EventRow {
  return {
    id: 'e0001',
    type: 'issue.opened',
    source: 'issues',
    topic: 'issue:1',
    audience: 'members',
    actorId: null,
    payload: { n: 1 },
    createdAt: new Date(0),
    ...over,
  }
}

/** A live notification (durable: id only; ephemeral: carries its data). */
function note(over: Partial<NotifyPayload> = {}): NotifyPayload {
  return { id: 'e0001', type: 'issue.opened', topic: 'issue:1', ...over }
}

/** A one-listener stand-in for shipLogBus. */
function fakeBus() {
  let listener: ((n: NotifyPayload) => void) | null = null
  return {
    subscribe(l: (n: NotifyPayload) => void) {
      listener = l
      return () => {
        listener = null
      }
    },
    publish(n: NotifyPayload) {
      listener?.(n)
    },
    get live() {
      return listener !== null
    },
  }
}

/** Let fire-and-forget durable fetches (getEventById().then(send)) settle. */
const tick = () => new Promise((r) => setTimeout(r, 0))

const TOPICS = { topicPatterns: ['issue:*'], audience: 'members' }

describe('noteIsVisible', () => {
  it('requires a topic that matches a requested pattern', () => {
    expect(noteIsVisible(note({ topic: 'issue:1' }), TOPICS)).toBe(true)
    expect(noteIsVisible(note({ topic: 'chat:1' }), TOPICS)).toBe(false)
    expect(noteIsVisible(note({ topic: undefined }), TOPICS)).toBe(false)
  })

  it('matches if ANY requested pattern matches (not all)', () => {
    const many = { topicPatterns: ['issue:*', 'chat:*'], audience: 'members' }
    // Matches issue:* but not chat:* — `some`, not `every`.
    expect(noteIsVisible(note({ topic: 'issue:1' }), many)).toBe(true)
    expect(noteIsVisible(note({ topic: 'chat:9' }), many)).toBe(true)
    expect(noteIsVisible(note({ topic: 'agent:7' }), many)).toBe(false)
  })

  it('enforces audience access', () => {
    // members-only note, members viewer → visible
    expect(
      noteIsVisible(note({ audience: 'members' }), {
        ...TOPICS,
        audience: 'members',
      }),
    ).toBe(true)
    // members-only note, public viewer → hidden
    expect(
      noteIsVisible(note({ audience: 'members' }), {
        ...TOPICS,
        audience: 'public',
      }),
    ).toBe(false)
    // a note with no audience is unrestricted
    expect(noteIsVisible(note({ audience: undefined }), TOPICS)).toBe(true)
  })

  it('drops anything at or below the replay cutoff (dedup)', () => {
    const opts = { ...TOPICS, lastReplayedId: 'e0005' }
    expect(noteIsVisible(note({ id: 'e0004' }), opts)).toBe(false)
    expect(noteIsVisible(note({ id: 'e0005' }), opts)).toBe(false) // boundary
    expect(noteIsVisible(note({ id: 'e0006' }), opts)).toBe(true)
    // no cutoff yet → not dropped on id
    expect(noteIsVisible(note({ id: 'e0001' }), TOPICS)).toBe(true)
  })
})

describe('runShipLogStream', () => {
  function harness(over: Partial<ShipLogStreamDeps> = {}) {
    const bus = fakeBus()
    const sent: string[] = []
    const deps: ShipLogStreamDeps = {
      subscribe: (l) => bus.subscribe(l),
      listEventsSince: vi.fn().mockResolvedValue([]),
      getEventById: vi.fn().mockResolvedValue(undefined),
      canSee: () => Promise.resolve(true),
      send: (t) => sent.push(t),
      ...over,
    }
    return { bus, sent, deps }
  }

  /** ids present in the data frames sent (ignores `: comment` lines). */
  const sentIds = (sent: string[]) =>
    sent
      .filter((f) => f.startsWith('id: '))
      .map((f) => f.slice(4, f.indexOf('\n')))

  it('replays durable events in order, then marks the stream live', async () => {
    const { sent, deps } = harness({
      listEventsSince: vi
        .fn()
        .mockResolvedValue([row({ id: 'e0001' }), row({ id: 'e0002' })]),
    })

    await runShipLogStream(deps, { ...TOPICS })

    expect(sentIds(sent)).toEqual(['e0001', 'e0002'])
    expect(sent.at(-1)).toBe(': connected\n\n')
  })

  it('drains replay in pages until a short page (loses nothing past the cap)', async () => {
    const fullPage = Array.from({ length: REPLAY_PAGE_SIZE }, (_, i) =>
      row({ id: `e${String(i).padStart(4, '0')}` }),
    )
    const listEventsSince = vi
      .fn()
      .mockResolvedValueOnce(fullPage) // exactly a page → must fetch again
      .mockResolvedValueOnce([row({ id: 'f0001' })]) // short page → stop
    const { sent, deps } = harness({ listEventsSince })

    await runShipLogStream(deps, { ...TOPICS })

    expect(listEventsSince).toHaveBeenCalledTimes(2)
    // The second page resumes after the highest id of the first.
    expect(listEventsSince.mock.calls[1][0]).toMatchObject({
      sinceId: `e${String(REPLAY_PAGE_SIZE - 1).padStart(4, '0')}`,
    })
    expect(sentIds(sent)).toContain('f0001')
  })

  it('buffers a note that arrives during replay and flushes it after — deduped', async () => {
    const bus = fakeBus()
    const sent: string[] = []
    // While the (single) replay page is being fetched, two live notes land:
    // one already covered by replay (<= cutoff) and one newer.
    const listEventsSince = vi.fn().mockImplementation(() => {
      expect(bus.live).toBe(true) // subscribed BEFORE replay — no gap
      bus.publish(note({ id: 'e0001' })) // <= cutoff e0002 → must be deduped
      bus.publish(note({ id: 'e0009' })) // newer → must be delivered
      return Promise.resolve([row({ id: 'e0002' })])
    })
    const deps: ShipLogStreamDeps = {
      subscribe: (l) => bus.subscribe(l),
      listEventsSince,
      getEventById: (id) => Promise.resolve(row({ id })),
      canSee: () => Promise.resolve(true),
      send: (t) => sent.push(t),
    }

    await runShipLogStream(deps, { ...TOPICS })
    await tick() // let the durable flush fetch resolve

    const ids = sentIds(sent)
    expect(ids).toContain('e0002') // replayed
    expect(ids).toContain('e0009') // buffered-then-flushed
    expect(ids).not.toContain('e0001') // deduped against the replay cutoff
  })

  it('delivers live notes after replay: ephemeral inline, durable fetched', async () => {
    // The durable row is missing for e0404 (raced a delete) → nothing framed.
    const { bus, sent, deps } = harness({
      getEventById: (id) =>
        Promise.resolve(id === 'e0404' ? undefined : row({ id })),
    })
    await runShipLogStream(deps, { ...TOPICS })

    // Durable live note carries only an id → fetched and framed.
    bus.publish(note({ id: 'e0100' }))
    // A durable note whose row is gone → fetched, but nothing sent.
    bus.publish(note({ id: 'e0404' }))
    await tick()
    expect(sentIds(sent)).toContain('e0100')
    expect(sentIds(sent)).not.toContain('e0404')

    // Ephemeral live note carries its data → framed without a DB read (but
    // still gated by entitlement, so delivery is a microtask, not synchronous).
    bus.publish(
      note({
        id: 'e0101',
        ephemeral: { source: 'chat', payload: { line: 'hi' } },
      }),
    )
    await tick()
    expect(sentIds(sent)).toContain('e0101')
  })

  it('survives a durable fetch that rejects (dropped frame, no crash)', async () => {
    const { bus, sent, deps } = harness({
      getEventById: () => Promise.reject(new Error('db blip')),
    })
    await runShipLogStream(deps, { ...TOPICS })
    const before = sent.length

    // A live durable note whose row read fails must not surface an unhandled
    // rejection or send a frame — the next reconnect replays it.
    bus.publish(note({ id: 'e0300' }))
    await tick()

    expect(sent.length).toBe(before)
  })

  it('ignores live notes that fail the topic/audience gate', async () => {
    const { bus, sent, deps } = harness({
      getEventById: (id) => Promise.resolve(row({ id })),
    })
    await runShipLogStream(deps, { ...TOPICS })
    const before = sent.length

    bus.publish(note({ id: 'e0200', topic: 'chat:9' })) // wrong topic
    bus.publish(note({ id: 'e0201', audience: 'admin' })) // unknown audience → denied
    await tick()

    expect(sent.length).toBe(before)
  })

  it('unsubscribes and rethrows when replay fails', async () => {
    const bus = fakeBus()
    const deps: ShipLogStreamDeps = {
      subscribe: (l) => bus.subscribe(l),
      listEventsSince: () => Promise.reject(new Error('db down')),
      getEventById: vi.fn(),
      canSee: () => Promise.resolve(true),
      send: vi.fn(),
    }

    await expect(runShipLogStream(deps, { ...TOPICS })).rejects.toThrow(
      'db down',
    )
    expect(bus.live).toBe(false) // cleaned up, no leaked subscription
  })

  // --- entitlement gate (the chat read-leak fix) ---------------------------

  const CHATS = { topicPatterns: ['chat:*'], audience: 'members' }

  it('drops replayed events the actor is not entitled to see', async () => {
    // Both rows match the chat:* pattern + members audience, but canSee only
    // clears chat:1 — chat:2 must not be sent even though it was returned.
    const { sent, deps } = harness({
      listEventsSince: vi
        .fn()
        .mockResolvedValue([
          row({ id: 'a', topic: 'chat:1' }),
          row({ id: 'b', topic: 'chat:2' }),
        ]),
      canSee: (topic) => Promise.resolve(topic === 'chat:1'),
    })

    await runShipLogStream(deps, { ...CHATS })

    expect(sentIds(sent)).toContain('a')
    expect(sentIds(sent)).not.toContain('b')
  })

  it('drops a live note the actor is not entitled to see', async () => {
    const { bus, sent, deps } = harness({
      getEventById: (id) => Promise.resolve(row({ id })),
      canSee: (topic) => Promise.resolve(topic === 'chat:1'),
    })
    await runShipLogStream(deps, { ...CHATS })

    bus.publish(note({ id: 'live-a', topic: 'chat:1' }))
    bus.publish(note({ id: 'live-b', topic: 'chat:2' }))
    await tick()

    expect(sentIds(sent)).toContain('live-a')
    expect(sentIds(sent)).not.toContain('live-b')
  })

  it('probes entitlement once per topic, then caches', async () => {
    const canSee = vi.fn().mockResolvedValue(true)
    const { bus, deps } = harness({
      getEventById: (id) => Promise.resolve(row({ id })),
      canSee,
    })
    await runShipLogStream(deps, { ...CHATS })

    bus.publish(note({ id: 'n1', topic: 'chat:1' }))
    bus.publish(note({ id: 'n2', topic: 'chat:1' }))
    bus.publish(note({ id: 'n3', topic: 'chat:1' }))
    await tick()

    expect(canSee).toHaveBeenCalledTimes(1)
    expect(canSee).toHaveBeenCalledWith('chat:1')
  })
})
