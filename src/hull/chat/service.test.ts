import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { listEventsSince } from '@hull/events/service'
import { defined, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'
import { createSession } from '@hull/agent/service'

import { eq } from 'drizzle-orm'

import {
  addMember,
  addMessage,
  addWidget,
  advanceNextFire,
  answerWidget,
  canAuthorSchedule,
  createChat,
  createSchedule,
  deleteSchedule,
  dismissWidget,
  findChatForSession,
  fireDueSchedules,
  formatTranscript,
  getChat,
  laterMessageId,
  getSchedule,
  getWidget,
  isScheduleDue,
  listChatSummaries,
  listChatsForUser,
  listDueSchedules,
  listMembers,
  listMessages,
  listOpenWidgets,
  listSchedules,
  listWidgets,
  messagesSinceAgent,
  MIN_INTERVAL_MINUTES,
  parseMentions,
  removeMember,
  scheduleTiming,
  setMemberProgress,
  setMemberSeen,
  setMemberSession,
  setScheduleEnabled,
  setTitle,
  reorderWidget,
  targetsForMessage,
  type MemberView,
} from './service'
import { chats } from './schema'
import { CHAT_WIDGET_CHANGED, chatTopic } from './topic'
import { answerMessageBody, STACK_PLACEMENT, type JsonValue } from './widgets'

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

describe('laterMessageId', () => {
  it('picks the later id, treating null as "nothing yet"', () => {
    // Message ids are UUIDv7, so lexicographic order IS chronological order.
    const early = '0190aaaa-0000-7000-8000-000000000000'
    const late = '0190bbbb-0000-7000-8000-000000000000'
    expect(laterMessageId(early, late)).toBe(late)
    expect(laterMessageId(late, early)).toBe(late)
    expect(laterMessageId(null, early)).toBe(early)
    expect(laterMessageId(early, null)).toBe(early)
    expect(laterMessageId(null, null)).toBeNull()
    expect(laterMessageId(early, early)).toBe(early)
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

  it('treats the seen watermark as read even when the agent said nothing', async () => {
    // The whole reason the column exists: an agent now speaks by calling
    // chat_post, so a turn can legitimately end with no message of its own. The
    // orchestrator marks what that turn READ, or these messages stay unseen
    // forever and get re-fed on every later reply.
    const id = await makeChat()
    const first = uuidv7()
    await addMessage(db, { id: first, chatId: id, authorId: dru, body: 'one' })
    await setMemberSeen(db, id, tilde, first)
    await addMessage(db, {
      id: uuidv7(),
      chatId: id,
      authorId: dru,
      body: 'two',
    })

    const unseen = await messagesSinceAgent(db, id, tilde)
    expect(unseen.map((m) => m.body)).toEqual(['two'])
  })

  it("falls back to the agent's own last post when the watermark write was lost", async () => {
    // The other crash ordering: the agent's chat_post committed but the
    // watermark write never landed. The post itself is the watermark, so the
    // messages it answered are not re-fed — no duplicate reply.
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
      body: 'spoke, then the ship died',
    })

    expect(await messagesSinceAgent(db, id, tilde)).toEqual([])
  })

  it('resolves the watermark as the LATER of the column and the last post', async () => {
    // Both halves are present and they disagree: whichever is later wins, in
    // both directions, so neither half can drag the watermark backwards.
    const id = await makeChat()
    const one = uuidv7()
    await addMessage(db, { id: one, chatId: id, authorId: dru, body: 'one' })
    const post = uuidv7()
    await addMessage(db, {
      id: post,
      chatId: id,
      authorId: tilde,
      body: 'said',
    })
    const three = uuidv7()
    await addMessage(db, {
      id: three,
      chatId: id,
      authorId: dru,
      body: 'three',
    })

    // Column behind the post → the post wins.
    await setMemberSeen(db, id, tilde, one)
    expect(
      (await messagesSinceAgent(db, id, tilde)).map((m) => m.body),
    ).toEqual(['three'])
    // Column ahead of the post → the column wins.
    await setMemberSeen(db, id, tilde, three)
    expect(await messagesSinceAgent(db, id, tilde)).toEqual([])
  })

  it('never walks the seen watermark backwards', async () => {
    // Two turns can finish out of order (a queued call returns before the turn
    // it was folded into). The advance is monotonic so the later one sticks.
    const id = await makeChat()
    const first = uuidv7()
    await addMessage(db, { id: first, chatId: id, authorId: dru, body: 'one' })
    const second = uuidv7()
    await addMessage(db, { id: second, chatId: id, authorId: dru, body: 'two' })

    await setMemberSeen(db, id, tilde, second)
    await setMemberSeen(db, id, tilde, first) // stale, must not take
    expect(await messagesSinceAgent(db, id, tilde)).toEqual([])
  })

  it('reports the seen watermark on the roster', async () => {
    const id = await makeChat()
    const only = uuidv7()
    await addMessage(db, { id: only, chatId: id, authorId: dru, body: 'one' })
    expect(
      (await listMembers(db, id)).find((m) => m.userId === tilde)
        ?.lastSeenMessageId,
    ).toBeNull()
    await setMemberSeen(db, id, tilde, only)
    expect(
      (await listMembers(db, id)).find((m) => m.userId === tilde)
        ?.lastSeenMessageId,
    ).toBe(only)
  })

  it('finds the chat a backing session speaks for, as that agent', async () => {
    const id = await makeChat()
    const sessionId = uuidv7()
    await createSession(db, { id: sessionId, model: 'm', agentUserId: tilde })
    await setMemberSession(db, id, tilde, sessionId)

    expect(
      await findChatForSession(db, { sessionId, agentUserId: tilde }),
    ).toEqual({ chatId: id, handle: 'tilde' })
    // Another member's identity can't borrow the session: the row must be BOTH
    // the named session's and the named agent's.
    expect(
      await findChatForSession(db, { sessionId, agentUserId: dru }),
    ).toBeUndefined()
    // A session that backs no chat membership at all (an inbox session, a
    // builder's) resolves to nothing — the chat tools simply don't exist there.
    expect(
      await findChatForSession(db, {
        sessionId: 'no-such',
        agentUserId: tilde,
      }),
    ).toBeUndefined()
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

describe('widget persistence + answering', () => {
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

  /** A choice widget raised by @tilde — the shape an agent puts up. */
  async function raise(
    props: JsonValue = { question: 'Ship it?', options: ['Yes', 'No'] },
    over: { kind?: string; stackOrder?: number } = {},
  ): Promise<string> {
    const id = uuidv7()
    await addWidget(db, {
      id,
      chatId,
      kind: over.kind ?? 'choice',
      props,
      stackOrder: over.stackOrder,
      createdById: tilde,
    })
    return id
  }

  it('lists an open widget with who raised it, defaulting to the stack', async () => {
    const id = await raise()
    const rows = await listOpenWidgets(db, chatId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      kind: 'choice',
      placement: STACK_PLACEMENT,
      stackOrder: 0,
      createdByHandle: 'tilde',
      dismissedAt: null,
    })
    expect(rows[0].props).toEqual({
      question: 'Ship it?',
      options: ['Yes', 'No'],
    })
  })

  it('orders the stack by stackOrder, low first', async () => {
    const second = await raise(
      { question: 'Second?', options: ['Ok'] },
      { stackOrder: 5 },
    )
    const first = await raise(
      { question: 'First?', options: ['Ok'] },
      { stackOrder: 1 },
    )
    expect((await listOpenWidgets(db, chatId)).map((w) => w.id)).toEqual([
      first,
      second,
    ])
  })

  it('reorders a widget so it takes the top of the stack', async () => {
    const a = await raise(
      { question: 'A?', options: ['Ok'] },
      { stackOrder: 1 },
    )
    const b = await raise(
      { question: 'B?', options: ['Ok'] },
      { stackOrder: 2 },
    )
    await reorderWidget(db, { widgetId: b, actorId: dru, stackOrder: 0 })
    expect((await listOpenWidgets(db, chatId)).map((w) => w.id)).toEqual([b, a])
  })

  it('answers by posting an ordinary chat message and dismissing the widget', async () => {
    const id = await raise()
    const message = await answerWidget(db, {
      widgetId: id,
      actorId: dru,
      value: 'Yes',
    })

    // An ORDINARY message: same table, same author, same recency bump — so the
    // unseen-message diffing, reply targeting, RLS and SSE all just work.
    const messages = await listMessages(db, chatId)
    expect(messages.map((m) => m.id)).toEqual([message.id])
    expect(messages[0].authorHandle).toBe('dru')
    expect(messages[0].body).toBe(answerMessageBody('Ship it?', 'Yes'))

    // …and it announces itself on the ship's log like any other post.
    const events = await listEventsSince(db, {
      topicPatterns: [chatTopic(chatId)],
      audience: 'members',
    })
    expect(events.map((e) => e.type)).toContain('chat.message_posted')

    // Out of the stack, but the row survives as history.
    expect(await listOpenWidgets(db, chatId)).toEqual([])
    expect(defined(await getWidget(db, id)).dismissedAt).toBeInstanceOf(Date)
  })

  it('answers as the ANSWERING actor, not whoever raised the widget', async () => {
    // @tilde raised it; @dru answered → the message is @dru's, so the reply
    // rules see a human's message and the agent's turn is triggered normally.
    const id = await raise()
    const message = await answerWidget(db, {
      widgetId: id,
      actorId: dru,
      value: 'No',
    })
    expect(message.authorId).toBe(dru)
  })

  it('refuses a second answer, and posts no second message', async () => {
    // The double-submit case: a double tap, or two tabs open on the same chat.
    const id = await raise()
    await answerWidget(db, { widgetId: id, actorId: dru, value: 'Yes' })
    await expect(
      answerWidget(db, { widgetId: id, actorId: dru, value: 'No' }),
    ).rejects.toThrow(/already been answered/)
    expect(await listMessages(db, chatId)).toHaveLength(1)
  })

  it('refuses to answer a widget that was dismissed unanswered', async () => {
    const id = await raise()
    await dismissWidget(db, { widgetId: id, actorId: dru })
    await expect(
      answerWidget(db, { widgetId: id, actorId: dru, value: 'Yes' }),
    ).rejects.toThrow(/already been answered/)
    expect(await listMessages(db, chatId)).toEqual([])
  })

  it('refuses a value the widget never offered, leaving it open', async () => {
    const id = await raise()
    await expect(
      answerWidget(db, { widgetId: id, actorId: dru, value: 'Maybe' }),
    ).rejects.toThrow(/not one of this widget’s options/)
    expect(await listMessages(db, chatId)).toEqual([])
    // Still answerable: a bad submit must not consume the widget.
    expect(await listOpenWidgets(db, chatId)).toHaveLength(1)
  })

  it('refuses to answer a widget whose props offer nothing', async () => {
    // An agent wrote nonsense props. The tile says so; answering can't invent
    // an option list out of a blob nobody can read.
    const id = await raise({ question: 'Ship it?' })
    await expect(
      answerWidget(db, { widgetId: id, actorId: dru, value: 'Yes' }),
    ).rejects.toThrow(/offers nothing to answer/)
    expect(await listMessages(db, chatId)).toEqual([])
  })

  it('refuses to answer a kind that carries no answers at all', async () => {
    // A `note` is read, not answered — and so is a kind this ship has never
    // heard of. The hull needs no kind names to say so: no options, no answer.
    const id = await raise({ text: 'Standup at 09:30' }, { kind: 'note' })
    await expect(
      answerWidget(db, { widgetId: id, actorId: dru, value: 'Yes' }),
    ).rejects.toThrow(/offers nothing to answer/)
    const alien = await raise({ anything: true }, { kind: 'orrery' })
    await expect(
      answerWidget(db, { widgetId: alien, actorId: dru, value: 'Yes' }),
    ).rejects.toThrow(/offers nothing to answer/)
  })

  it('refuses to answer a widget whose chat was deleted — the row is gone', async () => {
    // The never-orphaned invariant: the FK cascade takes the widget with the
    // chat, so a stale button in an open tab answers into nothing, cleanly.
    const id = await raise()
    await db.delete(chats).where(eq(chats.id, chatId))
    expect(await getWidget(db, id)).toBeUndefined()
    await expect(
      answerWidget(db, { widgetId: id, actorId: dru, value: 'Yes' }),
    ).rejects.toThrow(/no such widget/)
  })

  it('lists dismissed widgets in the history, marked, while the stack excludes them', async () => {
    const open = await raise({ question: 'Open?', options: ['Ok'] })
    const gone = await raise({ question: 'Gone?', options: ['Ok'] })
    await dismissWidget(db, { widgetId: gone, actorId: dru })
    expect((await listWidgets(db, chatId)).map((w) => w.id).sort()).toEqual(
      [open, gone].sort(),
    )
    expect((await listOpenWidgets(db, chatId)).map((w) => w.id)).toEqual([open])
  })

  it('dismissing an already-dismissed widget keeps the first dismissal, silently', async () => {
    const id = await raise()
    await dismissWidget(db, { widgetId: id, actorId: dru })
    const first = defined(await getWidget(db, id)).dismissedAt
    await dismissWidget(db, { widgetId: id, actorId: dru })
    expect(defined(await getWidget(db, id)).dismissedAt).toEqual(first)

    // And exactly ONE dismissal was announced: a no-op must not send every
    // member's browser off to refetch a stack that didn't move.
    const events = await listEventsSince(db, {
      topicPatterns: [chatTopic(chatId)],
      audience: 'members',
    })
    expect(
      events.filter(
        (e) =>
          e.type === 'chat.widget_changed' &&
          (e.payload as { change: string }).change === 'dismissed',
      ),
    ).toHaveLength(1)
  })

  it.each([
    [
      'dismiss',
      (id: string) => dismissWidget(db, { widgetId: id, actorId: dru }),
    ],
    [
      'reorder',
      (id: string) =>
        reorderWidget(db, { widgetId: id, actorId: dru, stackOrder: 1 }),
    ],
  ])('refuses to %s a widget that does not exist', async (_verb, act) => {
    await expect(act(uuidv7())).rejects.toThrow(/no such widget/)
  })

  it('announces every change on the chat’s own topic — no new transport', async () => {
    // The browser is already subscribed to chat:<id> for messages, so the stack
    // refreshes off the same stream. Each verb names what it did.
    const id = await raise()
    await reorderWidget(db, { widgetId: id, actorId: dru, stackOrder: 2 })
    await answerWidget(db, { widgetId: id, actorId: dru, value: 'Yes' })
    const waved = await raise({ question: 'Later?', options: ['Ok'] })
    await dismissWidget(db, { widgetId: waved, actorId: dru })

    const events = await listEventsSince(db, {
      topicPatterns: [chatTopic(chatId)],
      audience: 'members',
    })
    // The literal, not the constant: it's a wire format the browser dispatches
    // on (routes/index.tsx), so renaming it silently would break the live stack.
    expect(CHAT_WIDGET_CHANGED).toBe('chat.widget_changed')
    expect(
      events
        .filter((e) => e.type === 'chat.widget_changed')
        .map((e) => (e.payload as { change: string }).change),
    ).toEqual(['raised', 'reordered', 'answered', 'raised', 'dismissed'])
    // Private, like every chat event: nothing on the public audience.
    const pub = await listEventsSince(db, {
      topicPatterns: ['*'],
      audience: 'public',
    })
    expect(pub.filter((e) => e.topic === chatTopic(chatId))).toHaveLength(0)
  })
})
