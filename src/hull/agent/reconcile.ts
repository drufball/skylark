import type { Database } from '@hull/db/client'
import { errorMessage } from '@hull/lib/errors'

import { clearBackgroundJob, listOutstandingBackgroundJobs } from './service'

/**
 * Startup reconciliation for background jobs (issue #v6ft): every row still in
 * `background_jobs` at boot was started by a process that's gone now — this
 * one, freshly booted, has no in-process `Job` for it (background.ts's `Set`
 * doesn't survive a reload) and no handle on the original child's stdout/
 * stderr pipes even on the rare chance the OS process is somehow still alive.
 * There is no way to re-attach and recover a job's real output (see
 * schema.ts's doc comment on `background_jobs.pid` — carried for
 * observability only, deliberately not used to re-attach).
 *
 * So every outstanding row is resumed with an explicit "this was lost"
 * message instead of silence — the core promise of this issue: a session
 * always eventually hears SOMETHING about its background job, never nothing.
 * Same shape as the issues/chat orchestrators' own boot-time `reconcile()`:
 * per-item, best-effort, continuing past one failure rather than letting it
 * strand the rest.
 *
 * Each row is cleared BEFORE its session is resumed, so a reconcile that
 * somehow runs twice (not expected at boot, but cheap to guard) can't resume
 * the same session twice for the same job.
 */
export interface ReconcileBackgroundJobsDeps {
  db: Database
  /**
   * Re-invoke a session with a message. Awaited when it returns a promise —
   * boot reconciliation completing means the resumes actually happened, not
   * merely that they were fired off.
   */
  resume: (sessionId: string, message: string) => void | Promise<void>
}

/** The message a session is resumed with when its background job's fate is unrecoverable. */
export function formatJobLost(label: string, command: string): string {
  return (
    `Your background task "${label}" was lost — the process watching it did ` +
    `not survive a server restart, and its output could not be recovered.\n\n` +
    `Command: ${command}\n\n` +
    `Re-run it (in the foreground, or background it again) and continue from there.`
  )
}

export async function reconcileBackgroundJobs(
  deps: ReconcileBackgroundJobsDeps,
): Promise<void> {
  const outstanding = await listOutstandingBackgroundJobs(deps.db)
  for (const job of outstanding) {
    await clearBackgroundJob(deps.db, job.id).catch((err: unknown) => {
      console.error(
        `background reconcile ${job.id}: clearing durable row failed: ${errorMessage(err)}`,
      )
    })
    try {
      await deps.resume(job.sessionId, formatJobLost(job.label, job.command))
    } catch (err) {
      console.error(
        `background reconcile ${job.id}: resume failed (continuing): ${errorMessage(err)}`,
      )
    }
  }
}
