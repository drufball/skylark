import { spawn as nodeSpawn } from 'node:child_process'

import { uuidv7 } from '@earendil-works/pi-agent-core'

// Background jobs for agents: an agent can hand a long-running command (waiting
// on CI, a slow build) to this manager, END ITS TURN, and be automatically
// resumed with the result when the command finishes — instead of blocking a
// turn on it (which times out / loops) or stopping and stalling forever.
//
// This is the server-side half; the agent-facing half is the `background` tool
// (background-tool.ts). The manager is pure of process/agent wiring by injection
// (`spawn` + `resume`), so the lifecycle is unit-tested with fakes.

/** A running background process the manager can watch and kill. */
export interface BackgroundProc {
  /** Register the completion callback (exit code + combined output). */
  onClose: (cb: (code: number, output: string) => void) => void
  /** Terminate the process (used when a session is cancelled/disposed). */
  kill: () => void
}

/** Starts a command and returns a handle. Injected so tests need no real process. */
export type SpawnFn = (command: string, cwd: string) => BackgroundProc

export interface BackgroundJobsDeps {
  spawn: SpawnFn
  /** Re-invoke the agent session with a message when a job finishes. */
  resume: (sessionId: string, message: string) => void
}

/** Keep the resume prompt bounded — a long watch can print a lot. */
export const RESUME_TAIL_LINES = 40

/** The last `n` non-empty-trimmed lines of `output`, for the resume prompt. */
export function tailLines(output: string, n: number): string {
  const lines = output.replace(/\s+$/, '').split('\n')
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

/** The message an agent is resumed with when its background job finishes. */
export function formatResume(
  label: string,
  code: number,
  output: string,
): string {
  const status = code === 0 ? 'succeeded' : `exited with code ${String(code)}`
  const tail = tailLines(output, RESUME_TAIL_LINES)
  return (
    `Background task "${label}" ${status}.\n\n` +
    (tail ? `Output (tail):\n${tail}\n\n` : '') +
    'The wait is over — continue where you left off.'
  )
}

interface Job {
  sessionId: string
  proc: BackgroundProc
  cancelled: boolean
}

export function createBackgroundJobs(deps: BackgroundJobsDeps) {
  const jobs = new Set<Job>()

  /** Start a command in the background; the session is resumed when it ends. */
  function start(input: {
    sessionId: string
    command: string
    label: string
    cwd: string
  }): string {
    const jobId = uuidv7()
    const proc = deps.spawn(input.command, input.cwd)
    const job: Job = { sessionId: input.sessionId, proc, cancelled: false }
    jobs.add(job)
    proc.onClose((code, output) => {
      jobs.delete(job)
      // A cancelled job's process still closes; don't resume a session that was
      // torn down (issue closed, agent disposed) — that would wake the dead.
      if (!job.cancelled) {
        deps.resume(input.sessionId, formatResume(input.label, code, output))
      }
    })
    return jobId
  }

  /** Kill any background jobs for a session (on cancel/dispose); no resume. */
  function cancelForSession(sessionId: string): void {
    for (const job of [...jobs]) {
      if (job.sessionId !== sessionId) continue
      job.cancelled = true
      jobs.delete(job)
      job.proc.kill()
    }
  }

  return { start, cancelForSession }
}

export type BackgroundJobs = ReturnType<typeof createBackgroundJobs>

/* v8 ignore start -- live child-process wiring, exercised in the real app not units */
/** The real spawn: a shell child whose combined output we buffer for the resume. */
export const defaultSpawn: SpawnFn = (command, cwd) => {
  const child = nodeSpawn(command, { cwd, shell: true })
  let output = ''
  child.stdout.on('data', (d: Buffer) => {
    output += d.toString()
  })
  child.stderr.on('data', (d: Buffer) => {
    output += d.toString()
  })
  return {
    onClose(cb) {
      child.on('close', (code) => {
        cb(code ?? -1, output)
      })
    },
    kill() {
      child.kill()
    },
  }
}
/* v8 ignore stop */
