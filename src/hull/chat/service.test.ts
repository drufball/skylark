import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { listEventsSince } from '@hull/events/service'
import { defined, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'
import { createSession } from '@hull/agent/service'

import {
  addMember,
  addMessage,
  createChat,
  formatTranscript,
  getChat,
  listChatSummaries,
  listChatsForUser,
  listMembers,
  listMessages,
  messagesSinceAgent,
  parseMentions,
  removeMember,
  setMemberSession,
  setTitle,
  targetsForMessage,
  type MemberView,
} from './service'
import { chatTopic } from './topic'

/** Did `userId` end up a member of `chatId`? (membership state, via the roster). */
async function isMemberOf(
  db: Database,
  chatId: string,
  userId: string,
): Promise<boolean> {
  return (await listMembers(db, chatId)).some((m) => m.userId === userId)
}

describe('parseMentions', () => {
  it('extracts @handles, lowercased and deduped', () => {
    expect(parseMentions('hey @Tilde and @bix, also @tilde')).toEqual([
      'tilde',
      'bix',
    ])
    expect(parseMentions('no mentions here')).toEqual([])
  })
})

describe('targetsForMessage', () => {
  const human: MemberView = { userId: 'h', handle: 'dru', type: 'human' }
  const human2: MemberView = { userId: 'h2', handle: 'sam', type: 'human' }
  const tilde: MemberView = { userId: 'a', handle: 'tilde', type: 'agent' }
  const bix: MemberView = { userId: 'b', handle: 'bix', type: 'agent' }

  it('auto-responds in a 1:1 (one human + one agent)', () => {
    expect(
      targetsForMessage({ members: [human, tilde], authorId: 'h', body: 'hi' }),
    ).toEqual(['a'])
  })

  it('responds only to @mentioned agents in a group', () => {
    expect(
      targetsForMessage({
        members: [human, human2, tilde, bix],
        authorId: 'h',
        body: 'what do you think @bix?',
      }),
    ).toEqual(['b'])
  })

  it('does not respond to an agent-authored message (no loops)', () => {
    expect(
      targetsForMessage({
        members: [human, tilde],
        authorId: 'a',
        body: 'I think…',
      }),
    ).toEqual([])
  })

  it('returns nothing when a group message mentions no agent', () => {
    expect(
      targetsForMessage({
        members: [human, human2, tilde],
        authorId: 'h',
        body: 'just chatting',
      }),
    ).toEqual([])
  })
})

describe('formatTranscript', () => {
  it('renders messages as @handle: body lines', () => {
    expect(
      formatTranscript([
        { handle: 'dru', body: 'hello' },
        { handle: 'tilde', body: 'hi' },
      ]),
    ).toBe('@dru: hello\n@tilde: hi')
  })
})

describe('chat persistence', () => {
  let db: Database
  let close: () => Promise<void>
  let dru: string
  let tilde: string

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    dru = uuidv7()
    tilde = uuidv7()
    await createUser(db, {
      id: dru,
      handle: 'dru',
      displayName: 'Dru',
      type: 'human',
    })
    await createUser(db, {
      id: tilde,
      handle: 'tilde',
      displayName: 'Tilde',
      type: 'agent',
    })
  })
  afterEach(() => close())

  async function makeChat(title?: string): Promise<string> {
    const id = uuidv7()
    await createChat(db, { id, title, memberIds: [dru, tilde] })
    return id
  }

  it('creates a chat with members and lists it for each member', async () => {
    const id = await makeChat('design talk')
    const chat = defined(await getChat(db, id))
    expect(chat.title).toBe('design talk')

    const members = await listMembers(db, id)
    expect(members.map((m) => m.handle).sort()).toEqual(['dru', 'tilde'])
    expect(await isMemberOf(db, id, dru)).toBe(true)

    const forDru = await listChatsForUser(db, dru)
    expect(forDru.map((c) => c.id)).toContain(id)
  })

  it('appends a message, bumps recency, and emits a chat-scoped event', async () => {
    const id = await makeChat()
    await addMessage(db, {
      id: uuidv7(),
      chatId: id,
      authorId: dru,
      body: 'hello tilde',
    })

    const messages = await listMessages(db, id)
    expect(messages).toHaveLength(1)
    expect(messages[0].authorHandle).toBe('dru')

    const events = await listEventsSince(db, {
      topicPatterns: [chatTopic(id)],
      audience: 'members',
    })
    expect(events.map((e) => e.type)).toContain('chat.message_posted')
    // Private: nothing leaks to the public audience.
    const pub = await listEventsSince(db, {
      topicPatterns: ['*'],
      audience: 'public',
    })
    expect(pub.filter((e) => e.topic === chatTopic(id))).toHaveLength(0)
  })

  it('orders the sidebar by most recent activity', async () => {
    const a = await makeChat('a')
    const b = await makeChat('b')
    await addMessage(db, { id: uuidv7(), chatId: a, authorId: dru, body: 'x' })
    const ordered = await listChatsForUser(db, dru)
    expect(ordered[0].id).toBe(a) // a just got a message → on top
    expect(ordered.map((c) => c.id)).toContain(b)
  })

  it('returns only unseen messages since the agent last spoke', async () => {
    const id = await makeChat()
    await addMessage(db, {
      id: uuidv7(),
      chatId: id,
      authorId: dru,
      body: 'one',
    })
    await addMessage(db, {
      id: uuidv7(),
      chatId: id,
      authorId: tilde,
      body: 'reply',
    })
    await addMessage(db, {
      id: uuidv7(),
      chatId: id,
      authorId: dru,
      body: 'two',
    })

    const unseen = await messagesSinceAgent(db, id, tilde)
    expect(unseen.map((m) => m.body)).toEqual(['two'])
  })

  it('returns the whole thread when the agent has not spoken yet', async () => {
    const id = await makeChat()
    await addMessage(db, {
      id: uuidv7(),
      chatId: id,
      authorId: dru,
      body: 'one',
    })
    const unseen = await messagesSinceAgent(db, id, tilde)
    expect(unseen.map((m) => m.body)).toEqual(['one'])
  })

  it('adds and removes members and retitles', async () => {
    const id = await makeChat('old')
    const sam = uuidv7()
    await createUser(db, {
      id: sam,
      handle: 'sam',
      displayName: 'Sam',
      type: 'human',
    })
    await addMember(db, id, sam)
    expect(await isMemberOf(db, id, sam)).toBe(true)
    await addMember(db, id, sam) // idempotent
    await removeMember(db, id, sam)
    expect(await isMemberOf(db, id, sam)).toBe(false)

    await setTitle(db, id, 'new')
    expect(defined(await getChat(db, id)).title).toBe('new')
  })

  it('summarizes the actor chats with member handles, newest first', async () => {
    const a = await makeChat('a')
    const b = await makeChat('b')
    await addMessage(db, { id: uuidv7(), chatId: b, authorId: dru, body: 'x' })

    const summaries = await listChatSummaries(db, dru)
    expect(summaries[0].id).toBe(b) // b just got a message
    const first = defined(summaries.find((s) => s.id === a))
    expect(first.memberHandles.sort()).toEqual(['dru', 'tilde'])
  })

  it('records an agent member backing session', async () => {
    const id = await makeChat()
    const sessionId = uuidv7()
    await createSession(db, { id: sessionId, model: 'm', agentUserId: tilde })
    await setMemberSession(db, id, tilde, sessionId)
    const members = await listMembers(db, id)
    expect(members.find((m) => m.userId === tilde)?.sessionId).toBe(sessionId)
  })
})
