import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import {
  appendEvent,
  canViewAudience,
  getEventById,
  isScopeVisible,
  listEventsSince,
  matchesTopic,
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

  it('appends an event with topic and audience (new schema)', async () => {
    const e = await appendEvent(db, {
      type: 'issue.status_changed',
      source: 'issues',
      topic: 'issue:123',
      audience: 'public',
      payload: { from: 'open', to: 'building' },
    })
    expect(e.topic).toBe('issue:123')
    expect(e.audience).toBe('public')
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

  it('lists events matching topic patterns', async () => {
    await appendEvent(db, {
      type: 'issue.status',
      source: 'issues',
      topic: 'issue:123',
      audience: 'public',
      payload: { n: 1 },
    })
    await appendEvent(db, {
      type: 'issue.status',
      source: 'issues',
      topic: 'issue:456',
      audience: 'public',
      payload: { n: 2 },
    })
    await appendEvent(db, {
      type: 'chat.message',
      source: 'chat',
      topic: 'chat:789',
      audience: 'members',
      payload: { n: 3 },
    })

    const issues = await listEventsSince(db, {
      topicPatterns: ['issue:*'],
      audience: 'public',
    })
    expect(issues.map((e) => (e.payload as { n: number }).n)).toEqual([1, 2])

    const oneIssue = await listEventsSince(db, {
      topicPatterns: ['issue:123'],
      audience: 'public',
    })
    expect(oneIssue.map((e) => (e.payload as { n: number }).n)).toEqual([1])
  })

  it('finds a matching event beyond the first scan window (no silent drop)', async () => {
    // A long run of non-matching events, then one match far down the log. A
    // naive "fetch limit*N rows then filter" replay would never see the match
    // and would falsely report "caught up"; the scan must page until it finds it.
    for (let i = 0; i < 10; i++) {
      await appendEvent(db, {
        type: 't',
        source: 's',
        topic: `other:${String(i)}`,
        audience: 'public',
        payload: { i },
      })
    }
    await appendEvent(db, {
      type: 't',
      source: 's',
      topic: 'issue:123',
      audience: 'public',
      payload: { hit: true },
    })

    const got = await listEventsSince(db, {
      topicPatterns: ['issue:*'],
      audience: 'public',
      limit: 2,
    })
    expect(got).toHaveLength(1)
    expect((got[0].payload as { hit: boolean }).hit).toBe(true)
  })

  it('caps the topic replay to the limit, returning the earliest matches', async () => {
    for (let i = 0; i < 5; i++) {
      await appendEvent(db, {
        type: 't',
        source: 's',
        topic: `issue:${String(i)}`,
        audience: 'public',
        payload: { i },
      })
    }
    const got = await listEventsSince(db, {
      topicPatterns: ['issue:*'],
      audience: 'public',
      limit: 2,
    })
    expect(got.map((e) => (e.payload as { i: number }).i)).toEqual([0, 1])
  })

  it('replay audience filtering agrees with canViewAudience on every pair', async () => {
    // The SQL clause in listEventsSince and the in-memory canViewAudience
    // predicate (used by the live fan-out) both encode "members ⊇ public". Pin
    // them together so a future audience tier can't drift the two apart.
    const audiences = ['public', 'members']
    for (const eventAudience of audiences) {
      await appendEvent(db, {
        type: 't',
        source: 's',
        topic: `t:${eventAudience}`,
        audience: eventAudience,
        payload: { eventAudience },
      })
    }

    for (const viewerAccess of audiences) {
      const visible = await listEventsSince(db, {
        topicPatterns: ['t:*'],
        audience: viewerAccess,
      })
      const visibleAudiences = new Set(visible.map((e) => e.audience))
      for (const eventAudience of audiences) {
        expect(visibleAudiences.has(eventAudience)).toBe(
          canViewAudience(eventAudience, viewerAccess),
        )
      }
    }
  })

  it('filters events by audience access (members see public + members)', async () => {
    await appendEvent(db, {
      type: 'chat.message',
      source: 'chat',
      topic: 'chat:123',
      audience: 'members',
      payload: { n: 1 },
    })
    await appendEvent(db, {
      type: 'issue.status',
      source: 'issues',
      topic: 'issue:456',
      audience: 'public',
      payload: { n: 2 },
    })

    // Members see both public and members events
    const membersView = await listEventsSince(db, {
      topicPatterns: ['*'],
      audience: 'members',
    })
    expect(membersView.some((e) => e.audience === 'public')).toBe(true)
    expect(membersView.some((e) => e.audience === 'members')).toBe(true)

    // Public view sees only public events
    const publicView = await listEventsSince(db, {
      topicPatterns: ['*'],
      audience: 'public',
    })
    expect(publicView.every((e) => e.audience === 'public')).toBe(true)
    expect(publicView.some((e) => e.audience === 'members')).toBe(false)
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

describe('topic pattern matching', () => {
  it('matches exact topic strings', () => {
    expect(matchesTopic('issue:123', 'issue:123')).toBe(true)
    expect(matchesTopic('issue:123', 'issue:456')).toBe(false)
  })

  it('matches wildcard patterns', () => {
    expect(matchesTopic('issue:123', 'issue:*')).toBe(true)
    expect(matchesTopic('issue:456', 'issue:*')).toBe(true)
    expect(matchesTopic('chat:789', 'issue:*')).toBe(false)
  })

  it('matches the public topic exactly', () => {
    expect(matchesTopic('public', 'public')).toBe(true)
    expect(matchesTopic('public', '*')).toBe(true)
  })

  it('supports multiple segment wildcards', () => {
    expect(matchesTopic('issue:123:comment', 'issue:*')).toBe(true)
    expect(matchesTopic('issue:123:comment', 'issue:*:comment')).toBe(true)
    expect(matchesTopic('issue:123:status', 'issue:*:comment')).toBe(false)
  })
})

describe('audience filtering', () => {
  it('allows public events to everyone', () => {
    expect(canViewAudience('public', 'public')).toBe(true)
    expect(canViewAudience('public', 'members')).toBe(true)
  })

  it('restricts members-only events to members', () => {
    expect(canViewAudience('members', 'members')).toBe(true)
    expect(canViewAudience('members', 'public')).toBe(false)
  })

  it('members can see both public and members-only events', () => {
    // Access hierarchy: members ⊇ public
    expect(canViewAudience('public', 'members')).toBe(true)
    expect(canViewAudience('members', 'members')).toBe(true)
  })
})
