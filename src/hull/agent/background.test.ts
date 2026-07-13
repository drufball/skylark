import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'

import {
  createBackgroundJobs,
  formatResume,
  tailLines,
  type BackgroundProc,
  type SpawnFn,
} from './background'
import { createSession, listOutstandingBackgroundJobs } from './service'

describe('tailLines', () => {
  it('keeps the last n lines and trims trailing blanks', () => {
    expect(tailLines('a\nb\nc\nd', 2)).toBe('c\nd')
    expect(tailLines('only', 5)).toBe('only')
    expect(tailLines('x\ny\n\n  \n', 2)).toBe('x\ny')
  })
})

describe('formatResume', () => {
  it('reports success and includes the output tail', () => {
    const msg = formatResume('PR #12 CI', 0, 'line1\nall green')
    expect(msg).toContain('"PR #12 CI" succeeded')
    expect(msg).toContain('all green')
    expect(msg).toContain('continue where you left off')
  })

  it('reports a nonzero exit code', () => {
    expect(formatResume('build', 2, 'boom')).toContain('exited with code 2')
  })

  it('omits the output section when there is none', () => {
    expect(formatResume('noop', 0, '')).not.toContain('Output')
  })
})

/** A fake process whose completion the test triggers manually. */
function fakeProc(pid = 4242): BackgroundProc & {
  finish: (c: number, o: string) => void
} {
  let cb: ((code: number, output: string) => void) | undefined
  return {
    pid,
    onClose(fn) {
      cb = fn
    },
    kill: vi.fn(),
    finish(code, output) {
      cb?.(code, output)
    },
  }
}

describe('createBackgroundJobs', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    await createSession(db, { id: 's1', model: 'm' })
    await createSession(db, { id: 's2', model: 'm' })
  })
  afterEach(() => close())

  it('resumes the session with the formatted result when a job finishes', async () => {
    const proc = fakeProc()
    const spawn: SpawnFn = () => proc
    const resume = vi.fn()
    const jobs = createBackgroundJobs({ db, spawn, resume })

    const id = await jobs.start({
      sessionId: 's1',
      command: 'gh pr checks 12 --watch',
      label: 'PR #12 CI',
      cwd: '/wt',
    })
    expect(id).toBeTruthy()
    expect(resume).not.toHaveBeenCalled() // not until it finishes

    proc.finish(0, 'all green')
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledWith(
      's1',
      expect.stringContaining('PR #12 CI'),
    )
  })

  it('passes the command and cwd to spawn', async () => {
    const spawn = vi.fn(() => fakeProc())
    const jobs = createBackgroundJobs({ db, spawn, resume: vi.fn() })
    await jobs.start({
      sessionId: 's1',
      command: 'echo hi',
      label: 'x',
      cwd: '/wt',
    })
    expect(spawn).toHaveBeenCalledWith('echo hi', '/wt')
  })

  it('does not resume a cancelled session, and kills its process', async () => {
    const proc = fakeProc()
    const resume = vi.fn()
    const jobs = createBackgroundJobs({ db, spawn: () => proc, resume })

    await jobs.start({
      sessionId: 's1',
      command: 'sleep 999',
      label: 'x',
      cwd: '/wt',
    })
    jobs.cancelForSession('s1')
    expect(proc.kill).toHaveBeenCalled()

    // Even if the killed process later reports closed, no resume fires.
    proc.finish(143, 'killed')
    expect(resume).not.toHaveBeenCalled()
  })

  it('only cancels jobs for the named session', async () => {
    const p1 = fakeProc()
    const p2 = fakeProc()
    const procs = [p1, p2]
    const spawn: SpawnFn = () => procs.shift() ?? fakeProc()
    const resume = vi.fn()
    const jobs = createBackgroundJobs({ db, spawn, resume })

    await jobs.start({ sessionId: 's1', command: 'a', label: 'a', cwd: '/' })
    await jobs.start({ sessionId: 's2', command: 'b', label: 'b', cwd: '/' })
    jobs.cancelForSession('s1')

    p2.finish(0, 'ok') // s2 still resumes
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledWith('s2', expect.any(String))
  })

  it('writes a durable row when a job starts, so a reload has something to find', async () => {
    const proc = fakeProc(9999)
    const jobs = createBackgroundJobs({
      db,
      spawn: () => proc,
      resume: vi.fn(),
    })

    const id = await jobs.start({
      sessionId: 's1',
      command: 'npm run check',
      label: 'checking',
      cwd: '/wt',
    })

    const outstanding = await listOutstandingBackgroundJobs(db)
    expect(outstanding).toHaveLength(1)
    expect(outstanding[0]).toMatchObject({
      id,
      sessionId: 's1',
      command: 'npm run check',
      label: 'checking',
      cwd: '/wt',
      pid: 9999,
    })
  })

  it('clears the durable row once the job’s real close is observed', async () => {
    const proc = fakeProc()
    const jobs = createBackgroundJobs({
      db,
      spawn: () => proc,
      resume: vi.fn(),
    })
    await jobs.start({ sessionId: 's1', command: 'a', label: 'a', cwd: '/' })
    expect(await listOutstandingBackgroundJobs(db)).toHaveLength(1)

    proc.finish(0, 'done')
    // The row-clear is fire-and-forget off onClose; flush microtasks.
    await Promise.resolve()
    await Promise.resolve()
    expect(await listOutstandingBackgroundJobs(db)).toHaveLength(0)
  })

  it('clears the durable row on cancel too', async () => {
    const proc = fakeProc()
    const jobs = createBackgroundJobs({
      db,
      spawn: () => proc,
      resume: vi.fn(),
    })
    await jobs.start({ sessionId: 's1', command: 'a', label: 'a', cwd: '/' })
    jobs.cancelForSession('s1')
    await Promise.resolve()
    await Promise.resolve()
    expect(await listOutstandingBackgroundJobs(db)).toHaveLength(0)
  })
})
