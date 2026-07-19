import { uuidv7 } from '@earendil-works/pi-agent-core'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { agentSessions, backgroundJobs } from '@hull/agent/schema'
import { recordBackgroundJob, setStatus } from '@hull/agent/service'
import { listEventsSince } from '@hull/events/service'
import { freshDb } from '@hull/db/test-db'
import { issues, issueSessions } from '@hull/issues/schema'
import { createIssue, getIssue, setBatonHolder } from '@hull/issues/service'
import { issueTopic } from '@hull/issues/topic'
import { createUser } from '@hull/users/service'

import {
  DEFAULT_JOB_CHECK_INTERVAL_MS,
  DEFAULT_STALL_THRESHOLD_MS,
  DEFAULT_SWEEP_MS,
  decideHealthCheck,
  decideStall,
  getJobCheckRow,
  getNudgeRow,
  healthCheckPrompt,
  jobCheckIntervalMs,
  listJobCheckRows,
  listNudgeRows,
  nudgePrompt,
  positiveIntOr,
  resolveWatchConfig,
  runWatchSweep,
  WATCH_SOURCE,
  WATCHDOG_HEALTH_CHECK,
  WATCHDOG_NUDGED,
  WATCHDOG_OWNER_PING,
  type WatchConfig,
  type WatchSweepDeps,
} from './service'
import type { BackgroundJobRow } from '@hull/agent/schema'

const CONFIG: WatchConfig = {
  sweepMs: DEFAULT_SWEEP_MS,
  stallThresholdMs: DEFAULT_STALL_THRESHOLD_MS,
  jobCheckIntervalMs: DEFAULT_JOB_CHECK_INTERVAL_MS,
}

const MIN = 60_000

// --- Config -----------------------------------------------------------------

describe('resolveWatchConfig', () => {
  it('defaults when env is empty', () => {
    expect(resolveWatchConfig({})).toEqual(CONFIG)
  })

  it('honours positive integer overrides', () => {
    expect(
      resolveWatchConfig({
        SKYLARK_WATCH_SWEEP_MS: '30000',
        SKYLARK_WATCH_STALL_MS: '600000',
        SKYLARK_WATCH_JOB_INTERVAL_MS: '120000',
      }),
    ).toEqual({
      sweepMs: 30_000,
      stallThresholdMs: 600_000,
      jobCheckIntervalMs: 120_000,
    })
  })

  it('falls back on garbage / non-positive values', () => {
    expect(positiveIntOr(undefined, 5)).toBe(5)
    expect(positiveIntOr('nope', 5)).toBe(5)
    expect(positiveIntOr('0', 5)).toBe(5)
    expect(positiveIntOr('-10', 5)).toBe(5)
    expect(positiveIntOr('7.9', 5)).toBe(7)
    expect(positiveIntOr('42', 5)).toBe(42)
  })
})

// --- decideStall (pure) -----------------------------------------------------

describe('decideStall', () => {
  const base = {
    batonIsAgent: true,
    hasOutstandingJob: false,
    sessionRunning: false,
    statusLine: 'working on it',
    statusLineAt: new Date(0).toISOString(),
    awaitingBackground: false,
    nudgeCount: 0,
    lastNudgeAt: null,
    now: new Date(20 * MIN),
    stallThresholdMs: DEFAULT_STALL_THRESHOLD_MS,
  }

  it('nudges gently a stalled agent build (first time)', () => {
    expect(decideStall(base)).toEqual({ kind: 'nudge', escalated: false })
  })

  it('escalates wording on the second nudge', () => {
    expect(decideStall({ ...base, nudgeCount: 1 })).toEqual({
      kind: 'nudge',
      escalated: true,
    })
  })

  it('pings the owner on the third intervention', () => {
    expect(decideStall({ ...base, nudgeCount: 2 })).toEqual({
      kind: 'ownerPing',
    })
    expect(decideStall({ ...base, nudgeCount: 5 })).toEqual({
      kind: 'ownerPing',
    })
  })

  it('never nudges when a human holds the baton (waiting for input)', () => {
    expect(decideStall({ ...base, batonIsAgent: false })).toEqual({
      kind: 'none',
    })
  })

  it('never nudges when a background job is outstanding (that is Rule 2)', () => {
    expect(decideStall({ ...base, hasOutstandingJob: true })).toEqual({
      kind: 'none',
    })
  })

  it('never nudges a running session', () => {
    expect(decideStall({ ...base, sessionRunning: true })).toEqual({
      kind: 'none',
    })
  })

  it('does not nudge before the stall threshold', () => {
    expect(decideStall({ ...base, now: new Date(5 * MIN) })).toEqual({
      kind: 'none',
    })
  })

  it('treats a fresh deliberate background wait as not stalled', () => {
    // awaitingBackground within STALL_AFTER_BACKGROUND_MS → activity is 'waiting'
    expect(
      decideStall({
        ...base,
        awaitingBackground: true,
        now: new Date(2 * MIN),
      }),
    ).toEqual({ kind: 'none' })
  })

  it('is conservative with no status line yet', () => {
    expect(decideStall({ ...base, statusLine: null })).toEqual({ kind: 'none' })
  })

  it('holds off re-nudging inside one threshold window', () => {
    // nudged 5 minutes ago, threshold 15m → too soon despite a stale line
    expect(
      decideStall({
        ...base,
        nudgeCount: 1,
        lastNudgeAt: new Date(15 * MIN).toISOString(),
        now: new Date(20 * MIN),
      }),
    ).toEqual({ kind: 'none' })
  })

  it('re-nudges once a full threshold window has passed since the last nudge', () => {
    expect(
      decideStall({
        ...base,
        nudgeCount: 1,
        lastNudgeAt: new Date(2 * MIN).toISOString(),
        now: new Date(20 * MIN),
      }),
    ).toEqual({ kind: 'nudge', escalated: true })
  })
})

// --- decideHealthCheck (pure) -----------------------------------------------

describe('decideHealthCheck', () => {
  const base = {
    sessionRunning: false,
    jobCreatedAt: new Date(0).toISOString(),
    intervalMs: 10 * MIN,
    lastCheckedAt: null,
    now: new Date(12 * MIN),
  }

  it('is due once outstanding past the interval and never checked', () => {
    expect(decideHealthCheck(base)).toBe(true)
  })

  it('is not due before the interval', () => {
    expect(decideHealthCheck({ ...base, now: new Date(5 * MIN) })).toBe(false)
  })

  it('is not due again within one interval of the last check', () => {
    expect(
      decideHealthCheck({
        ...base,
        lastCheckedAt: new Date(11 * MIN).toISOString(),
        now: new Date(12 * MIN),
      }),
    ).toBe(false)
  })

  it('is due again a full interval after the last check', () => {
    expect(
      decideHealthCheck({
        ...base,
        lastCheckedAt: new Date(1 * MIN).toISOString(),
        now: new Date(12 * MIN),
      }),
    ).toBe(true)
  })

  it('never injects into a running session', () => {
    expect(decideHealthCheck({ ...base, sessionRunning: true })).toBe(false)
  })
})

describe('jobCheckIntervalMs', () => {
  const job = (checkInIntervalMs: number | null): BackgroundJobRow =>
    ({ checkInIntervalMs }) as BackgroundJobRow

  it('uses the per-job override when positive', () => {
    expect(jobCheckIntervalMs(job(30 * MIN), 10 * MIN)).toBe(30 * MIN)
  })

  it('falls back to the default when absent or non-positive', () => {
    expect(jobCheckIntervalMs(job(null), 10 * MIN)).toBe(10 * MIN)
    expect(jobCheckIntervalMs(job(0), 10 * MIN)).toBe(10 * MIN)
  })
})

describe('prompts', () => {
  it('a gentle nudge invites continue-or-handoff, no land-it script', () => {
    const p = nudgePrompt(false, 20 * MIN)
    expect(p).toContain('night watch')
    expect(p).toContain('hand off the baton')
    expect(p.toLowerCase()).not.toContain('check, commit, push')
  })

  it('a firm nudge warns of owner escalation', () => {
    expect(nudgePrompt(true, 30 * MIN)).toContain('escalate to the issue owner')
  })

  it('a health check asks the agent to self-report and keep waiting', () => {
    const p = healthCheckPrompt('PR #12 CI', 15 * MIN)
    expect(p).toContain('PR #12 CI')
    expect(p).toContain('end your turn')
  })
})

// --- runWatchSweep (PGlite, injected clock + driveTurn) ---------------------

describe('runWatchSweep', () => {
  let db: Database
  let close: () => Promise<void>
  let ownerId: string
  let agentId: string

  const T0 = new Date('2026-07-19T00:00:00.000Z')
  const at = (ms: number): Date => new Date(T0.getTime() + ms)

  interface Drive {
    issueId: string
    sessionId: string
    text: string
  }

  function sweepDeps(now: Date): {
    deps: WatchSweepDeps
    drives: Drive[]
  } {
    const drives: Drive[] = []
    return {
      drives,
      deps: {
        now,
        config: CONFIG,
        driveTurn: (issueId, sessionId, text) => {
          drives.push({ issueId, sessionId, text })
        },
      },
    }
  }

  /** A building issue with an agent baton holder, its session, and a stale line. */
  async function buildingIssue(opts?: {
    statusLineAt?: Date
    running?: boolean
  }): Promise<{ issueId: string; sessionId: string }> {
    const issue = await createIssue(db, {
      title: 'ship it',
      body: '',
      authorId: ownerId,
      ownerId,
    })
    const sessionId = uuidv7()
    await db
      .insert(agentSessions)
      .values({ id: sessionId, model: 'test', agentUserId: agentId })
    await db
      .insert(issueSessions)
      .values({ issueId: issue.id, agentUserId: agentId, sessionId })
    await setBatonHolder(db, issue.id, agentId)
    await db
      .update(issues)
      .set({
        status: 'building',
        statusLine: 'working on it',
        statusLineAt: opts?.statusLineAt ?? T0,
      })
      .where(eq(issues.id, issue.id))
    if (opts?.running) await setStatus(db, sessionId, 'running')
    return { issueId: issue.id, sessionId }
  }

  /** Record a background job whose createdAt is pinned to T0 (the test clock). */
  async function addJob(
    sessionId: string,
    opts?: { label?: string; checkInIntervalMs?: number; createdAt?: Date },
  ): Promise<string> {
    const id = uuidv7()
    await recordBackgroundJob(db, {
      id,
      sessionId,
      command: 'gh pr checks',
      label: opts?.label ?? 'PR #12 CI',
      cwd: '/tmp',
      pid: 123,
      checkInIntervalMs: opts?.checkInIntervalMs ?? null,
    })
    await db
      .update(backgroundJobs)
      .set({ createdAt: opts?.createdAt ?? T0 })
      .where(eq(backgroundJobs.id, id))
    return id
  }

  async function watchdogEvents(issueId: string, type?: string) {
    const rows = await listEventsSince(db, {
      topicPatterns: [issueTopic(issueId)],
    })
    return rows.filter(
      (r) => r.source === WATCH_SOURCE && (!type || r.type === type),
    )
  }

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    const owner = await createUser(db, {
      id: uuidv7(),
      handle: 'dru',
      displayName: 'Dru',
      type: 'human',
    })
    ownerId = owner.id
    const agent = await createUser(db, {
      id: uuidv7(),
      handle: 'builder',
      displayName: 'Builder',
      type: 'agent',
    })
    agentId = agent.id
  })

  afterEach(async () => {
    await close()
  })

  it('nudges a stalled agent build and records it once', async () => {
    const { issueId, sessionId } = await buildingIssue()

    const { deps, drives } = sweepDeps(at(20 * MIN))
    await runWatchSweep(db, deps)

    expect(drives).toHaveLength(1)
    expect(drives[0].sessionId).toBe(sessionId)
    expect(drives[0].text).toContain('night watch')

    const row = await getNudgeRow(db, issueId)
    expect(row?.nudgeCount).toBe(1)

    const events = await watchdogEvents(issueId, WATCHDOG_NUDGED)
    expect(events).toHaveLength(1)
  })

  it('does not stack a second nudge inside the threshold window', async () => {
    const { issueId } = await buildingIssue()

    await runWatchSweep(db, sweepDeps(at(20 * MIN)).deps)
    // A minute later — well inside the 15m re-nudge floor.
    const second = sweepDeps(at(21 * MIN))
    await runWatchSweep(db, second.deps)

    expect(second.drives).toHaveLength(0)
    expect((await getNudgeRow(db, issueId))?.nudgeCount).toBe(1)
  })

  it('climbs the ladder: gentle → firm → owner ping, then goes quiet', async () => {
    const { issueId } = await buildingIssue()

    // 1st: gentle nudge.
    const s1 = sweepDeps(at(20 * MIN))
    await runWatchSweep(db, s1.deps)
    expect(s1.drives[0].text).not.toContain('escalate to the issue owner')

    // 2nd: a full window later, firm nudge.
    const s2 = sweepDeps(at(40 * MIN))
    await runWatchSweep(db, s2.deps)
    expect(s2.drives).toHaveLength(1)
    expect(s2.drives[0].text).toContain('escalate to the issue owner')

    // 3rd: owner ping — no turn driven, baton handed to the human owner.
    const s3 = sweepDeps(at(60 * MIN))
    await runWatchSweep(db, s3.deps)
    expect(s3.drives).toHaveLength(0)
    expect((await getNudgeRow(db, issueId))?.nudgeCount).toBe(3)
    expect((await getIssue(db, issueId))?.batonHolderId).toBe(ownerId)
    expect(await watchdogEvents(issueId, WATCHDOG_OWNER_PING)).toHaveLength(1)

    // 4th: baton now human → the watch is quiet.
    const s4 = sweepDeps(at(80 * MIN))
    await runWatchSweep(db, s4.deps)
    expect(s4.drives).toHaveLength(0)
    expect((await getNudgeRow(db, issueId))?.nudgeCount).toBe(3)
  })

  it('never nudges a build whose baton is held by a human', async () => {
    const { issueId } = await buildingIssue()
    await setBatonHolder(db, issueId, ownerId)

    const { deps, drives } = sweepDeps(at(20 * MIN))
    await runWatchSweep(db, deps)

    expect(drives).toHaveLength(0)
    expect(await getNudgeRow(db, issueId)).toBeUndefined()
  })

  it('never nudges a running session', async () => {
    await buildingIssue({ running: true })
    const { deps, drives } = sweepDeps(at(20 * MIN))
    await runWatchSweep(db, deps)
    expect(drives).toHaveLength(0)
  })

  it('health-checks a long background wait instead of nudging', async () => {
    const { issueId, sessionId } = await buildingIssue()
    await addJob(sessionId)

    const { deps, drives } = sweepDeps(at(20 * MIN))
    await runWatchSweep(db, deps)

    // The outstanding job suppresses the stall nudge; a health check fires.
    expect(drives).toHaveLength(1)
    expect(drives[0].text).toContain('PR #12 CI')
    expect(await getNudgeRow(db, issueId)).toBeUndefined()
    expect(await watchdogEvents(issueId, WATCHDOG_HEALTH_CHECK)).toHaveLength(1)
  })

  it('does not re-health-check within one interval', async () => {
    const { sessionId } = await buildingIssue()
    await addJob(sessionId)

    await runWatchSweep(db, sweepDeps(at(20 * MIN)).deps)
    const second = sweepDeps(at(22 * MIN)) // < 10m later
    await runWatchSweep(db, second.deps)
    expect(second.drives).toHaveLength(0)
  })

  it('respects a per-job check-in override', async () => {
    const { sessionId } = await buildingIssue()
    const jobId = await addJob(sessionId, {
      label: 'slow build',
      checkInIntervalMs: 30 * MIN,
    })

    // 20m in: under the 30m override → no check.
    const early = sweepDeps(at(20 * MIN))
    await runWatchSweep(db, early.deps)
    expect(early.drives).toHaveLength(0)
    expect(await getJobCheckRow(db, jobId)).toBeUndefined()

    // 40m in: past the override → checked.
    const late = sweepDeps(at(40 * MIN))
    await runWatchSweep(db, late.deps)
    expect(late.drives).toHaveLength(1)
    expect((await getJobCheckRow(db, jobId))?.checkCount).toBe(1)
  })

  it('records memory the CLI can list (nudges + health checks)', async () => {
    await buildingIssue() // will be nudged
    const other = await buildingIssue()
    await addJob(other.sessionId) // will be health-checked

    await runWatchSweep(db, sweepDeps(at(20 * MIN)).deps)

    expect(await listNudgeRows(db)).toHaveLength(1)
    expect(await listJobCheckRows(db)).toHaveLength(1)
  })

  it('isolates a throwing drive and still finishes the sweep', async () => {
    await buildingIssue() // Rule 1 → driveTurn throws
    const withJob = await buildingIssue()
    await addJob(withJob.sessionId) // Rule 2 → driveTurn throws

    const deps: WatchSweepDeps = {
      now: at(20 * MIN),
      config: CONFIG,
      driveTurn: () => {
        throw new Error('runtime unavailable')
      },
    }
    // Both a stall drive and a health-check drive throw; the sweep swallows
    // each and returns cleanly rather than tearing down.
    await expect(runWatchSweep(db, deps)).resolves.toBeUndefined()
  })

  it('ignores background jobs on non-issue (chat/bare) sessions', async () => {
    const sessionId = uuidv7()
    await db.insert(agentSessions).values({ id: sessionId, model: 'test' })
    await recordBackgroundJob(db, {
      id: uuidv7(),
      sessionId,
      command: 'x',
      label: 'bare job',
      cwd: '/tmp',
      pid: 1,
    })
    const { deps, drives } = sweepDeps(at(60 * MIN))
    await runWatchSweep(db, deps)
    expect(drives).toHaveLength(0)
  })
})
