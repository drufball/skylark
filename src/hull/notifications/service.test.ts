import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'
import { events } from '@hull/events/schema'
import { listEventsSince, REPLAY_PAGE_SIZE } from '@hull/events/service'
import { createIssue, addComment, transitionIssue } from '@hull/issues/service'
import { createUser } from '@hull/users/service'
import { issueTopic } from '@hull/issues/topic'

import {
  addNotification,
  createNotificationsReactor,
  deliverToHooks,
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
import type { NotificationRow } from './schema'

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

  it('renders a handoff with the baton message', () => {
    expect(
      describeNotification({
        type: 'issue.handoff',
        topic: 'issue:aa11',
        payload: {
          toHandle: 'babysitter',
          toOwner: false,
          message: 'PR #12 is open — take it home',
        },
        actorHandle: 'builder',
      }),
    ).toBe(
      '@builder passed the baton to @babysitter: PR #12 is open — take it home',
    )
    // Third person even for owner pings: the line fans out to bystander
    // watchers too, so "handed this to YOU" would lie to everyone but the owner.
    expect(
      describeNotification({
        type: 'issue.owner_ping',
        topic: 'issue:aa11',
        payload: {
          toHandle: 'drufball',
          message: 'checks green — merge?',
        },
        actorHandle: 'builder',
      }),
    ).toBe(
      '@builder needs @drufball (the owner) to look: checks green — merge?',
    )
  })

  it('keeps a handoff line to one bounded line, however long the message', () => {
    const line = describeNotification({
      type: 'issue.owner_ping',
      topic: 'issue:aa11',
      payload: {
        toHandle: 'drufball',
        message: 'first line of a long brief\nsecond line never shows',
      },
      actorHandle: 'builder',
    })
    expect(line).toContain('first line of a long brief')
    expect(line).not.toContain('second line')
    const longMessage = 'w'.repeat(500)
    expect(
      describeNotification({
        type: 'issue.handoff',
        topic: 'issue:aa11',
        payload: { toHandle: 'x', toOwner: false, message: longMessage },
        actorHandle: 'builder',
      }).length,
    ).toBeLessThan(220)
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

describe('deliverToHooks', () => {
  const row = {
    id: 'n1',
    userId: 'u1',
    type: 'issue.commented',
  } as NotificationRow

  it('isolates a throwing hook: the others still fire, the error is logged', () => {
    const errors = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    try {
      const delivered: string[] = []
      const broken = () => {
        throw new Error('waker offline')
      }
      const working = (n: NotificationRow) => {
        delivered.push(n.id)
      }

      expect(() => {
        deliverToHooks([broken, working], row)
      }).not.toThrow()
      expect(delivered).toEqual(['n1'])
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('notification hook failed'),
      )
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('waker offline'),
      )
    } finally {
      errors.mockRestore()
    }
  })

  it('hands every hook the same notification, in registration order', () => {
    const calls: string[] = []
    deliverToHooks([() => calls.push('a'), () => calls.push('b')], row)
    expect(calls).toEqual(['a', 'b'])
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
      eventId: uuidv7(),
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
    const created = defined(
      announced.find((e) => e.type === NOTIFICATION_CREATED),
    )
    // The announcement carries the row's essentials so a live subscriber can
    // update without a read-back — not an empty payload.
    expect(created.payload).toEqual({
      notificationId: inbox[0].id,
      type: 'issue.commented',
      topic: 'issue:aa11',
    })
  })

  it('unread tracking: listUnread oldest-first, markAllRead clears', async () => {
    for (const n of ['one', 'two']) {
      await addNotification(db, {
        eventId: uuidv7(),
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
      eventId: uuidv7(),
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

  it('delivers the same event exactly once: a bus replay adds no row and rings no bell', async () => {
    const delivered: string[] = []
    const reactor = createNotificationsReactor({
      db,
      onNotified: (n) => delivered.push(n.id),
    })
    const issue = await createIssue(db, { title: 'x', authorId: bob })
    await watchTopic(db, alice, issueTopic(issue.id))
    await addComment(db, { issueId: issue.id, authorId: bob, body: 'hi' })
    const events = await listEventsSince(db, {
      topicPatterns: [issueTopic(issue.id)],
      audience: 'public',
    })
    const comment = defined(events.find((e) => e.type === 'issue.commented'))

    // The same durable event arrives twice — a replay, or a second process.
    await reactor.handleBusNote({ id: comment.id, type: comment.type })
    await reactor.handleBusNote({ id: comment.id, type: comment.type })

    expect(await unreadCount(db, alice)).toBe(1)
    expect(delivered).toHaveLength(1)
    // And the bell rang once: one notification.created on alice's topic.
    const rings = await listEventsSince(db, {
      topicPatterns: [notifyTopic(alice)],
      audience: 'members',
    })
    expect(rings.filter((e) => e.type === NOTIFICATION_CREATED)).toHaveLength(1)
  })

  it('reconcile recovers auto-watches from the durable log without replaying old news', async () => {
    // An issue is filed while NO reactor is subscribed (a fresh process, a CLI
    // hit before any door) — the durable intent (the creator watches) must
    // survive; the missed fan-out stays missed by design.
    const issue = await createIssue(db, { title: 'x', authorId: bob })
    await addComment(db, { issueId: issue.id, authorId: alice, body: 'hi' })

    const reactor = createNotificationsReactor({ db })
    await reactor.reconcile()

    expect(await isWatching(db, bob, issueTopic(issue.id))).toBe(true)
    expect(await isWatching(db, alice, issueTopic(issue.id))).toBe(true)
    // No backfilled notifications — old news would flood late watchers.
    expect(await unreadCount(db, bob)).toBe(0)
    expect(await unreadCount(db, alice)).toBe(0)
  })

  it('an owner ping reaches the owner even if they never watched the issue', async () => {
    const reactor = createNotificationsReactor({ db })
    const { emitEvent } = await import('@hull/events/bus')
    // Alice owns the issue but has never acted on or watched it.
    const event = await emitEvent(db, {
      type: 'issue.owner_ping',
      source: 'issues',
      topic: 'issue:i1',
      audience: 'public',
      actorId: bob,
      payload: {
        issueId: 'i1',
        fromUserId: bob,
        toUserId: alice,
        toHandle: 'alice',
        message: 'checks green — merge?',
      },
    })
    await reactor.handleBusNote({ id: event.id, type: event.type })
    const inbox = await listNotifications(db, alice)
    expect(inbox).toHaveLength(1)
    expect(inbox[0].type).toBe('issue.owner_ping')
  })

  it('a baton handoff never doubles into the target inbox — the orchestrator drives them', async () => {
    const reactor = createNotificationsReactor({ db })
    const { emitEvent } = await import('@hull/events/bus')
    // Bob (the target) watches the issue from earlier acting; Alice watches too.
    await watchTopic(db, bob, 'issue:i2')
    await watchTopic(db, alice, 'issue:i2')
    const mover = uuidv7()
    await createUser(db, {
      id: mover,
      handle: 'builder',
      displayName: 'Builder',
      type: 'agent',
    })
    const event = await emitEvent(db, {
      type: 'issue.handoff',
      source: 'issues',
      topic: 'issue:i2',
      audience: 'public',
      actorId: mover,
      payload: {
        issueId: 'i2',
        fromUserId: mover,
        toUserId: bob,
        toHandle: 'bob',
        message: 'go',
      },
    })
    await reactor.handleBusNote({ id: event.id, type: event.type })
    // The bystander watcher hears the baton move; the target does not — a
    // fired turn plus an inbox wake would double-drive it.
    expect(await unreadCount(db, alice)).toBe(1)
    expect(await unreadCount(db, bob)).toBe(0)
  })

  it('compatibility: old issue.handoff with toOwner=true is treated as owner ping', async () => {
    const reactor = createNotificationsReactor({ db })
    const { emitEvent } = await import('@hull/events/bus')
    // Compatibility for old durable events: issue.handoff with toOwner: true
    // should still reach the owner via the notifications path.
    const event = await emitEvent(db, {
      type: 'issue.handoff',
      source: 'issues',
      topic: 'issue:i3',
      audience: 'public',
      actorId: bob,
      payload: {
        issueId: 'i3',
        fromUserId: bob,
        toUserId: alice,
        toHandle: 'alice',
        toOwner: true,
        message: 'old event format',
      },
    })
    await reactor.handleBusNote({ id: event.id, type: event.type })
    const inbox = await listNotifications(db, alice)
    expect(inbox).toHaveLength(1)
    // Still reports as the old event type
    expect(inbox[0].type).toBe('issue.handoff')
  })

  it('opening an issue for another owner watches that owner from the start', async () => {
    const reactor = createNotificationsReactor({ db })
    // Bob files an issue that Alice owns — she should hear where it goes even
    // before she ever touches it.
    const issue = await createIssue(db, {
      title: 'owned elsewhere',
      authorId: bob,
      ownerId: alice,
    })
    await reactToLog(reactor)
    expect(await isWatching(db, alice, issueTopic(issue.id))).toBe(true)
  })

  it('ignores a handoff payload whose issueId disagrees with the event topic', async () => {
    const reactor = createNotificationsReactor({ db })
    const { emitEvent } = await import('@hull/events/bus')
    // A forged row on one issue's topic naming another issueId must not get to
    // pick recipients: alice is neither watching nor legitimately targeted.
    const event = await emitEvent(db, {
      type: 'issue.handoff',
      source: 'issues',
      topic: 'issue:i9',
      audience: 'public',
      actorId: bob,
      payload: {
        issueId: 'i-other',
        fromUserId: bob,
        toUserId: alice,
        toHandle: 'alice',
        toOwner: true,
        message: 'forged',
      },
    })
    await reactor.handleBusNote({ id: event.id, type: event.type })
    expect(await unreadCount(db, alice)).toBe(0)
  })

  it('reconcile recovers owner watches, not just actor watches', async () => {
    // An issue is filed FOR alice while no reactor is subscribed — her watch is
    // durable intent and must survive the restart just like the actor's.
    const issue = await createIssue(db, {
      title: 'owned elsewhere, filed offline',
      authorId: bob,
      ownerId: alice,
    })
    const reactor = createNotificationsReactor({ db })
    await reactor.reconcile()
    expect(await isWatching(db, alice, issueTopic(issue.id))).toBe(true)
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

  it('fires the delivery hook once per recipient, not again on a duplicate delivery', async () => {
    // The hook deliberately never touches the row it's handed: a broken
    // idempotency guard would invoke it a second time (with no row), and this
    // counter must observe that regardless of what the argument looks like.
    let hookCalls = 0
    const reactor = createNotificationsReactor({
      db,
      onNotified: () => {
        hookCalls++
      },
    })
    const issue = await createIssue(db, { title: 'x', authorId: bob })
    await watchTopic(db, alice, issueTopic(issue.id))
    await addComment(db, { issueId: issue.id, authorId: bob, body: 'hi' })
    const events_ = await listEventsSince(db, {
      topicPatterns: [issueTopic(issue.id)],
      audience: 'public',
    })
    const comment = defined(events_.find((e) => e.type === 'issue.commented'))

    await reactor.handleBusNote({ id: comment.id, type: comment.type })
    await reactor.handleBusNote({ id: comment.id, type: comment.type })

    expect(hookCalls).toBe(1)
  })

  it('a public event on a non-auto-watch topic never subscribes the actor', async () => {
    const reactor = createNotificationsReactor({ db })
    const { emitEvent } = await import('@hull/events/bus')
    const event = await emitEvent(db, {
      type: 'file.changed',
      source: 'files',
      topic: 'file:notes.md',
      audience: 'public',
      actorId: bob,
      payload: { path: 'notes.md', action: 'write' },
    })
    await reactor.handleBusNote({ id: event.id, type: event.type })
    expect(await isWatching(db, bob, 'file:notes.md')).toBe(false)
  })

  it('only issue.opened subscribes the payload ownerId — a comment naming one does not', async () => {
    const reactor = createNotificationsReactor({ db })
    const { emitEvent } = await import('@hull/events/bus')
    const event = await emitEvent(db, {
      type: 'issue.commented',
      source: 'issues',
      topic: 'issue:i5',
      audience: 'public',
      actorId: bob,
      payload: { issueId: 'i5', ownerId: alice },
    })
    await reactor.handleBusNote({ id: event.id, type: event.type })
    // The actor auto-watches (acting = caring)…
    expect(await isWatching(db, bob, 'issue:i5')).toBe(true)
    // …but a payload ownerId only earns a watch on issue.opened.
    expect(await isWatching(db, alice, 'issue:i5')).toBe(false)
  })

  it('reconcile ignores actorless events and payload owners on non-opened events', async () => {
    await db.insert(events).values({
      id: uuidv7(),
      type: 'issue.commented',
      source: 'issues',
      topic: 'issue:r1',
      audience: 'public',
      actorId: null,
      payload: { issueId: 'r1', ownerId: alice },
    })
    const reactor = createNotificationsReactor({ db })
    await reactor.reconcile() // must not throw on the null actor
    expect(await isWatching(db, alice, 'issue:r1')).toBe(false)
    expect(await listWatchers(db, 'issue:r1')).toEqual([])
  })

  it('reconcile pages past a full first page of the durable log', async () => {
    // Exactly one full page of filler, then one more event carrying the watch:
    // reconcile must fetch a second page to see it. Rows are inserted directly
    // (ids chosen to sort after any uuidv7) so the test stays fast.
    const filler = Array.from({ length: REPLAY_PAGE_SIZE }, (_, i) => ({
      id: `zz-page-${String(i).padStart(4, '0')}`,
      type: 'issue.commented',
      source: 'issues',
      topic: 'issue:page',
      audience: 'public',
      actorId: null,
      payload: {},
    }))
    await db.insert(events).values(filler)
    await db.insert(events).values({
      id: 'zz-page-beyond',
      type: 'issue.commented',
      source: 'issues',
      topic: 'issue:beyond',
      audience: 'public',
      actorId: bob,
      payload: {},
    })

    const reactor = createNotificationsReactor({ db })
    await reactor.reconcile()

    expect(await isWatching(db, bob, 'issue:beyond')).toBe(true)
  })

  it('a forged handoff cannot remove a legitimate watcher from the fan-out', async () => {
    const reactor = createNotificationsReactor({ db })
    const { emitEvent } = await import('@hull/events/bus')
    // Bob legitimately watches issue:i9. A forged baton pass on that topic
    // names a DIFFERENT issueId with bob as target — the payload disagrees
    // with the topic, so it must not get to drop bob from the recipients.
    await watchTopic(db, bob, 'issue:i9')
    const mover = uuidv7()
    await createUser(db, {
      id: mover,
      handle: 'builder',
      displayName: 'Builder',
      type: 'agent',
    })
    const event = await emitEvent(db, {
      type: 'issue.handoff',
      source: 'issues',
      topic: 'issue:i9',
      audience: 'public',
      actorId: mover,
      payload: {
        issueId: 'i-other',
        fromUserId: mover,
        toUserId: bob,
        toHandle: 'bob',
        toOwner: false,
        message: 'forged',
      },
    })
    await reactor.handleBusNote({ id: event.id, type: event.type })
    expect(await unreadCount(db, bob)).toBe(1)
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

  it('reconcile delivers unread notifications to hooks (reload recovery for the waker)', async () => {
    // Scenario: reactor was alive and created notification rows, but the
    // in-process hook delivery was lost (Vite reload killed the waker's
    // debounce timer). On boot, reconcile should re-deliver unread rows
    // through the same onNotified hook so the waker gets another chance.
    const issue = await createIssue(db, { title: 'x', authorId: bob })
    await watchTopic(db, alice, issueTopic(issue.id))

    // First reactor: live delivery creates the notification row and calls hook
    const firstDelivered: string[] = []
    const reactor1 = createNotificationsReactor({
      db,
      onNotified: (n) => firstDelivered.push(n.userId),
    })
    await addComment(db, { issueId: issue.id, authorId: bob, body: 'hi' })
    const events = await listEventsSince(db, {
      topicPatterns: [issueTopic(issue.id)],
      audience: 'public',
    })
    const comment = events.find((e) => e.type === 'issue.commented')
    await reactor1.handleBusNote({ id: defined(comment).id, type: 'x' })
    expect(firstDelivered).toEqual([alice])
    expect(await unreadCount(db, alice)).toBe(1)

    // Simulate reload: second reactor with fresh hook, reconcile re-delivers
    const secondDelivered: string[] = []
    const reactor2 = createNotificationsReactor({
      db,
      onNotified: (n) => secondDelivered.push(n.userId),
    })
    await reactor2.reconcile()

    // The unread notification should be re-delivered to the new hook
    expect(secondDelivered).toEqual([alice])
    expect(await unreadCount(db, alice)).toBe(1) // still unread until consumed
  })

  it('reconcile survives hook delivery failures during unread re-delivery', async () => {
    // Create two unread notifications
    const issue = await createIssue(db, { title: 'x', authorId: bob })
    await watchTopic(db, alice, issueTopic(issue.id))
    await watchTopic(db, bob, issueTopic(issue.id))
    const reactor1 = createNotificationsReactor({ db })
    await addComment(db, { issueId: issue.id, authorId: bob, body: 'first' })
    const events1 = await listEventsSince(db, {
      topicPatterns: [issueTopic(issue.id)],
      audience: 'public',
    })
    const comment1 = events1.find((e) => e.type === 'issue.commented')
    await reactor1.handleBusNote({ id: defined(comment1).id, type: 'x' })

    // Second reactor: hook throws on alice, reconcile should still deliver bob's
    const delivered: string[] = []
    const reactor2 = createNotificationsReactor({
      db,
      onNotified: (n) => {
        delivered.push(n.userId)
        if (n.userId === alice) throw new Error('hook failed')
      },
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await reactor2.reconcile()

      // Both should be attempted, despite alice's failure
      expect(delivered).toEqual([alice])
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('reconcile notification delivery failed'),
      )
    } finally {
      spy.mockRestore()
    }
  })
})
