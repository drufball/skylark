import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

import { backgroundJobs } from '@hull/agent/schema'
import { issues } from '@hull/issues/schema'

// The night watch owns these two tables — its private memory of what it has
// already done, so a 60s sweep (and a reload) never re-acts on the same state.
//
// The watch service READS the world through other services' functions (issues,
// agent, users) and only WRITES its own two tables here. FKs reach into other
// services by id alone, cascade-deleting so the watch's memory can't outlive
// the thing it was tracking — the same one-way reference pattern issues and
// agent already use.

/**
 * The watch's per-issue nudge memory. One row per building issue the watch has
 * ever nudged. `nudgeCount` is the ESCALATION LADDER and the whole reason this
 * is durable: a reload must not reset it (that would loop gentle nudges
 * forever) and it must survive to drive escalation — 1st nudge gentle, 2nd
 * firm, and on the 3rd the watch stops nudging the agent and pings the owner
 * instead. Monotonic for the life of the row: NOT reset on a partial recovery,
 * deliberately (repeated stalling on one issue should reach a human FASTER, not
 * restart the ladder). Cascades away when the issue is deleted.
 */
export const watchNudges = pgTable('watch_nudges', {
  /** The issue this nudge memory is for (→ issues.id). One row per issue. */
  issueId: text('issue_id')
    .primaryKey()
    .references(() => issues.id, { onDelete: 'cascade' }),
  /**
   * How many times the watch has intervened on this issue's stall: 1 = one
   * nudge sent, 2 = escalated nudge sent, 3 = escalated to the owner (the
   * watch then goes quiet, since the baton is now a human's).
   */
  nudgeCount: integer('nudge_count').notNull().default(0),
  /** When the last intervention fired — the re-nudge floor, so a 60s sweep can't stack. */
  lastNudgeAt: timestamp('last_nudge_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/**
 * The watch's per-job health-check memory. One row per background job the watch
 * has pinged, so it re-wakes the owning session at most once per check-in
 * interval instead of every 60s sweep. Cascades away when the job's row is
 * cleared (job finished or reconciled) — the check history only matters while
 * the job is outstanding.
 */
export const watchJobChecks = pgTable('watch_job_checks', {
  /** The background job being health-checked (→ background_jobs.id). */
  jobId: text('job_id')
    .primaryKey()
    .references(() => backgroundJobs.id, { onDelete: 'cascade' }),
  /** How many health-check wakes the watch has sent for this job. */
  checkCount: integer('check_count').notNull().default(0),
  /** When the watch last woke the owning session about this job. */
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type WatchNudgeRow = typeof watchNudges.$inferSelect
export type WatchJobCheckRow = typeof watchJobChecks.$inferSelect
