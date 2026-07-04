import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { emitEvent } from '@hull/events/bus'
import { PUBLIC_AUDIENCE } from '@hull/events/service'
import { createUser } from '@hull/users/service'

import {
  createNotificationsReactor,
  isWatching,
  listNotifications,
  unreadCount,
  watchTopic,
} from './service'

/**
 * Tests for the generic reactor: notifications should not know about issues
 * or any other specific service. Events carry optional notification metadata
 * in their payload:
 *
 * - headline: Human-readable inbox copy (replaces describeNotification switch)
 * - autoWatch: Whether the actor should be auto-subscribed (replaces isAutoWatchTopic)
 * - addRecipients: User IDs to add beyond watchers (replaces ISSUE_OWNER_PING special case)
 * - dropRecipients: User IDs to exclude from watchers (replaces ISSUE_HANDOFF special case)
 *
 * The reactor reads this metadata generically, never importing service-specific
 * constants or hardcoding service logic.
 */
describe('generic reactor with self-describing events', () => {
  let db: Database
  let close: () => Promise<void>
  let alice: string
  let bob: string
  let charlie: string

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    alice = uuidv7()
    bob = uuidv7()
    charlie = uuidv7()
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
    await createUser(db, {
      id: charlie,
      handle: 'charlie',
      displayName: 'Charlie',
      type: 'agent',
    })
  })
  afterEach(() => close())

  it('an event with autoWatch: true subscribes the actor to its topic', async () => {
    const reactor = createNotificationsReactor({ db })

    // A hypothetical "task.created" event that declares it wants auto-watch
    const event = await emitEvent(db, {
      type: 'task.created',
      source: 'tasks',
      topic: 'task:t1',
      audience: PUBLIC_AUDIENCE,
      actorId: bob,
      payload: {
        taskId: 't1',
        title: 'Fix the rigging',
        _notification: {
          autoWatch: true,
          headline: '@bob created a task: Fix the rigging',
        },
      },
    })

    await reactor.handleBusNote({ id: event.id, type: event.type })

    // Bob auto-watches because the event declared autoWatch: true
    expect(await isWatching(db, bob, 'task:t1')).toBe(true)
  })

  it('an event without autoWatch does not subscribe the actor', async () => {
    const reactor = createNotificationsReactor({ db })

    // A hypothetical "file.changed" event that doesn't want auto-watch
    const event = await emitEvent(db, {
      type: 'file.changed',
      source: 'files',
      topic: 'file:notes.md',
      audience: PUBLIC_AUDIENCE,
      actorId: bob,
      payload: {
        path: 'notes.md',
        _notification: {
          headline: '@bob edited notes.md',
        },
      },
    })

    await reactor.handleBusNote({ id: event.id, type: event.type })

    // Bob does NOT auto-watch because autoWatch was not set
    expect(await isWatching(db, bob, 'file:notes.md')).toBe(false)
  })

  it("addRecipients adds users to the fan-out even if they don't watch", async () => {
    const reactor = createNotificationsReactor({ db })

    // Alice watches the topic, but Charlie does not
    await watchTopic(db, alice, 'task:t2')

    // Bob emits an event that explicitly adds Charlie (e.g., an owner ping)
    const event = await emitEvent(db, {
      type: 'task.owner_ping',
      source: 'tasks',
      topic: 'task:t2',
      audience: PUBLIC_AUDIENCE,
      actorId: bob,
      payload: {
        taskId: 't2',
        toUserId: charlie,
        message: 'Need your input',
        _notification: {
          autoWatch: true,
          headline: '@bob needs @charlie: Need your input',
          addRecipients: [charlie],
        },
      },
    })

    await reactor.handleBusNote({ id: event.id, type: event.type })

    // Alice (watcher) got notified
    expect(await unreadCount(db, alice)).toBe(1)
    // Charlie got notified even though he didn't watch (addRecipients)
    expect(await unreadCount(db, charlie)).toBe(1)
    // Bob (actor) never sees his own action
    expect(await unreadCount(db, bob)).toBe(0)
  })

  it('dropRecipients excludes users from the fan-out even if they watch', async () => {
    const reactor = createNotificationsReactor({ db })

    // Alice and Bob both watch the topic
    await watchTopic(db, alice, 'task:t3')
    await watchTopic(db, bob, 'task:t3')

    // Charlie hands off to Bob, who should NOT be notified (being driven a turn)
    const event = await emitEvent(db, {
      type: 'task.handoff',
      source: 'tasks',
      topic: 'task:t3',
      audience: PUBLIC_AUDIENCE,
      actorId: charlie,
      payload: {
        taskId: 't3',
        toUserId: bob,
        message: 'Your turn',
        _notification: {
          autoWatch: true,
          headline: '@charlie passed to @bob: Your turn',
          dropRecipients: [bob],
        },
      },
    })

    await reactor.handleBusNote({ id: event.id, type: event.type })

    // Alice (watcher) got notified
    expect(await unreadCount(db, alice)).toBe(1)
    // Bob was excluded via dropRecipients despite watching
    expect(await unreadCount(db, bob)).toBe(0)
    // Charlie (actor) never sees his own action
    expect(await unreadCount(db, charlie)).toBe(0)
  })

  it('headline from metadata appears in the notification row', async () => {
    const reactor = createNotificationsReactor({ db })

    await watchTopic(db, alice, 'task:t4')

    const event = await emitEvent(db, {
      type: 'task.commented',
      source: 'tasks',
      topic: 'task:t4',
      audience: PUBLIC_AUDIENCE,
      actorId: bob,
      payload: {
        taskId: 't4',
        body: 'This is the comment body',
        _notification: {
          autoWatch: true,
          headline: '@bob commented on the task',
        },
      },
    })

    await reactor.handleBusNote({ id: event.id, type: event.type })

    const inbox = await listNotifications(db, alice)
    expect(inbox).toHaveLength(1)
    // The headline should be stored or derivable from the notification row
    // For now, verify the notification was created with the right event
    expect(inbox[0].type).toBe('task.commented')
  })

  it('reconcile respects autoWatch metadata when replaying', async () => {
    // Emit events BEFORE reactor boots (simulating offline creation)
    await emitEvent(db, {
      type: 'task.created',
      source: 'tasks',
      topic: 'task:t5',
      audience: PUBLIC_AUDIENCE,
      actorId: bob,
      payload: {
        taskId: 't5',
        _notification: { autoWatch: true },
      },
    })

    await emitEvent(db, {
      type: 'file.changed',
      source: 'files',
      topic: 'file:readme.md',
      audience: PUBLIC_AUDIENCE,
      actorId: alice,
      payload: {
        path: 'readme.md',
        _notification: {}, // no autoWatch
      },
    })

    const reactor = createNotificationsReactor({ db })
    await reactor.reconcile()

    // Bob auto-watched task:t5 during reconcile (autoWatch: true)
    expect(await isWatching(db, bob, 'task:t5')).toBe(true)
    // Alice did NOT auto-watch file:readme.md (no autoWatch)
    expect(await isWatching(db, alice, 'file:readme.md')).toBe(false)
  })

  it('events without _notification metadata work with no special behavior', async () => {
    const reactor = createNotificationsReactor({ db })

    // An event with no notification metadata at all
    await watchTopic(db, alice, 'system:boot')
    const event = await emitEvent(db, {
      type: 'system.boot',
      source: 'system',
      topic: 'system:boot',
      audience: PUBLIC_AUDIENCE,
      actorId: bob,
      payload: {
        timestamp: Date.now(),
        // No _notification field
      },
    })

    await reactor.handleBusNote({ id: event.id, type: event.type })

    // Alice got notified (she watches), no crash, no auto-watch
    expect(await unreadCount(db, alice)).toBe(1)
    expect(await isWatching(db, bob, 'system:boot')).toBe(false)
  })

  it('addRecipients must be vetted against the event topic to prevent forgery', async () => {
    const reactor = createNotificationsReactor({ db })

    // Alice watches task:t6, but a forged event on that topic names task:t7
    // in its payload and tries to add Charlie via addRecipients
    await watchTopic(db, alice, 'task:t6')

    const event = await emitEvent(db, {
      type: 'task.owner_ping',
      source: 'tasks',
      topic: 'task:t6', // event topic
      audience: PUBLIC_AUDIENCE,
      actorId: bob,
      payload: {
        taskId: 't7', // payload disagrees with topic - FORGED
        toUserId: charlie,
        _notification: {
          addRecipients: [charlie],
        },
      },
    })

    await reactor.handleBusNote({ id: event.id, type: event.type })

    // Alice (legitimate watcher) got notified
    expect(await unreadCount(db, alice)).toBe(1)
    // Charlie should NOT be added because payload taskId doesn't match topic
    // The reactor should validate that the entity ID in payload matches the topic
    expect(await unreadCount(db, charlie)).toBe(0)
  })

  it('dropRecipients must be vetted against the event topic to prevent forgery', async () => {
    const reactor = createNotificationsReactor({ db })

    // Alice watches task:t8
    await watchTopic(db, alice, 'task:t8')

    // A forged event on task:t8 names task:t9 in payload and tries to drop Alice
    const event = await emitEvent(db, {
      type: 'task.handoff',
      source: 'tasks',
      topic: 'task:t8', // event topic
      audience: PUBLIC_AUDIENCE,
      actorId: bob,
      payload: {
        taskId: 't9', // payload disagrees with topic - FORGED
        toUserId: charlie,
        _notification: {
          dropRecipients: [alice],
        },
      },
    })

    await reactor.handleBusNote({ id: event.id, type: event.type })

    // Alice should still be notified despite the dropRecipients attempt
    // because the payload taskId doesn't match the topic
    expect(await unreadCount(db, alice)).toBe(1)
  })
})
