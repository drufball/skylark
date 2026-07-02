import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { asActor, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import { notifications, watches } from './schema'
import {
  addNotification,
  isWatching,
  listNotifications,
  markAllRead,
  unwatchTopic,
  watchTopic,
} from './service'

// Proves the migration 0010/0011 RLS policies scope both tables to their
// owner. Fixtures are arranged as the PGlite superuser (RLS bypassed, like the
// live reactor on systemDb); every assertion runs through `asActor`, which
// drops to app_user + sets app.actor, so the policies bite.

describe('notifications access (RLS)', () => {
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
      type: 'human',
    })
    // Arranged as the system (superuser), the way the live reactor writes.
    await addNotification(db, {
      userId: alice,
      eventId: uuidv7(),
      type: 'issue.commented',
      topic: 'issue:aa11',
      payload: {},
      actorId: bob,
    })
    await watchTopic(db, alice, 'issue:aa11')
  })
  afterEach(() => close())

  it('an inbox is readable and markable only by its owner', async () => {
    expect(
      await asActor(db, alice, (tx) => listNotifications(tx, alice)),
    ).toHaveLength(1)
    // Bob reading alice's inbox gets nothing — even asking FOR alice's rows.
    expect(
      await asActor(db, bob, (tx) => listNotifications(tx, alice)),
    ).toHaveLength(0)

    // Bob "marks alice's inbox read" — the policy makes it touch no rows.
    await asActor(db, bob, (tx) => markAllRead(tx, alice))
    const [still] = await asActor(db, alice, (tx) =>
      listNotifications(tx, alice),
    )
    expect(still.readAt).toBeNull()
  })

  it('app_user cannot insert inbox rows at all (only the system reactor writes)', async () => {
    await expect(
      asActor(db, alice, (tx) =>
        addNotification(tx, {
          userId: alice,
          eventId: uuidv7(),
          type: 'x',
          topic: 'issue:aa11',
          payload: {},
          actorId: null,
        }),
      ),
    ).rejects.toThrow()
  })

  it('app_user cannot delete inbox rows (no delete policy)', async () => {
    // Even the owner: the inbox is append-only from the app's side.
    await asActor(db, alice, (tx) => tx.delete(notifications))
    expect(
      await asActor(db, alice, (tx) => listNotifications(tx, alice)),
    ).toHaveLength(1)
  })

  it('watches are managed only as yourself', async () => {
    // Alice manages her own watch — fine.
    await asActor(db, alice, (tx) => unwatchTopic(tx, alice, 'issue:aa11'))
    expect(await isWatching(db, alice, 'issue:aa11')).toBe(false)
    await asActor(db, alice, (tx) => watchTopic(tx, alice, 'issue:aa11'))
    expect(await isWatching(db, alice, 'issue:aa11')).toBe(true)

    // Bob subscribing ALICE to something is refused by the insert policy…
    await expect(
      asActor(db, bob, (tx) => watchTopic(tx, alice, 'issue:zz99')),
    ).rejects.toThrow()
    // …and bob deleting alice's watch touches no rows.
    await asActor(db, bob, (tx) => unwatchTopic(tx, alice, 'issue:aa11'))
    expect(await isWatching(db, alice, 'issue:aa11')).toBe(true)
  })

  it('a watch list read as bob shows none of alice’s rows', async () => {
    const rows = await asActor(db, bob, (tx) => tx.select().from(watches))
    expect(rows).toHaveLength(0)
  })
})
