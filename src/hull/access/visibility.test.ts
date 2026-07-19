import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { createChat, setMemberSession } from '@hull/chat/service'
import { createSession } from '@hull/agent/service'
import { createIssue, claimIssueSession } from '@hull/issues/service'
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

  it('allows issue topics (the board is public)', async () => {
    expect(await canSeeTopic(db, bob, 'issue:123')).toBe(true)
  })

  it('admits exactly the owner to a notification topic', async () => {
    expect(await canSeeTopic(db, alice, `notify:${alice}`)).toBe(true)
    expect(await canSeeTopic(db, bob, `notify:${alice}`)).toBe(false)
  })

  it('makes an issue-owned session public', async () => {
    const sid = uuidv7()
    await createSession(db, { id: sid, model: 'm' })
    const issue = await createIssue(db, { title: 'build it', authorId: alice })
    await claimIssueSession(db, {
      issueId: issue.id,
      agentUserId: alice,
      sessionId: sid,
    })

    // bob is in no chat, but an issue's agent sessions are public.
    expect(await canSeeTopic(db, bob, `session:${sid}`)).toBe(true)
  })

  it('scopes a chat-backing session to that chat’s members', async () => {
    const sid = uuidv7()
    await createSession(db, { id: sid, model: 'm' })
    // The session backs an agent member of `chat` (members: alice only).
    await setMemberSession(db, chat, alice, sid)

    expect(await canSeeTopic(db, alice, `session:${sid}`)).toBe(true)
    expect(await canSeeTopic(db, bob, `session:${sid}`)).toBe(false)
  })

  it('leaves a bare session (no issue, no chat) visible to the crew', async () => {
    const sid = uuidv7()
    await createSession(db, { id: sid, model: 'm' })
    expect(await canSeeTopic(db, bob, `session:${sid}`)).toBe(true)
  })

  it('denies a session that does not exist', async () => {
    // The probe reads the row; no row → not visible (so cancel/send on a bogus
    // id is refused rather than firing into the void).
    expect(await canSeeTopic(db, bob, `session:${uuidv7()}`)).toBe(false)
  })
})
