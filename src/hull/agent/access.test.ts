import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { asActor, freshDb } from '@hull/db/test-db'
import { createChat, setMemberSession } from '@hull/chat/service'
import { createIssue, setIssueSession } from '@hull/issues/service'
import { createUser } from '@hull/users/service'

import {
  appendMessage,
  createSession,
  getMessages,
  getSession,
  listSessions,
} from './service'

// Proves migration 0008: an agent session inherits visibility from its parent —
// an issue's builder session is public, a chat's backing session follows that
// chat's membership, a bare session is crew-visible — enforced by RLS reading
// the STRUCTURAL relationship (issues.session_id / chat_members.session_id), the
// same truth the app layer reads. Fixtures arranged as the PGlite superuser;
// assertions via asActor.

describe('agent session access (RLS)', () => {
  let db: Database
  let close: () => Promise<void>
  let alice: string
  let bob: string
  let chat: string
  let sBare: string
  let sIssue: string
  let sChat: string

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

    sBare = uuidv7()
    sIssue = uuidv7()
    sChat = uuidv7()
    await createSession(db, { id: sBare, model: 'm' }) // no parent → crew-visible

    // An issue's agent session → public (link it via issue_sessions).
    await createSession(db, { id: sIssue, model: 'm' })
    const issue = await createIssue(db, { title: 'build', authorId: alice })
    await setIssueSession(db, {
      issueId: issue.id,
      agentUserId: alice,
      sessionId: sIssue,
    })

    // A chat's backing session → members only (link via chat_members.session_id).
    await createSession(db, { id: sChat, model: 'm' })
    await setMemberSession(db, chat, alice, sChat)
    await appendMessage(db, {
      sessionId: sChat,
      role: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'secret' }],
      },
    })
  })
  afterEach(() => close())

  it('hides a chat-backing session from a non-member', async () => {
    expect(
      await asActor(db, bob, (tx) => getSession(tx, sChat)),
    ).toBeUndefined()
    expect(
      await asActor(db, alice, (tx) => getSession(tx, sChat)),
    ).toBeDefined()
  })

  it('shows issue and bare sessions to any crew member', async () => {
    expect(await asActor(db, bob, (tx) => getSession(tx, sIssue))).toBeDefined()
    expect(await asActor(db, bob, (tx) => getSession(tx, sBare))).toBeDefined()
  })

  it('lists only the sessions the actor may see', async () => {
    const bobSees = await asActor(db, bob, (tx) => listSessions(tx))
    const ids = bobSees.map((s) => s.id)
    expect(ids).toContain(sIssue)
    expect(ids).toContain(sBare)
    expect(ids).not.toContain(sChat) // the private chat's backing session
  })

  it('hides a chat-backing session’s transcript from a non-member', async () => {
    expect(await asActor(db, bob, (tx) => getMessages(tx, sChat))).toEqual([])
    expect(
      (await asActor(db, alice, (tx) => getMessages(tx, sChat))).length,
    ).toBe(1)
  })
})
