import { spawn as nodeSpawn } from 'node:child_process'

import { uuidv7 } from '@earendil-works/pi-agent-core'

import type { Database } from '@hull/db/client'

import { clearBackgroundJob, recordBackgroundJob } from './service'

// Background jobs for agents: an agent can hand a long-running command (waiting
// on CI, a slow build) to this manager, END ITS TURN, and be automatically
// resumed with the result when the command finishes — instead of blocking a
// turn on it (which times out / loops) or stopping and stalling forever.
//
// This is the server-side half; the agent-facing half is the `background` tool
// (background-tool.ts). The manager is pure of process/agent wiring by injection
// (`spawn` + `resume`), so the lifecycle is unit-tested with fakes.
//
// A job is durable from the moment it starts (issue #v6ft): `start()` writes a
// `background_jobs` row BEFORE returning, so a reload that wipes this
// in-process `Set` clean still leaves a durable trail the boot-time reconciler
// (reconcile.ts) can find and act on. The row is cleared the instant a real
// close is observed — by THIS process if it's still around, or never (it's the
// reconciler's job then) if it isn't.

/** A running background process the manager can watch and kill. */
export interface BackgroundProc {
  /** The OS pid of the spawned child, for the durable row (observability). */
  pid: number
  /** Register the completion callback (exit code + combined output). */
  onClose: (cb: (code: number, output: string) => void) => void
  /** Terminate the process (used when a session is cancelled/disposed). */
  kill: () => void
}

/** Starts a command and returns a handle. Injected so tests need no real process. */
export type SpawnFn = (command: string, cwd: string) => BackgroundProc

export interface BackgroundJobsDeps {
  db: Database
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
  id: string
  sessionId: string
  proc: BackgroundProc
  cancelled: boolean
}

export function createBackgroundJobs(deps: BackgroundJobsDeps) {
  const jobs = new Set<Job>()

  /**
   * Start a command in the background; the session is resumed when it ends.
   * The durable row is written before this resolves, so a process that dies
   * the instant after start() returns still leaves a row the reconciler can
   * find — the tool call that triggered this has already ended the agent's
   * turn by the time it matters.
   */
  async function start(input: {
    sessionId: string
    command: string
    label: string
    cwd: string
  }): Promise<string> {
    const jobId = uuidv7()
    const proc = deps.spawn(input.command, input.cwd)
    const job: Job = {
      id: jobId,
      sessionId: input.sessionId,
      proc,
      cancelled: false,
    }
    jobs.add(job)
    await recordBackgroundJob(deps.db, {
      id: jobId,
      sessionId: input.sessionId,
      command: input.command,
      label: input.label,
      cwd: input.cwd,
      pid: proc.pid,
    })
    proc.onClose((code, output) => {
      jobs.delete(job)
      void clearBackgroundJob(deps.db, jobId).catch((err: unknown) => {
        console.error(
          `background job ${jobId}: clearing durable row failed: ${String(err)}`,
        )
      })
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
      void clearBackgroundJob(deps.db, job.id).catch((err: unknown) => {
        console.error(
          `background job ${job.id}: clearing durable row failed: ${String(err)}`,
        )
      })
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
    pid: child.pid ?? -1,
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
