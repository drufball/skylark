import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { asActor, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import {
  addMessage,
  createChat,
  ensureChatVisible,
  getChat,
  listChatSummaries,
  listMembers,
  listMessages,
} from './service'

// Proves the migration 0007 RLS policies actually filter chat reads/writes by
// membership — the by-construction half of "membership is visibility". Fixtures
// are arranged as the PGlite superuser (RLS bypassed); every assertion runs
// through `asActor`, which drops to app_user + sets app.actor, so RLS bites.

describe('chat access (RLS)', () => {
  let db: Database
  let close: () => Promise<void>
  let alice: string
  let bob: string
  let c1: string // alice + bob
  let c2: string // bob only

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
    c1 = uuidv7()
    c2 = uuidv7()
    await createChat(db, { id: c1, memberIds: [alice, bob] })
    await createChat(db, { id: c2, memberIds: [bob] })
    await addMessage(db, {
      id: uuidv7(),
      chatId: c1,
      authorId: alice,
      body: 'in c1',
    })
    await addMessage(db, {
      id: uuidv7(),
      chatId: c2,
      authorId: bob,
      body: 'in c2',
    })
  })
  afterEach(() => close())

  it('a crew member can CREATE a chat they are in — under RLS, like the web door', async () => {
    // Regression: insert-with-RETURNING needs SELECT visibility, but the
    // membership rows that grant it land after the chat row. The door path
    // (withCurrentActor → createChat) must work as a plain crew member.
    const chatId = uuidv7()
    const created = await asActor(db, alice, (tx) =>
      createChat(tx, { id: chatId, memberIds: [alice, bob] }),
    )
    expect(created.id).toBe(chatId)
    // And the creator can immediately read it back.
    const seen = await asActor(db, alice, (tx) => getChat(tx, chatId))
    expect(seen?.id).toBe(chatId)
  })

  it('hides a non-member chat’s messages and reveals a member’s', async () => {
    const aliceSeesC2 = await asActor(db, alice, (tx) => listMessages(tx, c2))
    expect(aliceSeesC2).toEqual([]) // alice is not in c2

    const bobSeesC2 = await asActor(db, bob, (tx) => listMessages(tx, c2))
    expect(bobSeesC2.map((m) => m.body)).toEqual(['in c2'])

    const aliceSeesC1 = await asActor(db, alice, (tx) => listMessages(tx, c1))
    expect(aliceSeesC1.map((m) => m.body)).toEqual(['in c1'])
  })

  it('ensureChatVisible resolves for a member, refuses a non-member', async () => {
    // alice is in c1 but not c2.
    await expect(
      asActor(db, alice, (tx) => ensureChatVisible(tx, c1)),
    ).resolves.toBeUndefined()
    await expect(
      asActor(db, alice, (tx) => ensureChatVisible(tx, c2)),
    ).rejects.toThrow('not a member')
  })

  it('hides a non-member chat row entirely', async () => {
    expect(await asActor(db, alice, (tx) => getChat(tx, c2))).toBeUndefined()
    expect(await asActor(db, bob, (tx) => getChat(tx, c2))).toBeDefined()
  })

  it('shows the full roster of a chat you’re in (no RLS recursion)', async () => {
    const roster = await asActor(db, alice, (tx) => listMembers(tx, c1))
    expect(roster.map((m) => m.handle).sort()).toEqual(['alice', 'bob'])
  })

  it('lists only the chats the actor is a member of', async () => {
    const aliceChats = await asActor(db, alice, (tx) =>
      listChatSummaries(tx, alice),
    )
    expect(aliceChats.map((c) => c.id)).toEqual([c1])

    const bobChats = await asActor(db, bob, (tx) => listChatSummaries(tx, bob))
    expect(bobChats.map((c) => c.id).sort()).toEqual([c1, c2].sort())
  })

  it('lets a member post, and blocks a non-member from posting', async () => {
    await asActor(db, alice, (tx) =>
      addMessage(tx, { id: uuidv7(), chatId: c1, authorId: alice, body: 'ok' }),
    )
    const c1msgs = await asActor(db, alice, (tx) => listMessages(tx, c1))
    expect(c1msgs.map((m) => m.body)).toContain('ok')

    // alice is not in c2 → the WITH CHECK policy rejects the insert.
    await expect(
      asActor(db, alice, (tx) =>
        addMessage(tx, {
          id: uuidv7(),
          chatId: c2,
          authorId: alice,
          body: 'sneak',
        }),
      ),
    ).rejects.toThrow()
  })
})
