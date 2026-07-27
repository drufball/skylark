import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'

import {
  appendMessage,
  clearBackgroundJob,
  createSession,
  findAgentSessionByTitle,
  getMessages,
  getSession,
  listFleet,
  listOutstandingBackgroundJobs,
  listSessions,
  recordBackgroundJob,
  resolveSessionRef,
  runningSessionIds,
  setStatus,
  titleFromMessage,
} from './service'

describe('agent service persistence', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

  it('creates a session and reads it back', async () => {
    const session = await createSession(db, {
      id: 's1',
      model: 'claude-sonnet-4-5',
      title: 'Hello there',
    })

    expect(session.id).toBe('s1')
    expect(session.status).toBe('idle')
    expect(await getSession(db, 's1')).toMatchObject({
      id: 's1',
      model: 'claude-sonnet-4-5',
      title: 'Hello there',
    })
  })

  it('returns undefined for a missing session', async () => {
    expect(await getSession(db, 'nope')).toBeUndefined()
  })

  it('appends messages and reads them back in turn order', async () => {
    await createSession(db, { id: 's1', model: 'm' })

    // Append out of insertion order is impossible — seq is monotonic — so just
    // append a realistic transcript and confirm it round-trips verbatim.
    await appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    })
    await appendMessage(db, {
      sessionId: 's1',
      role: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello!' }],
      },
    })

    const messages = await getMessages(db, 's1')
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1].message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello!' }],
    })
    // seq is strictly increasing — the ordering guarantee history rebuild leans on.
    expect(messages[0].seq).toBeLessThan(messages[1].seq)
  })

  it('does not leak messages across sessions', async () => {
    await createSession(db, { id: 'a', model: 'm' })
    await createSession(db, { id: 'b', model: 'm' })
    await appendMessage(db, { sessionId: 'a', role: 'user', message: { x: 1 } })

    expect(await getMessages(db, 'a')).toHaveLength(1)
    expect(await getMessages(db, 'b')).toHaveLength(0)
  })

  it('bumps last_message_at on each append so the sidebar reorders', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    const before = defined(await getSession(db, 's1')).lastMessageAt
    await new Promise((r) => setTimeout(r, 5))
    await appendMessage(db, { sessionId: 's1', role: 'user', message: {} })
    const after = defined(await getSession(db, 's1')).lastMessageAt

    expect(after.getTime()).toBeGreaterThan(before.getTime())
  })

  it('tracks status, including an error message', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    await setStatus(db, 's1', 'running')
    expect(defined(await getSession(db, 's1')).status).toBe('running')

    await setStatus(db, 's1', 'error', 'overloaded')
    const errored = defined(await getSession(db, 's1'))
    expect(errored.status).toBe('error')
    expect(errored.error).toBe('overloaded')

    // Clearing back to idle drops the stale error.
    await setStatus(db, 's1', 'idle')
    expect(defined(await getSession(db, 's1')).error).toBeNull()
  })

  describe('listSessions', () => {
    beforeEach(async () => {
      await createSession(db, { id: 'old', model: 'm' })
      await createSession(db, { id: 'mid', model: 'm' })
      await createSession(db, { id: 'new', model: 'm' })
      // Stagger activity so ordering and the `since` filter are testable.
      await db.execute(
        sql`update agent_sessions set last_message_at = '2020-01-01' where id = 'old'`,
      )
      await db.execute(
        sql`update agent_sessions set last_message_at = '2024-06-01' where id = 'mid'`,
      )
      await db.execute(
        sql`update agent_sessions set last_message_at = '2026-06-01' where id = 'new'`,
      )
      await setStatus(db, 'mid', 'running')
    })

    it('orders newest activity first', async () => {
      expect((await listSessions(db)).map((s) => s.id)).toEqual([
        'new',
        'mid',
        'old',
      ])
    })

    it('filters to running sessions', async () => {
      expect(
        (await listSessions(db, { running: true })).map((s) => s.id),
      ).toEqual(['mid'])
    })

    it('filters by last-message date', async () => {
      expect(
        (await listSessions(db, { since: new Date('2023-01-01') })).map(
          (s) => s.id,
        ),
      ).toEqual(['new', 'mid'])
    })
  })

  describe('findAgentSessionByTitle', () => {
    it('finds the agent session with the well-known title, oldest first', async () => {
      const { createUser } = await import('@hull/users/service')
      await createUser(db, {
        id: 'agent-a',
        handle: 'tilde',
        displayName: 'Tilde',
        type: 'agent',
      })
      await createUser(db, {
        id: 'agent-b',
        handle: 'bix',
        displayName: 'Bix',
        type: 'agent',
      })
      // Same title on another agent, other titles on this one — neither match.
      await createSession(db, {
        id: 's-other-agent',
        model: 'm',
        title: 'Inbox',
        agentUserId: 'agent-b',
      })
      await createSession(db, {
        id: 's-other-title',
        model: 'm',
        title: 'Build #aa11',
        agentUserId: 'agent-a',
      })
      expect(
        await findAgentSessionByTitle(db, 'agent-a', 'Inbox'),
      ).toBeUndefined()

      await createSession(db, {
        id: 's-inbox-1',
        model: 'm',
        title: 'Inbox',
        agentUserId: 'agent-a',
      })
      // A duplicate (rare race) converges on the OLDEST — one stable winner.
      await createSession(db, {
        id: 's-inbox-2',
        model: 'm',
        title: 'Inbox',
        agentUserId: 'agent-a',
      })
      expect(
        defined(await findAgentSessionByTitle(db, 'agent-a', 'Inbox')).id,
      ).toBe('s-inbox-1')
    })
  })

  describe('runningSessionIds', () => {
    it('answers which of the given sessions have a turn in flight', async () => {
      await createSession(db, { id: 'r1', model: 'm' })
      await createSession(db, { id: 'r2', model: 'm' })
      await createSession(db, { id: 'idle', model: 'm' })
      await setStatus(db, 'r1', 'running')
      await setStatus(db, 'r2', 'running')

      // Only the asked-about ids come back — r2 runs but wasn't asked about.
      expect(await runningSessionIds(db, ['r1', 'idle', 'ghost'])).toEqual([
        'r1',
      ])
      expect(await runningSessionIds(db, [])).toEqual([])
    })
  })

  describe('resolveSessionRef', () => {
    it('resolves a full id', async () => {
      await createSession(db, { id: '01912345-full', model: 'm' })
      expect(await resolveSessionRef(db, '01912345-full')).toMatchObject({
        id: '01912345-full',
      })
    })

    it('resolves a unique id prefix', async () => {
      await createSession(db, { id: '0191abc-session', model: 'm' })
      expect(await resolveSessionRef(db, '0191abc')).toMatchObject({
        id: '0191abc-session',
      })
    })

    it('returns undefined for no match', async () => {
      expect(await resolveSessionRef(db, 'nope')).toBeUndefined()
    })

    it('throws when a prefix matches more than one session', async () => {
      await createSession(db, { id: '0191dup-one', model: 'm' })
      await createSession(db, { id: '0191dup-two', model: 'm' })
      await expect(resolveSessionRef(db, '0191dup')).rejects.toThrow(
        /ambiguous/i,
      )
    })
  })
})

describe('background jobs persistence', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    await createSession(db, { id: 's1', model: 'm' })
  })
  afterEach(() => close())

  it('records a job and lists it as outstanding', async () => {
    await recordBackgroundJob(db, {
      id: 'job-1',
      sessionId: 's1',
      command: 'gh pr checks 12 --watch',
      label: 'PR #12 CI',
      cwd: '/wt',
      pid: 4242,
    })

    const outstanding = await listOutstandingBackgroundJobs(db)
    expect(outstanding).toHaveLength(1)
    expect(outstanding[0]).toMatchObject({
      id: 'job-1',
      sessionId: 's1',
      command: 'gh pr checks 12 --watch',
      label: 'PR #12 CI',
      cwd: '/wt',
      pid: 4242,
    })
  })

  it('clears a job so it no longer lists as outstanding', async () => {
    await recordBackgroundJob(db, {
      id: 'job-1',
      sessionId: 's1',
      command: 'echo hi',
      label: 'x',
      cwd: '/wt',
      pid: 1,
    })
    await clearBackgroundJob(db, 'job-1')
    expect(await listOutstandingBackgroundJobs(db)).toEqual([])
  })

  it('clearing a job that does not exist is a no-op', async () => {
    await expect(clearBackgroundJob(db, 'ghost')).resolves.toBeUndefined()
  })

  it('lists jobs for multiple sessions, oldest first', async () => {
    await createSession(db, { id: 's2', model: 'm' })
    await recordBackgroundJob(db, {
      id: 'job-1',
      sessionId: 's1',
      command: 'a',
      label: 'a',
      cwd: '/',
      pid: 1,
    })
    await recordBackgroundJob(db, {
      id: 'job-2',
      sessionId: 's2',
      command: 'b',
      label: 'b',
      cwd: '/',
      pid: 2,
    })
    const outstanding = await listOutstandingBackgroundJobs(db)
    expect(outstanding.map((j) => j.id)).toEqual(['job-1', 'job-2'])
  })
})

describe('listFleet', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

  it('attaches each session’s own outstanding jobs, newest activity first', async () => {
    await createSession(db, { id: 'old', model: 'm' })
    await createSession(db, { id: 'new', model: 'm' })
    await db.execute(
      sql`update agent_sessions set last_message_at = '2020-01-01' where id = 'old'`,
    )
    await db.execute(
      sql`update agent_sessions set last_message_at = '2026-06-01' where id = 'new'`,
    )
    await recordBackgroundJob(db, {
      id: 'job-old',
      sessionId: 'old',
      command: 'gh pr checks 12 --watch',
      label: 'PR #12 CI',
      cwd: '/wt',
      pid: 1,
    })

    const fleet = await listFleet(db)

    expect(fleet.map((f) => f.session.id)).toEqual(['new', 'old'])
    expect(fleet.find((f) => f.session.id === 'new')?.jobs).toEqual([])
    expect(fleet.find((f) => f.session.id === 'old')?.jobs).toMatchObject([
      { id: 'job-old', label: 'PR #12 CI' },
    ])
  })

  it('returns an empty jobs list for a session with none', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    const fleet = await listFleet(db)
    expect(fleet).toHaveLength(1)
    expect(fleet[0].session.id).toBe('s1')
    expect(fleet[0].jobs).toEqual([])
  })

  it('returns nothing when there are no sessions', async () => {
    expect(await listFleet(db)).toEqual([])
  })
})

describe('titleFromMessage', () => {
  it('takes the first line', () => {
    expect(titleFromMessage('build me a thing\nand another')).toBe(
      'build me a thing',
    )
  })

  it('truncates long titles with an ellipsis', () => {
    expect(titleFromMessage('x'.repeat(100), 10)).toBe('xxxxxxxxx…')
  })

  it('trims surrounding whitespace', () => {
    expect(titleFromMessage('   hi   ')).toBe('hi')
  })
})
