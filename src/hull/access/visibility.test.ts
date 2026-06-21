import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { createChat } from '@hull/chat/service'
import { createUser } from '@hull/users/service'

import { canSeeTopic } from './visibility'

describe('canSeeTopic', () => {
  let db: Database
  let close: () => Promise<void>
  let alice: string
  let bob: string
  let chat: string

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    alice = uuidv7()
    bob = uuidv7()
    await createUser(db, {
      id: alice,
      handle: 'alice',
      displayName: 'A',
      type: 'human',
    })
    await createUser(db, {
      id: bob,
      handle: 'bob',
      displayName: 'B',
      type: 'human',
    })
    chat = uuidv7()
    await createChat(db, { id: chat, memberIds: [alice] }) // bob is NOT in it
  })
  afterEach(() => close())

  it('lets a chat member see the chat topic', async () => {
    expect(await canSeeTopic(db, alice, `chat:${chat}`)).toBe(true)
  })

  it('hides a chat topic from a non-member', async () => {
    expect(await canSeeTopic(db, bob, `chat:${chat}`)).toBe(false)
  })

  it('allows non-chat topics (issues public; sessions until scoped)', async () => {
    expect(await canSeeTopic(db, bob, 'issue:123')).toBe(true)
    expect(await canSeeTopic(db, bob, 'session:abc')).toBe(true)
  })
})
