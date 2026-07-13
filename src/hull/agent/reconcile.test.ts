import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'

import { formatJobLost, reconcileBackgroundJobs } from './reconcile'
import {
  createSession,
  listOutstandingBackgroundJobs,
  recordBackgroundJob,
} from './service'

describe('formatJobLost', () => {
  it('names the job and command, and asks for a redo', () => {
    const msg = formatJobLost('PR #12 CI', 'gh pr checks 12 --watch')
    expect(msg).toContain('"PR #12 CI"')
    expect(msg).toContain('gh pr checks 12 --watch')
    expect(msg).toContain('lost')
    expect(msg).toMatch(/re-run/i)
  })
})

describe('reconcileBackgroundJobs', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    await createSession(db, { id: 's1', model: 'm' })
    await createSession(db, { id: 's2', model: 'm' })
  })
  afterEach(() => close())

  it('resumes every outstanding job with an explicit "lost" message', async () => {
    await recordBackgroundJob(db, {
      id: 'job-1',
      sessionId: 's1',
      command: 'npm run check',
      label: 'checking',
      cwd: '/wt',
      pid: 111,
    })
    const resume = vi.fn()

    await reconcileBackgroundJobs({ db, resume })

    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledWith(
      's1',
      expect.stringContaining('checking'),
    )
  })

  it('clears every outstanding row so a later reconcile does not double-resume', async () => {
    await recordBackgroundJob(db, {
      id: 'job-1',
      sessionId: 's1',
      command: 'a',
      label: 'a',
      cwd: '/',
      pid: 1,
    })

    await reconcileBackgroundJobs({ db, resume: vi.fn() })
    expect(await listOutstandingBackgroundJobs(db)).toEqual([])

    const resume = vi.fn()
    await reconcileBackgroundJobs({ db, resume })
    expect(resume).not.toHaveBeenCalled()
  })

  it('sweeps every session with an outstanding job, not just the first', async () => {
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
    const resume = vi.fn<(sessionId: string, message: string) => void>()

    await reconcileBackgroundJobs({ db, resume })

    expect(resume).toHaveBeenCalledTimes(2)
    expect(resume.mock.calls.map((c) => c[0])).toEqual(['s1', 's2'])
  })

  it('continues past a failing resume so one bad job cannot strand the rest', async () => {
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
    const resume = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('boom')
      })
      .mockImplementationOnce(() => undefined)

    await expect(
      reconcileBackgroundJobs({ db, resume }),
    ).resolves.toBeUndefined()
    expect(resume).toHaveBeenCalledTimes(2)
    // Both rows are cleared regardless of the resume outcome — a failed resume
    // must not leave the row stranded forever either.
    expect(await listOutstandingBackgroundJobs(db)).toEqual([])
  })

  it('does nothing when there are no outstanding jobs', async () => {
    const resume = vi.fn()
    await reconcileBackgroundJobs({ db, resume })
    expect(resume).not.toHaveBeenCalled()
  })
})
