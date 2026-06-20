import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import {
  appendEvent,
  getEventById,
  isScopeVisible,
  listEventsSince,
  PUBLIC_SCOPE,
} from './service'

describe('events service', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

  it('appends an event and returns it with a time-ordered id', async () => {
    const e = await appendEvent(db, {
      type: 'agent.message',
      source: 'agent',
      scope: 'session:s1',
      payload: { hello: 'world' },
    })
    expect(e.id).toBeTruthy()
    expect(e.payload).toEqual({ hello: 'world' })
    expect(e.actorId).toBeNull()
  })

  it('records the actor when given one', async () => {
    const actor = await createUser(db, {
      id: 'u1',
      handle: 'drufball',
      displayName: 'Dru',
      type: 'human',
    })
    const e = await appendEvent(db, {
      type: 'agent.message',
      source: 'agent',
      scope: 'public',
      actorId: actor.id,
      payload: {},
    })
    expect(e.actorId).toBe('u1')
  })

  it('reads one event back by id, undefined when missing', async () => {
    const e = await appendEvent(db, {
      type: 't',
      source: 's',
      scope: 'public',
      payload: { n: 1 },
    })
    expect(await getEventById(db, e.id)).toMatchObject({ id: e.id })
    expect(await getEventById(db, 'nope')).toBeUndefined()
  })

  it('lists events for the given scopes, oldest first', async () => {
    await appendEvent(db, {
      type: 't',
      source: 's',
      scope: 'session:a',
      payload: { n: 1 },
    })
    await appendEvent(db, {
      type: 't',
      source: 's',
      scope: 'session:b',
      payload: { n: 2 },
    })
    await appendEvent(db, {
      type: 't',
      source: 's',
      scope: 'session:a',
      payload: { n: 3 },
    })

    const got = await listEventsSince(db, { scopes: ['session:a'] })
    expect(got.map((e) => (e.payload as { n: number }).n)).toEqual([1, 3])
  })

  it('replays only events after the cursor', async () => {
    const first = await appendEvent(db, {
      type: 't',
      source: 's',
      scope: 'session:a',
      payload: { n: 1 },
    })
    await appendEvent(db, {
      type: 't',
      source: 's',
      scope: 'session:a',
      payload: { n: 2 },
    })

    const after = await listEventsSince(db, {
      scopes: ['session:a'],
      sinceId: first.id,
    })
    expect(after.map((e) => (e.payload as { n: number }).n)).toEqual([2])
  })

  it('returns nothing when no scopes are requested', async () => {
    await appendEvent(db, {
      type: 't',
      source: 's',
      scope: 'public',
      payload: {},
    })
    expect(await listEventsSince(db, { scopes: [] })).toEqual([])
  })

  it('caps the replay to a sane limit', async () => {
    for (let i = 0; i < 5; i++) {
      await appendEvent(db, {
        type: 't',
        source: 's',
        scope: 'public',
        payload: { i },
      })
    }
    const got = await listEventsSince(db, { scopes: ['public'], limit: 2 })
    expect(got).toHaveLength(2)
  })
})

describe('isScopeVisible', () => {
  it('lets a subscriber see a scope they explicitly subscribed to', () => {
    expect(isScopeVisible('session:a', ['session:a'])).toBe(true)
  })

  it('hides a scope the subscriber did not ask for', () => {
    expect(isScopeVisible('session:b', ['session:a'])).toBe(false)
  })

  it('always lets the public scope through to a public subscriber', () => {
    expect(isScopeVisible(PUBLIC_SCOPE, [PUBLIC_SCOPE])).toBe(true)
  })
})
