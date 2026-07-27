import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { addWidget, createChat, removeMember } from '@hull/chat/service'
import type { Database } from '@hull/db/client'
import { asActor, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import {
  createHomePage,
  listHomePages,
  listHomeTiles,
  moveHomeTile,
  pinHomeTile,
  readHomeCanvas,
  removeHomePage,
  renameHomePage,
  unpinHomeTile,
} from './service'

// Proves migration 0036 actually holds the two lines home rests on.
//
// **Your home is yours.** `owner_id = the acting user`, with no membership
// wrapper and no join, on both tables and all four verbs. Fixtures are arranged
// as the PGlite superuser (RLS bypassed); every assertion goes through
// `asActor`, which drops to app_user and sets app.actor, so the policy bites.
//
// **A pointer is not a grant.** The tile row is yours either way; what it points
// AT is read through chat's policies, at read time, from your membership right
// now. Taking membership away has to stop the content dead — including on the
// live path, which is the side channel a resolved-once design would leave open.

describe('home canvas access (RLS)', () => {
  let db: Database
  let close: () => Promise<void>
  let alice: string
  let bob: string
  let tilde: string
  let shared: string // alice + bob + tilde
  let alicePage: string

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    alice = uuidv7()
    bob = uuidv7()
    tilde = uuidv7()
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
    await createUser(db, {
      id: tilde,
      handle: 'tilde',
      displayName: 'Tilde',
      type: 'agent',
    })
    shared = uuidv7()
    await createChat(db, {
      id: shared,
      title: 'Deploys',
      memberIds: [alice, bob, tilde],
    })
    alicePage = uuidv7()
    await createHomePage(db, {
      id: alicePage,
      ownerId: alice,
      title: 'Alice’s home',
    })
  })
  afterEach(() => close())

  /** A choice @tilde raised in the shared chat. */
  async function raise(question = 'Ship it?'): Promise<string> {
    const id = uuidv7()
    await addWidget(db, {
      id,
      chatId: shared,
      kind: 'choice',
      props: { question, options: ['Yes', 'No'] },
      createdById: tilde,
    })
    return id
  }

  it('keeps a home page invisible and untouchable to anyone else', async () => {
    expect(await asActor(db, bob, (tx) => listHomePages(tx, alice))).toEqual([])
    await expect(
      asActor(db, bob, (tx) =>
        renameHomePage(tx, { pageId: alicePage, title: 'mine now' }),
      ),
    ).rejects.toThrow(/no such home page/)
    await expect(
      asActor(db, bob, (tx) => removeHomePage(tx, { pageId: alicePage })),
    ).rejects.toThrow(/no such home page/)
    // Untouched: alice still has her page, still called what she called it.
    expect(await listHomePages(db, alice)).toMatchObject([
      { title: 'Alice’s home' },
    ])
  })

  it('refuses to make a page in somebody else’s name', async () => {
    // The WITH CHECK half. `ownerId` is never taken from a caller at the door,
    // but the policy is what makes that a fact rather than a habit.
    await expect(
      asActor(db, bob, (tx) =>
        createHomePage(tx, { id: uuidv7(), ownerId: alice, title: 'sneak' }),
      ),
    ).rejects.toThrow()
  })

  it('keeps one crew member’s tiles unreadable and unmovable by another', async () => {
    const tileId = uuidv7()
    await pinHomeTile(db, {
      id: tileId,
      ownerId: alice,
      pageId: alicePage,
      chatId: shared,
    })
    // Bob is in the SAME chat and still sees nothing of alice's arrangement.
    expect(await asActor(db, bob, (tx) => listHomeTiles(tx, alice))).toEqual([])
    await expect(
      asActor(db, bob, (tx) =>
        moveHomeTile(tx, { tileId, pageId: alicePage, gridX: 3 }),
      ),
    ).rejects.toThrow(/no such home tile/)
    await asActor(db, bob, (tx) => unpinHomeTile(tx, { tileId }))
    // The delete matched no rows under bob's policy — alice's tile survives.
    expect(await listHomeTiles(db, alice)).toHaveLength(1)
  })

  it('stops resolving a pinned widget the instant membership goes', async () => {
    // The load-bearing test of the slice. Bob pins while he's a member; the
    // pin is not what grants him anything, so removing him from the chat has to
    // stop the content at the READ, without touching the tile row.
    const bobPage = uuidv7()
    await createHomePage(db, { id: bobPage, ownerId: bob, title: 'Home' })
    const widgetId = await raise('Ship it?')
    await asActor(db, bob, (tx) =>
      pinHomeTile(tx, {
        id: uuidv7(),
        ownerId: bob,
        pageId: bobPage,
        widgetId,
      }),
    )
    const before = await asActor(db, bob, (tx) => readHomeCanvas(tx, bob))
    expect(before.tiles[0].target.mode).toBe('widget')

    await removeMember(db, shared, bob)

    const after = await asActor(db, bob, (tx) => readHomeCanvas(tx, bob))
    expect(after.tiles[0].target).toEqual({ mode: 'lost' })
    // Nothing of the conversation survives into the payload — not the question,
    // not the chat's name, not even its id.
    const wire = JSON.stringify(after)
    expect(wire).not.toContain('Ship it?')
    expect(wire).not.toContain('Deploys')
    expect(wire).not.toContain(shared)
    // …and the live path can't leak what the read just closed: no topic, so the
    // browser never subscribes to that chat again.
    expect(after.topics).toEqual([])
  })

  it('stops resolving a pinned CHAT the instant membership goes', async () => {
    const bobPage = uuidv7()
    await createHomePage(db, { id: bobPage, ownerId: bob, title: 'Home' })
    await raise('Ship it?')
    await asActor(db, bob, (tx) =>
      pinHomeTile(tx, {
        id: uuidv7(),
        ownerId: bob,
        pageId: bobPage,
        chatId: shared,
      }),
    )
    await removeMember(db, shared, bob)
    const after = await asActor(db, bob, (tx) => readHomeCanvas(tx, bob))
    expect(after.tiles[0].target).toEqual({ mode: 'lost' })
    expect(JSON.stringify(after)).not.toContain(shared)
    expect(after.topics).toEqual([])
  })

  it('keeps resolving for the members who are still in the chat', async () => {
    // The other half: losing bob must not blind alice.
    const widgetId = await raise('Ship it?')
    await asActor(db, alice, (tx) =>
      pinHomeTile(tx, {
        id: uuidv7(),
        ownerId: alice,
        pageId: alicePage,
        widgetId,
      }),
    )
    await removeMember(db, shared, bob)
    const after = await asActor(db, alice, (tx) => readHomeCanvas(tx, alice))
    expect(after.tiles[0].target.mode).toBe('widget')
    expect(after.topics).toHaveLength(1)
  })
})
