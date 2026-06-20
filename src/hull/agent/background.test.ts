import { describe, expect, it, vi } from 'vitest'

import {
  createBackgroundJobs,
  formatResume,
  tailLines,
  type BackgroundProc,
  type SpawnFn,
} from './background'

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
function fakeProc(): BackgroundProc & {
  finish: (c: number, o: string) => void
} {
  let cb: ((code: number, output: string) => void) | undefined
  return {
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
  it('resumes the session with the formatted result when a job finishes', () => {
    const proc = fakeProc()
    const spawn: SpawnFn = () => proc
    const resume = vi.fn()
    const jobs = createBackgroundJobs({ spawn, resume })

    const id = jobs.start({
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

  it('passes the command and cwd to spawn', () => {
    const spawn = vi.fn(() => fakeProc())
    const jobs = createBackgroundJobs({ spawn, resume: vi.fn() })
    jobs.start({ sessionId: 's1', command: 'echo hi', label: 'x', cwd: '/wt' })
    expect(spawn).toHaveBeenCalledWith('echo hi', '/wt')
  })

  it('does not resume a cancelled session, and kills its process', () => {
    const proc = fakeProc()
    const resume = vi.fn()
    const jobs = createBackgroundJobs({ spawn: () => proc, resume })

    jobs.start({
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

  it('only cancels jobs for the named session', () => {
    const p1 = fakeProc()
    const p2 = fakeProc()
    const procs = [p1, p2]
    const spawn: SpawnFn = () => procs.shift() ?? fakeProc()
    const resume = vi.fn()
    const jobs = createBackgroundJobs({ spawn, resume })

    jobs.start({ sessionId: 's1', command: 'a', label: 'a', cwd: '/' })
    jobs.start({ sessionId: 's2', command: 'b', label: 'b', cwd: '/' })
    jobs.cancelForSession('s1')

    p2.finish(0, 'ok') // s2 still resumes
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledWith('s2', expect.any(String))
  })
})
