import { desc, eq, sql } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import {
  listOutstandingBackgroundJobs,
  runningSessionIds,
} from '@hull/agent/service'
import type { BackgroundJobRow } from '@hull/agent/schema'
import { emitEvent } from '@hull/events/bus'
import { PUBLIC_AUDIENCE } from '@hull/events/service'
import {
  computeBuildActivity,
  formatStallDuration,
} from '@hull/issues/activity'
import {
  getIssue,
  getIssueSession,
  listIssues,
  listIssueSessions,
  setBatonHolder,
} from '@hull/issues/service'
import { issueTopic } from '@hull/issues/topic'
import type { IssueRow } from '@hull/issues/schema'
import type { NotificationMetadata } from '@hull/notifications/metadata'
import { errorMessage } from '@hull/lib/errors'
import { getUserById, handleOf } from '@hull/users/service'

import {
  watchJobChecks,
  watchNudges,
  type WatchJobCheckRow,
  type WatchNudgeRow,
} from './schema'

/**
 * The night watch, pure of the clock and the runtime. Two rules over the ship's
 * building sessions, both driven by an injected `now` and an injected
 * `driveTurn` (which MUST be the issues orchestrator's own runtime — see the
 * zine's ownership note), so every threshold and decision is unit-testable with
 * a fake clock and every intervention is observable in a test.
 *
 * Rule 1 (stall nudge): a building issue whose baton is held by an AGENT, with
 * no outstanding background job, an idle baton-holder session, and a status
 * line gone quiet past the threshold, is nudged — gently, then firmly, then the
 * owner is pinged and the watch goes quiet.
 *
 * Rule 2 (health check): a background job outstanding past its check-in
 * interval wakes its owning session to self-report health, re-woken every
 * interval. NOT stall treatment — a healthy job just ends its turn.
 *
 * Rule 3 (visibility): every intervention emits a `watchdog.*` durable event on
 * the issue topic, so the notifications reactor fans it to watchers for free.
 */

// --- Event types (source 'watch', topic issue:<id>, audience public) --------

/** A stall nudge was driven onto the baton holder's session. */
export const WATCHDOG_NUDGED = 'watchdog.nudged'
/** A stall was escalated to the issue owner (baton handed to the human). */
export const WATCHDOG_OWNER_PING = 'watchdog.owner_ping'
/** A long background wait's owning session was woken for a health check. */
export const WATCHDOG_HEALTH_CHECK = 'watchdog.health_check'

/** The ship-log source every watchdog event carries. */
export const WATCH_SOURCE = 'watch'

// --- Config -----------------------------------------------------------------

export interface WatchConfig {
  /** How often the live sweep runs. */
  sweepMs: number
  /** How long a build's status line may be quiet before a stall nudge. */
  stallThresholdMs: number
  /** Default per-job check-in interval when a job carries no override. */
  jobCheckIntervalMs: number
}

/** ~60s sweep — frequent enough to catch a stall, cheap enough to ignore. */
export const DEFAULT_SWEEP_MS = 60_000
/** 15 minutes of a quiet status line before the first nudge. */
export const DEFAULT_STALL_THRESHOLD_MS = 15 * 60_000
/** 10 minutes outstanding before a background wait gets a health check. */
export const DEFAULT_JOB_CHECK_INTERVAL_MS = 10 * 60_000

/** Parse a positive-integer env value, falling back on absent/NaN/non-positive. */
export function positiveIntOr(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Resolve the watch config from the environment, all overridable and all with
 * safe defaults. Pure of `process.env` (the record is passed in) so it's
 * testable without mutating global state.
 */
export function resolveWatchConfig(env: {
  SKYLARK_WATCH_SWEEP_MS?: string
  SKYLARK_WATCH_STALL_MS?: string
  SKYLARK_WATCH_JOB_INTERVAL_MS?: string
}): WatchConfig {
  return {
    sweepMs: positiveIntOr(env.SKYLARK_WATCH_SWEEP_MS, DEFAULT_SWEEP_MS),
    stallThresholdMs: positiveIntOr(
      env.SKYLARK_WATCH_STALL_MS,
      DEFAULT_STALL_THRESHOLD_MS,
    ),
    jobCheckIntervalMs: positiveIntOr(
      env.SKYLARK_WATCH_JOB_INTERVAL_MS,
      DEFAULT_JOB_CHECK_INTERVAL_MS,
    ),
  }
}

// --- Pure decisions ---------------------------------------------------------

/** What the watch should do about a possibly-stalled building issue. */
export type StallAction =
  | { kind: 'none' }
  | { kind: 'nudge'; escalated: boolean }
  | { kind: 'ownerPing' }

/**
 * Decide the stall action for one building issue, purely. Reuses the display
 * classifier (`computeBuildActivity`) as the "is it quiet, and for how long"
 * oracle — so the watch never duplicates the waiting/running/stalled thresholds
 * — then layers the watch's own stall threshold, its re-nudge floor (no two
 * interventions inside one threshold window, which is what stops a 60s sweep
 * stacking nudges), and the escalation ladder from the persisted count.
 */
export function decideStall(input: {
  /** Baton held by an agent (not a human, not empty)? Only then do we nudge. */
  batonIsAgent: boolean
  /** Any outstanding background job on the issue's sessions? Then it's Rule 2. */
  hasOutstandingJob: boolean
  /** Is the baton holder's session mid-turn right now? Never nudge a running one. */
  sessionRunning: boolean
  statusLine: string | null
  statusLineAt: string | null
  awaitingBackground: boolean
  /** How many interventions already recorded for this issue. */
  nudgeCount: number
  lastNudgeAt: string | null
  now: Date
  stallThresholdMs: number
}): StallAction {
  // A human baton means "waiting for input" — never nudge. An empty baton
  // (pre-column build, or one we can't resolve) is treated the same way.
  if (!input.batonIsAgent) return { kind: 'none' }
  // An outstanding background job is Rule 2's business, not a stall.
  if (input.hasOutstandingJob) return { kind: 'none' }

  const activity = computeBuildActivity({
    sessionRunning: input.sessionRunning,
    statusLine: input.statusLine,
    statusLineAt: input.statusLineAt,
    awaitingBackground: input.awaitingBackground,
    now: input.now,
  })
  // 'busy' (a turn is running) and 'waiting' (a fresh deliberate background
  // wait) are both fine; only 'stalled' is actionable, and 'null' means no
  // status line yet — treat conservatively as not-actionable.
  if (activity?.state !== 'stalled') return { kind: 'none' }
  if (activity.stalledMs < input.stallThresholdMs) return { kind: 'none' }

  // Re-nudge floor: never intervene twice within one threshold window, so a
  // nudge whose turn produced no progress tick isn't stacked 60s later.
  if (input.lastNudgeAt) {
    const sinceNudge =
      input.now.getTime() - new Date(input.lastNudgeAt).getTime()
    if (sinceNudge < input.stallThresholdMs) return { kind: 'none' }
  }

  if (input.nudgeCount <= 0) return { kind: 'nudge', escalated: false }
  if (input.nudgeCount === 1) return { kind: 'nudge', escalated: true }
  // Third intervention and beyond: stop nudging the agent, hand to a human.
  return { kind: 'ownerPing' }
}

/**
 * Decide whether a background job is due a health-check wake, purely. Due when
 * it has been outstanding at least one interval AND we have not woken its
 * session within the last interval — and never while the session is mid-turn
 * (don't inject into a live turn; the next sweep catches it).
 */
export function decideHealthCheck(input: {
  sessionRunning: boolean
  jobCreatedAt: string
  intervalMs: number
  lastCheckedAt: string | null
  now: Date
}): boolean {
  if (input.sessionRunning) return false
  const age = input.now.getTime() - new Date(input.jobCreatedAt).getTime()
  if (age < input.intervalMs) return false
  if (input.lastCheckedAt) {
    const sinceCheck =
      input.now.getTime() - new Date(input.lastCheckedAt).getTime()
    if (sinceCheck < input.intervalMs) return false
  }
  return true
}

/** The check-in interval for a job: its per-call override, else the default. */
export function jobCheckIntervalMs(
  job: BackgroundJobRow,
  defaultMs: number,
): number {
  return job.checkInIntervalMs && job.checkInIntervalMs > 0
    ? job.checkInIntervalMs
    : defaultMs
}

// --- Prompts (what the woken agent reads) -----------------------------------

/** The nudge driven onto a stalled build's baton holder — gentle, then firm. */
export function nudgePrompt(escalated: boolean, stalledMs: number): string {
  const duration = formatStallDuration(stalledMs)
  if (!escalated) {
    return (
      `[night watch] Heads up — this issue's build has shown no activity for ` +
      `${duration} and nothing is running in the background, so it looks like ` +
      `the turn stopped early. If you're still on this, pick up exactly where ` +
      `you left off and keep going. If you're genuinely blocked or waiting on ` +
      `something you can't resolve yourself, hand off the baton — to another ` +
      `agent on the playbook, or \`handoff OWNER\` for a human decision — so ` +
      `the work doesn't sit idle. Don't just stop.`
    )
  }
  return (
    `[night watch] Still nothing for ${duration}, and an earlier nudge didn't ` +
    `move it. Please act now: either make concrete progress on this issue, or ` +
    `hand off the baton. If you genuinely can't proceed, \`handoff OWNER\` so ` +
    `a human can unblock it. If this stays silent, the watch will escalate to ` +
    `the issue owner next.`
  )
}

/** The health-check wake for a long background wait — self-report, don't panic. */
export function healthCheckPrompt(
  label: string,
  outstandingMs: number,
): string {
  const duration = formatStallDuration(outstandingMs)
  return (
    `[night watch] Your background task "${label}" has been running for ` +
    `${duration}. Quick health check — is it still alive and making progress? ` +
    `If it looks healthy, just say so and end your turn; you'll still be ` +
    `resumed automatically when it finishes, so there's nothing else to do. ` +
    `If it looks dead, hung, or is taking far longer than it should, stop ` +
    `waiting on it and deal with it (investigate, re-run, or hand off).`
  )
}

// --- Persistence (the watch's own two tables) -------------------------------

export async function getNudgeRow(
  db: Database,
  issueId: string,
): Promise<WatchNudgeRow | undefined> {
  const [row] = await db
    .select()
    .from(watchNudges)
    .where(eq(watchNudges.issueId, issueId))
  return row
}

/** Record an intervention: set the new count and the last-nudge clock (upsert). */
export async function recordIntervention(
  db: Database,
  issueId: string,
  nudgeCount: number,
  now: Date,
): Promise<void> {
  await db
    .insert(watchNudges)
    .values({ issueId, nudgeCount, lastNudgeAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: watchNudges.issueId,
      set: { nudgeCount, lastNudgeAt: now, updatedAt: now },
    })
}

/** Every issue the watch has intervened on, most-recent first — the CLI's read. */
export async function listNudgeRows(db: Database): Promise<WatchNudgeRow[]> {
  return db.select().from(watchNudges).orderBy(desc(watchNudges.updatedAt))
}

export async function getJobCheckRow(
  db: Database,
  jobId: string,
): Promise<WatchJobCheckRow | undefined> {
  const [row] = await db
    .select()
    .from(watchJobChecks)
    .where(eq(watchJobChecks.jobId, jobId))
  return row
}

/** Every job the watch is health-checking, most-recent first — the CLI's read. */
export async function listJobCheckRows(
  db: Database,
): Promise<WatchJobCheckRow[]> {
  return db
    .select()
    .from(watchJobChecks)
    .orderBy(desc(watchJobChecks.lastCheckedAt))
}

/** Record a health-check wake: bump the count and the last-checked clock (upsert). */
export async function recordJobCheck(
  db: Database,
  jobId: string,
  now: Date,
): Promise<void> {
  await db
    .insert(watchJobChecks)
    .values({ jobId, checkCount: 1, lastCheckedAt: now })
    .onConflictDoUpdate({
      target: watchJobChecks.jobId,
      set: {
        checkCount: sql`${watchJobChecks.checkCount} + 1`,
        lastCheckedAt: now,
      },
    })
}

// --- Visibility (Rule 3): emit a watchdog.* event on the issue topic --------

/**
 * Emit one `watchdog.*` durable event on the issue's topic. The notifications
 * reactor fans any public event carrying `_notification` metadata to the
 * topic's watchers (plus `addRecipients`) — so this is the whole surfacing
 * seam, no bespoke inbox code. `issueId` rides in the payload because the
 * reactor validates `addRecipients` against it. The actor is the agent the
 * intervention concerns, so "your own action isn't news" spares it a redundant
 * inbox row (it gets the driven turn instead).
 */
async function emitWatchdog(
  db: Database,
  input: {
    type: string
    issueId: string
    actorId: string | null
    headline: string
    addRecipients?: string[]
  },
): Promise<void> {
  const metadata: NotificationMetadata = {
    autoWatch: false,
    headline: input.headline,
    ...(input.addRecipients ? { addRecipients: input.addRecipients } : {}),
  }
  await emitEvent(db, {
    type: input.type,
    source: WATCH_SOURCE,
    topic: issueTopic(input.issueId),
    audience: PUBLIC_AUDIENCE,
    actorId: input.actorId,
    payload: { issueId: input.issueId, _notification: metadata },
  })
}

// --- The sweep (orchestration; PGlite-tested with injected effects) ---------

export interface WatchSweepDeps {
  /** Injected clock — the whole sweep is time-pure. */
  now: Date
  config: WatchConfig
  /**
   * Drive a turn on an issue-backed session THROUGH THE ISSUES ORCHESTRATOR'S
   * OWN RUNTIME (see the zine). Fire-and-forget: the runtime queues if the
   * session is mid-turn, so a sweep never double-drives. Injected so tests
   * observe the drive without a runtime.
   */
  driveTurn: (issueId: string, sessionId: string, text: string) => void
}

/**
 * One sweep: apply Rule 1 (stall nudges) to every building issue, then Rule 2
 * (health checks) to every outstanding background job on a building issue's
 * session. Idempotent across sweeps via the persisted timestamps — a 60s sweep
 * never stacks. Each step is error-isolated so one bad issue/job can't sink the
 * rest of the sweep.
 */
export async function runWatchSweep(
  db: Database,
  deps: WatchSweepDeps,
): Promise<void> {
  const issues = await listIssues(db)
  const building = issues.filter((i) => i.status === 'building')

  // Map every building issue's sessions once: sessionId → { issue, agentUserId }.
  // This is also how a background job is tied back to its issue for Rule 2 (v1
  // scope: issue-backed building sessions only).
  const sessionToIssue = new Map<
    string,
    { issue: IssueRow; agentUserId: string }
  >()
  const sessionsByIssue = new Map<string, string[]>()
  for (const issue of building) {
    const links = await listIssueSessions(db, issue.id)
    sessionsByIssue.set(
      issue.id,
      links.map((l) => l.sessionId),
    )
    for (const link of links) {
      sessionToIssue.set(link.sessionId, {
        issue,
        agentUserId: link.agentUserId,
      })
    }
  }

  const outstanding = await listOutstandingBackgroundJobs(db)
  const jobSessionIds = new Set(outstanding.map((j) => j.sessionId))

  // Which of the building/job sessions are mid-turn right now (one query).
  const relevantSessions = new Set<string>([
    ...sessionToIssue.keys(),
    ...jobSessionIds,
  ])
  const running = new Set(await runningSessionIds(db, [...relevantSessions]))

  // Rule 1 — stall nudges.
  for (const issue of building) {
    await handleStall(db, deps, {
      issue,
      sessionIds: sessionsByIssue.get(issue.id) ?? [],
      jobSessionIds,
      running,
    }).catch((err: unknown) => {
      console.error(
        `watch: stall check for #${issue.nano} failed (continuing): ${errorMessage(err)}`,
      )
    })
  }

  // Rule 2 — background health checks (issue-backed building sessions only).
  for (const job of outstanding) {
    const owner = sessionToIssue.get(job.sessionId)
    if (!owner) continue // chat/bare session job — out of v1 scope
    await handleHealthCheck(db, deps, {
      job,
      issue: owner.issue,
      agentUserId: owner.agentUserId,
      running,
    }).catch((err: unknown) => {
      console.error(
        `watch: health check for job ${job.id} failed (continuing): ${errorMessage(err)}`,
      )
    })
  }
}

async function handleStall(
  db: Database,
  deps: WatchSweepDeps,
  ctx: {
    issue: IssueRow
    sessionIds: string[]
    jobSessionIds: Set<string>
    running: Set<string>
  },
): Promise<void> {
  const { issue } = ctx
  const holderId = issue.batonHolderId
  if (!holderId) return
  const holder = await getUserById(db, holderId)
  const batonIsAgent = holder?.type === 'agent'

  // The baton holder's session on this issue — the one we'd nudge.
  const holderLink = await getIssueSession(db, issue.id, holderId)
  const holderSessionId = holderLink?.sessionId ?? null
  const sessionRunning = holderSessionId
    ? ctx.running.has(holderSessionId)
    : false
  const hasOutstandingJob = ctx.sessionIds.some((id) =>
    ctx.jobSessionIds.has(id),
  )

  const nudgeRow = await getNudgeRow(db, issue.id)
  const action = decideStall({
    batonIsAgent,
    hasOutstandingJob,
    sessionRunning,
    statusLine: issue.statusLine,
    statusLineAt: issue.statusLineAt ? issue.statusLineAt.toISOString() : null,
    awaitingBackground: issue.awaitingBackground,
    nudgeCount: nudgeRow?.nudgeCount ?? 0,
    lastNudgeAt: nudgeRow?.lastNudgeAt
      ? nudgeRow.lastNudgeAt.toISOString()
      : null,
    now: deps.now,
    stallThresholdMs: deps.config.stallThresholdMs,
  })

  if (action.kind === 'none') return

  const stalledMs =
    deps.now.getTime() - (issue.statusLineAt?.getTime() ?? deps.now.getTime())
  const holderHandle = await handleOf(db, holderId)
  const nextCount = (nudgeRow?.nudgeCount ?? 0) + 1

  if (action.kind === 'nudge') {
    // A baton holder with a session is a precondition of an agent baton on a
    // building issue; guard anyway so a race can't drive a null session.
    if (!holderSessionId) return
    deps.driveTurn(
      issue.id,
      holderSessionId,
      nudgePrompt(action.escalated, stalledMs),
    )
    await recordIntervention(db, issue.id, nextCount, deps.now)
    await emitWatchdog(db, {
      type: WATCHDOG_NUDGED,
      issueId: issue.id,
      actorId: holderId,
      headline:
        `the night watch ${action.escalated ? 'firmly nudged' : 'nudged'} ` +
        `@${holderHandle} on #${issue.nano}: this build looks stalled ` +
        `(${formatStallDuration(stalledMs)})`,
    })
    return
  }

  // Owner ping: hand the baton to the human owner (so the watch goes quiet —
  // a human holder is "waiting for input") and surface it to the owner's inbox.
  const fresh = await getIssue(db, issue.id)
  const ownerId = fresh?.ownerId ?? issue.ownerId
  await setBatonHolder(db, issue.id, ownerId)
  await recordIntervention(db, issue.id, nextCount, deps.now)
  const ownerHandle = await handleOf(db, ownerId)
  await emitWatchdog(db, {
    type: WATCHDOG_OWNER_PING,
    issueId: issue.id,
    actorId: holderId,
    headline:
      `the night watch escalated #${issue.nano} to @${ownerHandle}: stalled ` +
      `${formatStallDuration(stalledMs)} and ${String(nudgeRow?.nudgeCount ?? 0)} ` +
      `nudges to @${holderHandle} didn't move it — needs a human`,
    addRecipients: [ownerId],
  })
}

async function handleHealthCheck(
  db: Database,
  deps: WatchSweepDeps,
  ctx: {
    job: BackgroundJobRow
    issue: IssueRow
    agentUserId: string
    running: Set<string>
  },
): Promise<void> {
  const { job, issue } = ctx
  const checkRow = await getJobCheckRow(db, job.id)
  const intervalMs = jobCheckIntervalMs(job, deps.config.jobCheckIntervalMs)
  const due = decideHealthCheck({
    sessionRunning: ctx.running.has(job.sessionId),
    jobCreatedAt: job.createdAt.toISOString(),
    intervalMs,
    lastCheckedAt: checkRow?.lastCheckedAt
      ? checkRow.lastCheckedAt.toISOString()
      : null,
    now: deps.now,
  })
  if (!due) return

  const outstandingMs = deps.now.getTime() - job.createdAt.getTime()
  deps.driveTurn(
    issue.id,
    job.sessionId,
    healthCheckPrompt(job.label, outstandingMs),
  )
  await recordJobCheck(db, job.id, deps.now)
  const handle = await handleOf(db, ctx.agentUserId)
  await emitWatchdog(db, {
    type: WATCHDOG_HEALTH_CHECK,
    issueId: issue.id,
    actorId: ctx.agentUserId,
    headline:
      `the night watch checked in on @${handle}'s background wait ` +
      `"${job.label}" on #${issue.nano} (running ${formatStallDuration(outstandingMs)})`,
  })
}
