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
  advanceNextFire,
  canAuthorSchedule,
  createChat,
  createSchedule,
  deleteSchedule,
  fireDueSchedules,
  formatTranscript,
  getChat,
  getSchedule,
  isScheduleDue,
  listChatSummaries,
  listChatsForUser,
  listDueSchedules,
  listMembers,
  listMessages,
  listSchedules,
  messagesSinceAgent,
  MIN_INTERVAL_MINUTES,
  parseMentions,
  removeMember,
  scheduleTiming,
  setMemberProgress,
  setMemberSession,
  setScheduleEnabled,
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

  it('persists an agent member progress line, defaulting to null', async () => {
    const id = await makeChat()
    const before = await listMembers(db, id)
    expect(before.find((m) => m.userId === tilde)?.progressLine).toBeNull()

    await setMemberProgress(db, id, tilde, 'using bash…')
    const after = await listMembers(db, id)
    expect(after.find((m) => m.userId === tilde)?.progressLine).toBe(
      'using bash…',
    )
  })

  it('clears a member progress line by setting it to null', async () => {
    const id = await makeChat()
    await setMemberProgress(db, id, tilde, 'thinking…')
    await setMemberProgress(db, id, tilde, null)
    const members = await listMembers(db, id)
    expect(members.find((m) => m.userId === tilde)?.progressLine).toBeNull()
  })
})

describe('canAuthorSchedule', () => {
  const members = [
    { userId: 'me', type: 'human' as const },
    { userId: 'other', type: 'human' as const },
    { userId: 'agent', type: 'agent' as const },
  ]

  it('lets you author as yourself', () => {
    expect(canAuthorSchedule({ actorId: 'me', authorId: 'me', members })).toBe(
      true,
    )
  })

  it('lets you author as an agent member of the chat', () => {
    expect(
      canAuthorSchedule({ actorId: 'me', authorId: 'agent', members }),
    ).toBe(true)
  })

  it('refuses to author as another human — never words in their mouth', () => {
    expect(
      canAuthorSchedule({ actorId: 'me', authorId: 'other', members }),
    ).toBe(false)
  })

  it('refuses to author as an agent that is not a member', () => {
    expect(
      canAuthorSchedule({ actorId: 'me', authorId: 'stranger', members }),
    ).toBe(false)
  })
})

describe('scheduleTiming', () => {
  const now = new Date('2026-07-18T12:00:00.000Z')

  it('keeps a one-shot fire time as-is, no recurrence', () => {
    const at = new Date('2026-07-19T09:00:00.000Z')
    expect(scheduleTiming({ now, fireAt: at })).toEqual({
      fireAt: at,
      intervalMinutes: null,
      nextFireAt: null,
    })
  })

  it('sets the first recurring fire one interval out', () => {
    expect(scheduleTiming({ now, intervalMinutes: 30 })).toEqual({
      fireAt: null,
      intervalMinutes: 30,
      nextFireAt: new Date('2026-07-18T12:30:00.000Z'),
    })
  })

  it('rejects giving both a fire time and an interval', () => {
    expect(() =>
      scheduleTiming({ now, fireAt: now, intervalMinutes: 30 }),
    ).toThrow(/exactly one/)
  })

  it('rejects giving neither', () => {
    expect(() => scheduleTiming({ now })).toThrow(/exactly one/)
  })

  it('enforces the interval floor', () => {
    expect(() =>
      scheduleTiming({ now, intervalMinutes: MIN_INTERVAL_MINUTES - 1 }),
    ).toThrow(/at least/)
    // The floor itself is allowed.
    expect(
      scheduleTiming({ now, intervalMinutes: MIN_INTERVAL_MINUTES })
        .intervalMinutes,
    ).toBe(MIN_INTERVAL_MINUTES)
  })

  it('rejects a fractional interval', () => {
    expect(() => scheduleTiming({ now, intervalMinutes: 5.5 })).toThrow(
      /whole number/,
    )
  })
})

describe('isScheduleDue', () => {
  const now = new Date('2026-07-18T12:00:00.000Z')
  const past = new Date('2026-07-18T11:00:00.000Z')
  const future = new Date('2026-07-18T13:00:00.000Z')

  it('is due when a one-shot fireAt has passed', () => {
    expect(
      isScheduleDue({ enabled: true, fireAt: past, nextFireAt: null }, now),
    ).toBe(true)
  })

  it('is not due when the fire time is still ahead', () => {
    expect(
      isScheduleDue({ enabled: true, fireAt: future, nextFireAt: null }, now),
    ).toBe(false)
  })

  it('is due on a recurring nextFireAt in the past', () => {
    expect(
      isScheduleDue({ enabled: true, fireAt: null, nextFireAt: past }, now),
    ).toBe(true)
  })

  it('is never due when disabled', () => {
    expect(
      isScheduleDue({ enabled: false, fireAt: past, nextFireAt: null }, now),
    ).toBe(false)
  })
})

describe('advanceNextFire', () => {
  const interval = 30

  it('advances one interval when fired right on time', () => {
    const at = new Date('2026-07-18T12:00:00.000Z')
    expect(advanceNextFire(at, interval, at)).toEqual(
      new Date('2026-07-18T12:30:00.000Z'),
    )
  })

  it('skips missed slots after a long gap — one future slot, no backfill', () => {
    const at = new Date('2026-07-18T12:00:00.000Z')
    // Fired ~3.5 intervals late (reboot): next slot is the 4th, in the future.
    const now = new Date('2026-07-18T13:45:00.000Z')
    expect(advanceNextFire(at, interval, now)).toEqual(
      new Date('2026-07-18T14:00:00.000Z'),
    )
  })
})

describe('schedule persistence + firing', () => {
  let db: Database
  let close: () => Promise<void>
  let dru: string
  let tilde: string
  let chatId: string

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
    chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
  })
  afterEach(() => close())

  async function makeOneShot(fireAt: Date, authorId = dru): Promise<string> {
    const id = uuidv7()
    await createSchedule(db, {
      id,
      chatId,
      authorId,
      body: 'standup',
      createdById: dru,
      fireAt,
      intervalMinutes: null,
      nextFireAt: null,
    })
    return id
  }

  async function makeRecurring(
    nextFireAt: Date,
    intervalMinutes = 30,
  ): Promise<string> {
    const id = uuidv7()
    await createSchedule(db, {
      id,
      chatId,
      authorId: dru,
      body: 'tick',
      createdById: dru,
      fireAt: null,
      intervalMinutes,
      nextFireAt,
    })
    return id
  }

  it('lists a chat’s schedules with the author handle', async () => {
    await makeOneShot(new Date('2026-07-18T13:00:00.000Z'))
    const rows = await listSchedules(db, chatId)
    expect(rows).toHaveLength(1)
    expect(rows[0].authorHandle).toBe('dru')
    expect(rows[0].enabled).toBe(true)
  })

  it('fires a due one-shot once, posts as its author, and disables it', async () => {
    await makeOneShot(new Date('2026-07-18T11:00:00.000Z'))
    const now = new Date('2026-07-18T12:00:00.000Z')

    expect(await fireDueSchedules(db, now)).toBe(1)
    const messages = await listMessages(db, chatId)
    expect(messages.map((m) => m.body)).toEqual(['standup'])
    expect(messages[0].authorHandle).toBe('dru')

    // Consumed: a second sweep fires nothing.
    expect(await fireDueSchedules(db, now)).toBe(0)
    const [row] = await listSchedules(db, chatId)
    expect(row.enabled).toBe(false)
  })

  it('does not fire a schedule whose time is still ahead', async () => {
    await makeOneShot(new Date('2026-07-18T13:00:00.000Z'))
    expect(
      await fireDueSchedules(db, new Date('2026-07-18T12:00:00.000Z')),
    ).toBe(0)
    expect(await listMessages(db, chatId)).toEqual([])
  })

  it('never fires a disabled schedule', async () => {
    const id = await makeOneShot(new Date('2026-07-18T11:00:00.000Z'))
    await setScheduleEnabled(db, id, false)
    expect(
      await fireDueSchedules(db, new Date('2026-07-18T12:00:00.000Z')),
    ).toBe(0)
  })

  it('fires a recurring schedule and advances nextFireAt', async () => {
    const id = await makeRecurring(new Date('2026-07-18T12:00:00.000Z'), 30)
    expect(
      await fireDueSchedules(db, new Date('2026-07-18T12:00:00.000Z')),
    ).toBe(1)
    const row = await getSchedule(db, id)
    expect(row?.enabled).toBe(true)
    expect(row?.nextFireAt).toEqual(new Date('2026-07-18T12:30:00.000Z'))
  })

  it('does not refire a recurring row in the same window (advance is atomic)', async () => {
    await makeRecurring(new Date('2026-07-18T12:00:00.000Z'), 30)
    const now = new Date('2026-07-18T12:00:00.000Z')
    expect(await fireDueSchedules(db, now)).toBe(1)
    // nextFireAt advanced to 12:30 in the same commit → a re-sweep fires nothing.
    expect(await fireDueSchedules(db, now)).toBe(0)
    expect(await listMessages(db, chatId)).toHaveLength(1)
  })

  it('fires each of several due schedules in one sweep', async () => {
    await makeOneShot(new Date('2026-07-18T11:00:00.000Z'))
    await makeRecurring(new Date('2026-07-18T11:30:00.000Z'), 30)
    expect(
      await fireDueSchedules(db, new Date('2026-07-18T12:00:00.000Z')),
    ).toBe(2)
    expect(await listMessages(db, chatId)).toHaveLength(2)
  })

  it('fires a long-overdue recurring row ONCE and skips the missed slots', async () => {
    // nextFireAt is ~3.5 intervals in the past (a reboot after downtime).
    await makeRecurring(new Date('2026-07-18T12:00:00.000Z'), 30)
    const now = new Date('2026-07-18T13:45:00.000Z')

    expect(await fireDueSchedules(db, now)).toBe(1)
    expect(await listMessages(db, chatId)).toHaveLength(1) // NOT 3 backfilled
    const [row] = await listSchedules(db, chatId)
    expect(row.nextFireAt).toEqual(new Date('2026-07-18T14:00:00.000Z'))
  })

  it('lists only enabled, due rows across the sweep', async () => {
    await makeOneShot(new Date('2026-07-18T11:00:00.000Z')) // due
    await makeOneShot(new Date('2026-07-18T13:00:00.000Z')) // future
    const due = await listDueSchedules(db, new Date('2026-07-18T12:00:00.000Z'))
    expect(due).toHaveLength(1)
  })

  it('deletes a schedule', async () => {
    const id = await makeOneShot(new Date('2026-07-18T13:00:00.000Z'))
    await deleteSchedule(db, id)
    expect(await getSchedule(db, id)).toBeUndefined()
    expect(await listSchedules(db, chatId)).toEqual([])
  })
})
