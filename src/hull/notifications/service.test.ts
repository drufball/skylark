import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'
import { listEventsSince } from '@hull/events/service'
import { createIssue, addComment, transitionIssue } from '@hull/issues/service'
import { createUser } from '@hull/users/service'
import { issueTopic } from '@hull/issues/topic'

import {
  addNotification,
  createNotificationsReactor,
  describeNotification,
  isAutoWatchTopic,
  isWatching,
  listNotifications,
  listUnread,
  listWatchers,
  markAllRead,
  NOTIFICATION_CREATED,
  unreadCount,
  unwatchTopic,
  watchTopic,
} from './service'
import { notifyTopic, userIdFromNotifyTopic } from './topic'

describe('notify topic namespace', () => {
  it('round-trips a user id through the topic grammar', () => {
    expect(notifyTopic('u1')).toBe('notify:u1')
    expect(userIdFromNotifyTopic('notify:u1')).toBe('u1')
    expect(userIdFromNotifyTopic('issue:u1')).toBeNull()
  })
})

describe('isAutoWatchTopic', () => {
  it('acting on an issue subscribes you; chat and session topics do not', () => {
    expect(isAutoWatchTopic('issue:abcd')).toBe(true)
    expect(isAutoWatchTopic('chat:c1')).toBe(false)
    expect(isAutoWatchTopic('session:s1')).toBe(false)
    expect(isAutoWatchTopic('notify:u1')).toBe(false)
  })
})

describe('describeNotification', () => {
  it('renders the issue lifecycle in crew language', () => {
    expect(
      describeNotification({
        type: 'issue.opened',
        topic: 'issue:aa11',
        payload: { issueId: 'i', title: 'Fix the mast' },
        actorHandle: 'tilde',
      }),
    ).toBe('@tilde opened "Fix the mast"')
    expect(
      describeNotification({
        type: 'issue.commented',
        topic: 'issue:aa11',
        payload: {},
        actorHandle: 'dru',
      }),
    ).toBe('@dru commented')
    expect(
      describeNotification({
        type: 'issue.status_changed',
        topic: 'issue:aa11',
        payload: { from: 'open', to: 'building' },
        actorHandle: 'builder',
      }),
    ).toBe('@builder moved it: open → building')
  })

  it('keeps an unknown event type legible', () => {
    expect(
      describeNotification({
        type: 'files.staging_merged',
        topic: 'files:staging',
        payload: {},
        actorHandle: '?',
      }),
    ).toBe('files.staging_merged on files:staging')
  })
})

describe('notifications service', () => {
  let db: Database
  let close: () => Promise<void>
  let alice: string
  let bob: string

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    alice = uuidv7()
    bob = uuidv7()
    await createUser(db, {
      id: alice,
      handle: 'alice',
      displayName: 'Alice',
      type: 'human',
    })
    await createUser(db, {
      id: bob,
      handle: 'bob',
      displayName: 'Bob',
      type: 'agent',
    })
  })
  afterEach(() => close())

  it('watch/unwatch round-trips, idempotently', async () => {
    await watchTopic(db, alice, 'issue:aa11')
    await watchTopic(db, alice, 'issue:aa11') // twice is fine
    expect(await isWatching(db, alice, 'issue:aa11')).toBe(true)
    expect(await listWatchers(db, 'issue:aa11')).toEqual([alice])
    await unwatchTopic(db, alice, 'issue:aa11')
    expect(await isWatching(db, alice, 'issue:aa11')).toBe(false)
  })

  it('an inbox entry is stored and announced on the owner private topic', async () => {
    await addNotification(db, {
      userId: alice,
      type: 'issue.commented',
      topic: 'issue:aa11',
      payload: { issueId: 'i1' },
      actorId: bob,
    })

    const inbox = await listNotifications(db, alice)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      type: 'issue.commented',
      topic: 'issue:aa11',
      actorId: bob,
      readAt: null,
    })

    const announced = await listEventsSince(db, {
      topicPatterns: [notifyTopic(alice)],
      audience: 'members',
    })
    expect(announced.some((e) => e.type === NOTIFICATION_CREATED)).toBe(true)
  })

  it('unread tracking: listUnread oldest-first, markAllRead clears', async () => {
    for (const n of ['one', 'two']) {
      await addNotification(db, {
        userId: alice,
        type: 'issue.commented',
        topic: 'issue:aa11',
        payload: { n },
        actorId: null,
      })
    }
    expect(await unreadCount(db, alice)).toBe(2)
    const unread = await listUnread(db, alice)
    expect((unread[0].payload as { n: string }).n).toBe('one')

    await markAllRead(db, alice)
    expect(await unreadCount(db, alice)).toBe(0)
    // Still in the inbox — read, not gone.
    expect(await listNotifications(db, alice)).toHaveLength(2)
  })

  /** Feed every durable event since `sinceId` through the reactor, in order. */
  async function reactToLog(
    reactor: ReturnType<typeof createNotificationsReactor>,
  ) {
    const events = await listEventsSince(db, {
      topicPatterns: ['*'],
      audience: 'public',
    })
    for (const e of events) {
      await reactor.handleBusNote({ id: e.id, type: e.type })
    }
  }

  it('the full loop: acting auto-watches, watchers (minus the actor) are notified', async () => {
    const reactor = createNotificationsReactor({ db })

    // Bob (an agent) files an issue → the opened event auto-watches Bob.
    const issue = await createIssue(db, {
      title: 'Fix the mast',
      authorId: bob,
    })
    await reactToLog(reactor)
    expect(await isWatching(db, bob, issueTopic(issue.id))).toBe(true)
    // Nobody else watches yet, and your own action is not news to you.
    expect(await unreadCount(db, bob)).toBe(0)

    // Alice comments → she auto-watches; Bob (a watcher who didn't act) hears.
    await addComment(db, {
      issueId: issue.id,
      authorId: alice,
      body: 'On it.',
    })
    // A fresh reactor and replaying the WHOLE log must not double-deliver…
    // (handleBusNote is per-note; the loop below feeds each event once.)
    const before = await unreadCount(db, bob)
    const commented = await listEventsSince(db, {
      topicPatterns: [issueTopic(issue.id)],
      audience: 'public',
    })
    const commentEvent = commented.find((e) => e.type === 'issue.commented')
    await reactor.handleBusNote({ id: defined(commentEvent).id, type: 'x' })
    expect(await isWatching(db, alice, issueTopic(issue.id))).toBe(true)
    expect(await unreadCount(db, bob)).toBe(before + 1)
    // Alice acted — her own comment isn't in her inbox.
    expect(await unreadCount(db, alice)).toBe(0)

    // The builder moves status → both watchers hear (mover is a third party).
    const mover = uuidv7()
    await createUser(db, {
      id: mover,
      handle: 'builder',
      displayName: 'Builder',
      type: 'agent',
    })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: mover,
    })
    const moved = await listEventsSince(db, {
      topicPatterns: [issueTopic(issue.id)],
      audience: 'public',
    })
    const statusEvent = moved.find((e) => e.type === 'issue.status_changed')
    await reactor.handleBusNote({ id: defined(statusEvent).id, type: 'x' })
    expect(await unreadCount(db, bob)).toBe(before + 2)
    expect(await unreadCount(db, alice)).toBe(1)
  })

  it('skips ephemeral notes and its own notification.created announcements', async () => {
    const reactor = createNotificationsReactor({ db })
    await watchTopic(db, alice, 'issue:aa11')

    await reactor.handleBusNote({
      id: uuidv7(),
      type: 'chat.agent_progress',
      ephemeral: { source: 'chat', payload: {} },
    })
    expect(await unreadCount(db, alice)).toBe(0)

    // A notification.created event must never fan out again (loop guard):
    // deliver one real notification, then feed ITS announcement back through.
    await watchTopic(db, bob, notifyTopic(alice)) // even a hostile watch…
    await addNotification(db, {
      userId: alice,
      type: 'issue.commented',
      topic: 'issue:aa11',
      payload: {},
      actorId: null,
    })
    const events = await listEventsSince(db, {
      topicPatterns: [notifyTopic(alice)],
      audience: 'members',
    })
    const created = events.find((e) => e.type === NOTIFICATION_CREATED)
    await reactor.handleBusNote({
      id: defined(created).id,
      type: NOTIFICATION_CREATED,
    })
    expect(await unreadCount(db, bob)).toBe(0)
  })

  it('never fans out a members-scoped event, even to a planted watch', async () => {
    const reactor = createNotificationsReactor({ db })
    // Bob plants a watch on a chat topic he can't see; a members-audience
    // event on it must not become his notification.
    await watchTopic(db, bob, 'chat:private-1')
    const { emitEvent } = await import('@hull/events/bus')
    const event = await emitEvent(db, {
      type: 'chat.message_posted',
      source: 'chat',
      topic: 'chat:private-1',
      audience: 'members',
      actorId: alice,
      payload: {},
    })
    await reactor.handleBusNote({ id: event.id, type: event.type })
    expect(await unreadCount(db, bob)).toBe(0)
  })

  it('invokes the delivery hook per notification, and survives its failure', async () => {
    const delivered: string[] = []
    const reactor = createNotificationsReactor({
      db,
      onNotified: (n) => {
        delivered.push(n.userId)
        throw new Error('delivery exploded')
      },
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const issue = await createIssue(db, { title: 'x', authorId: bob })
      await watchTopic(db, alice, issueTopic(issue.id))
      await addComment(db, { issueId: issue.id, authorId: bob, body: 'hi' })
      const events = await listEventsSince(db, {
        topicPatterns: [issueTopic(issue.id)],
        audience: 'public',
      })
      const comment = events.find((e) => e.type === 'issue.commented')
      await reactor.handleBusNote({ id: defined(comment).id, type: 'x' })

      expect(delivered).toEqual([alice])
      // The hook threw, but the inbox row is durable regardless.
      expect(await unreadCount(db, alice)).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
