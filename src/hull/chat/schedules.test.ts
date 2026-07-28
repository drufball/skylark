import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import { createChat, listMessages } from './messages'
import {
  advanceNextFire,
  canAuthorSchedule,
  createSchedule,
  deleteSchedule,
  fireDueSchedules,
  getSchedule,
  isScheduleDue,
  listDueSchedules,
  listSchedules,
  MIN_INTERVAL_MINUTES,
  scheduleTiming,
  setScheduleEnabled,
} from './schedules'

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
