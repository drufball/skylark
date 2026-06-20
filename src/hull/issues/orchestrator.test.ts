import { uuidv7, type AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'
import { seedAndWireProfiles, getProfileByName } from '@hull/agent/profiles'
import { createSession, getSession, listSessions } from '@hull/agent/service'

import {
  createOrchestrator,
  parseWorktreeInclude,
  statusLineFromEvent,
  type GitOps,
  type OrchestratorDeps,
} from './orchestrator'
import {
  addComment,
  createIssue,
  getIssue,
  ISSUE_STATUS_CHANGED,
  issueScope,
  setBuildContext,
  transitionIssue,
} from './service'

// --- Fakes for the injected boundaries -------------------------------------

/** Records every git/fs side-effect so a test can assert exactly what happened. */
class FakeGit implements GitOps {
  worktrees = new Set<string>()
  added: { path: string; branch: string }[] = []
  removed: string[] = []
  pulls = 0
  migrations = 0
  copied: { from: string; to: string; patterns: string[] }[] = []
  /** Pretend these worktree paths already exist on disk (idempotency tests). */
  existing = new Set<string>()
  /** What branchMerged returns — true by default (the happy merged case). */
  merged = true

  worktreeExists(path: string): Promise<boolean> {
    return Promise.resolve(this.existing.has(path) || this.worktrees.has(path))
  }
  addWorktree(path: string, branch: string): Promise<void> {
    this.worktrees.add(path)
    this.added.push({ path, branch })
    return Promise.resolve()
  }
  removeWorktree(path: string): Promise<void> {
    this.worktrees.delete(path)
    this.removed.push(path)
    return Promise.resolve()
  }
  copyWorktreeIncludes(
    from: string,
    to: string,
    patterns: string[],
  ): Promise<void> {
    this.copied.push({ from, to, patterns })
    return Promise.resolve()
  }
  pullMain(): Promise<void> {
    this.pulls++
    return Promise.resolve()
  }
  runMigrations(): Promise<void> {
    this.migrations++
    return Promise.resolve()
  }
  readWorktreeIncludes(): Promise<string[]> {
    return Promise.resolve(['.env'])
  }
  branchMerged(): Promise<boolean> {
    return Promise.resolve(this.merged)
  }
}

/** Records runtime calls. runTurn captures the seed prompt for assertions. */
class FakeRuntime {
  turns: { sessionId: string; text: string }[] = []
  cancelled: string[] = []
  disposed: string[] = []
  /** Optional hook to drive onEvent during a turn (status-line tests). */
  onTurn?: (
    sessionId: string,
    text: string,
    onEvent?: (e: AgentSessionEvent) => void,
  ) => void

  runTurn(
    sessionId: string,
    text: string,
    onEvent?: (e: AgentSessionEvent) => void,
  ): Promise<AgentMessage[]> {
    this.turns.push({ sessionId, text })
    this.onTurn?.(sessionId, text, onEvent)
    return Promise.resolve([])
  }
  cancel(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId)
    return Promise.resolve()
  }
  dispose(sessionId: string): void {
    this.disposed.push(sessionId)
  }
}

let db: Database
let close: () => Promise<void>
let authorId: string
let builderId: string

beforeEach(async () => {
  ;({ db, close } = await freshDb())
  await seedAndWireProfiles(db)
  const author = await createUser(db, {
    id: uuidv7(),
    handle: 'drufball',
    displayName: 'Dru',
    type: 'human',
  })
  authorId = author.id
  const builder = await createUser(db, {
    id: uuidv7(),
    handle: 'builder',
    displayName: 'Builder',
    type: 'agent',
  })
  builderId = builder.id
})

afterEach(async () => {
  await close()
})

function makeDeps(over: Partial<OrchestratorDeps> = {}): {
  deps: OrchestratorDeps
  git: FakeGit
  runtime: FakeRuntime
} {
  const git = new FakeGit()
  const runtime = new FakeRuntime()
  const deps: OrchestratorDeps = {
    db,
    git,
    runtime,
    builderUserId: builderId,
    worktreeRoot: '/wt',
    generateSlug: () => Promise.resolve('add-widget'),
    ...over,
  }
  return { deps, git, runtime }
}

describe('parseWorktreeInclude', () => {
  it('keeps real patterns and drops comments + blank lines', () => {
    const text = '# a comment\n\n.env\n  \nsecrets/*.key\n# trailing\n'
    expect(parseWorktreeInclude(text)).toEqual(['.env', 'secrets/*.key'])
  })

  it('is empty for an all-comment/blank file', () => {
    expect(parseWorktreeInclude('# nothing\n\n')).toEqual([])
  })
})

describe('statusLineFromEvent', () => {
  it('summarizes a tool execution', () => {
    expect(
      statusLineFromEvent({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command: 'npm run check' },
      } as unknown as AgentSessionEvent),
    ).toMatch(/bash/)
  })

  it('reports a turn boundary as thinking/working', () => {
    expect(
      statusLineFromEvent({ type: 'turn_end' } as AgentSessionEvent),
    ).toBeTruthy()
  })

  it('returns null for events that carry no progress worth showing', () => {
    expect(
      statusLineFromEvent({
        type: 'queue_update',
        steering: [],
        followUp: [],
      } as unknown as AgentSessionEvent),
    ).toBeNull()
  })

  it('truncates a very long tool line', () => {
    const line = statusLineFromEvent({
      type: 'tool_execution_start',
      toolName: 'bash',
      args: { command: 'x'.repeat(300) },
    } as unknown as AgentSessionEvent)
    expect(line).not.toBeNull()
    expect((line ?? '').length).toBeLessThanOrEqual(120)
    expect(line).toMatch(/…$/)
  })

  it('handles a tool event with no command arg', () => {
    expect(
      statusLineFromEvent({
        type: 'tool_execution_start',
        toolName: 'read',
        args: { path: 'x' },
      } as unknown as AgentSessionEvent),
    ).toMatch(/read/)
  })
})

describe('orchestrator → building (from open)', () => {
  it('generates a branch, creates a worktree, copies includes, and starts a builder session', async () => {
    const { deps, git, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, {
      title: 'Add a widget',
      authorId,
      nano: 'aa11',
    })

    await orch.onStatusChanged(issue.id, 'open', 'building')

    const after = defined(await getIssue(db, issue.id))
    expect(after.branchName).toBe('add-widget-aa11')
    expect(after.worktreePath).toBe('/wt/add-widget-aa11')
    expect(git.added).toEqual([
      { path: '/wt/add-widget-aa11', branch: 'add-widget-aa11' },
    ])
    expect(git.copied).toHaveLength(1)
    expect(after.sessionId).toBeTruthy()

    // The builder session boots with the builder profile, the worktree cwd, and
    // the builder agent identity.
    const session = defined(await getSession(db, defined(after.sessionId)))
    const builderProfile = defined(await getProfileByName(db, 'builder'))
    expect(session.profileId).toBe(builderProfile.id)
    expect(session.cwd).toBe('/wt/add-widget-aa11')
    expect(session.agentUserId).toBe(builderId)

    // A turn was seeded with a prompt that carries the issue + the CLI contract.
    expect(runtime.turns).toHaveLength(1)
    expect(runtime.turns[0].sessionId).toBe(defined(after.sessionId))
    expect(runtime.turns[0].text).toContain('Add a widget')
    expect(runtime.turns[0].text).toContain('npm run issue')
    // The issue CLI is prefixed with the builder's actor id so its comments and
    // transitions attribute to the builder, not the operator.
    expect(runtime.turns[0].text).toContain(`SKYLARK_ACTOR=${builderId}`)
  })

  it('is idempotent: a second → building reuses branch, worktree, and session', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'bb22' })

    await orch.onStatusChanged(issue.id, 'open', 'building')
    const first = defined(await getIssue(db, issue.id))
    const firstSession = first.sessionId

    // Mark the worktree as already-existing for the second pass.
    git.existing.add(defined(first.worktreePath))
    await orch.onStatusChanged(issue.id, 'open', 'building')
    const second = defined(await getIssue(db, issue.id))

    expect(second.sessionId).toBe(firstSession)
    expect(git.added).toHaveLength(1) // not added twice
    // Only one builder session total.
    const sessions = await listSessions(db)
    expect(sessions).toHaveLength(1)
  })

  it('folds existing comments into the build prompt (resume with context)', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'cm00' })
    await addComment(db, {
      issueId: issue.id,
      authorId,
      body: 'please also handle the empty case',
    })

    await orch.onStatusChanged(issue.id, 'open', 'building')

    expect(runtime.turns[0].text).toContain('please also handle the empty case')
    expect(runtime.turns[0].text).toContain('@drufball')
  })

  it('serializes concurrent → building events: one worktree, one session', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'cc99' })

    // Two events for the same issue land at once (e.g. reconcile racing a live
    // bus note). Without per-issue serialization both would miss the worktree
    // and create it (and a session) twice.
    await Promise.all([
      orch.onStatusChanged(issue.id, 'open', 'building'),
      orch.onStatusChanged(issue.id, 'open', 'building'),
    ])

    expect(git.added).toHaveLength(1)
    const sessions = await listSessions(db)
    expect(sessions).toHaveLength(1)
  })

  it('does not regenerate the slug once a branch exists (resume keeps the branch)', async () => {
    const generateSlug = vi.fn(() => Promise.resolve('first-slug'))
    const { deps } = makeDeps({ generateSlug })
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'cc33' })

    await orch.onStatusChanged(issue.id, 'open', 'building')
    await orch.onStatusChanged(issue.id, 'open', 'building')

    expect(generateSlug).toHaveBeenCalledTimes(1)
    const after = defined(await getIssue(db, issue.id))
    expect(after.branchName).toBe('first-slug-cc33')
  })
})

describe('orchestrator → open (agent paused)', () => {
  it('leaves the session and worktree intact', async () => {
    const { deps, git, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'dd44' })
    await orch.onStatusChanged(issue.id, 'open', 'building')

    await orch.onStatusChanged(issue.id, 'building', 'open')

    expect(git.removed).toEqual([])
    expect(runtime.disposed).toEqual([])
  })
})

describe('orchestrator → done (agent merged)', () => {
  it('pulls main, migrates, removes the worktree, and disposes the session', async () => {
    const { deps, git, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ee55' })
    await orch.onStatusChanged(issue.id, 'open', 'building')
    const built = defined(await getIssue(db, issue.id))

    await orch.onStatusChanged(issue.id, 'building', 'done')

    expect(git.pulls).toBe(1)
    expect(git.migrations).toBe(1)
    expect(git.removed).toEqual([defined(built.worktreePath)])
    expect(runtime.disposed).toContain(defined(built.sessionId))
  })

  it('leaves the worktree standing if the branch is not actually merged', async () => {
    const { deps, git, runtime } = makeDeps()
    git.merged = false
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'nm66' })
    await orch.onStatusChanged(issue.id, 'open', 'building')
    const built = defined(await getIssue(db, issue.id))

    await orch.onStatusChanged(issue.id, 'building', 'done')

    // No teardown — the PR isn't in main, so don't orphan it.
    expect(git.removed).toEqual([])
    expect(runtime.disposed).not.toContain(defined(built.sessionId))
  })

  it('treats an erroring merge check as not-merged and keeps the worktree', async () => {
    const { deps, git } = makeDeps()
    git.branchMerged = () => Promise.reject(new Error('git blew up'))
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'mg77' })
    await orch.onStatusChanged(issue.id, 'open', 'building')

    await orch.onStatusChanged(issue.id, 'building', 'done')

    expect(git.removed).toEqual([])
  })

  it('never crashes if the self-pull fails — logs and continues', async () => {
    const { deps, git, runtime } = makeDeps()
    git.pullMain = () => Promise.reject(new Error('diverged'))
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ff66' })
    await orch.onStatusChanged(issue.id, 'open', 'building')
    const built = defined(await getIssue(db, issue.id))

    // Must resolve, not throw — a failed self-update can't sink the server.
    await expect(
      orch.onStatusChanged(issue.id, 'building', 'done'),
    ).resolves.toBeUndefined()
    // Teardown still happened despite the pull failure.
    expect(git.removed).toEqual([defined(built.worktreePath)])
    expect(runtime.disposed).toContain(defined(built.sessionId))
  })
})

describe('orchestrator → closed (human)', () => {
  it('cancels the in-flight turn, disposes the session, removes the worktree', async () => {
    const { deps, git, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'gg77' })
    await orch.onStatusChanged(issue.id, 'open', 'building')
    const built = defined(await getIssue(db, issue.id))

    await orch.onStatusChanged(issue.id, 'building', 'closed')

    expect(runtime.cancelled).toContain(defined(built.sessionId))
    expect(runtime.disposed).toContain(defined(built.sessionId))
    expect(git.removed).toEqual([defined(built.worktreePath)])
  })

  it('closing an open issue with no build context is a no-op (nothing to tear down)', async () => {
    const { deps, git, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'hh88' })

    await expect(
      orch.onStatusChanged(issue.id, 'open', 'closed'),
    ).resolves.toBeUndefined()
    expect(git.removed).toEqual([])
    expect(runtime.cancelled).toEqual([])
  })
})

describe('orchestrator status line', () => {
  it('writes a status line from the builder session events during a turn', async () => {
    const { deps } = makeDeps()
    const runtime = deps.runtime as FakeRuntime
    runtime.onTurn = (_sessionId, _text, onEvent) => {
      onEvent?.({
        type: 'tool_execution_start',
        toolName: 'bash',
        args: { command: 'npm run check' },
      } as unknown as AgentSessionEvent)
    }
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ii99' })

    await orch.onStatusChanged(issue.id, 'open', 'building')

    const after = defined(await getIssue(db, issue.id))
    expect(after.statusLine).toMatch(/bash/)
  })
})

describe('orchestrator event subscription', () => {
  it('reacts to a status_changed event arriving on the ship-log bus', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'jj10' })

    // Simulate an event landing (as an agent's CLI transition in another
    // process would): the durable transition happened, the bus delivers the id.
    const moved = await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    expect(moved.status).toBe('building')

    // The orchestrator's bus handler reads the full event by id, sees the
    // transition, and drives the side-effects.
    await orch.handleBusNote({
      id: (await findStatusEventId(db, issue.id)).id,
      type: ISSUE_STATUS_CHANGED,
      scope: issueScope(issue.id),
    })

    expect(git.added).toHaveLength(1)
  })

  it('acts once per transition, ignoring the public-scope mirror', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, {
      title: 'Dedup',
      authorId,
      nano: 'dd01',
    })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })

    // One transition emits two notes — issue scope + public. Both reach the
    // handler; only the issue-scoped one may drive the build.
    const { listEventsSince } = await import('@hull/events/service')
    const issueEvents = await listEventsSince(db, {
      scopes: [issueScope(issue.id)],
    })
    const publicEvents = await listEventsSince(db, { scopes: ['public'] })
    const issueNote = defined(
      issueEvents.find((e) => e.type === ISSUE_STATUS_CHANGED),
    )
    const publicNote = defined(
      publicEvents.find((e) => e.type === ISSUE_STATUS_CHANGED),
    )

    await orch.handleBusNote({
      id: issueNote.id,
      type: ISSUE_STATUS_CHANGED,
      scope: issueScope(issue.id),
    })
    await orch.handleBusNote({
      id: publicNote.id,
      type: ISSUE_STATUS_CHANGED,
      scope: 'public',
    })

    // Acted exactly once — the public mirror was ignored.
    expect(git.added).toHaveLength(1)
  })

  it('ignores notes that are not status changes', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    await orch.handleBusNote({
      id: 'x',
      type: 'issue.commented',
      scope: 'public',
    })
    expect(git.added).toEqual([])
  })

  it('drops a note whose event is gone', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    await orch.handleBusNote({
      id: 'no-such-event',
      type: ISSUE_STATUS_CHANGED,
      scope: 'public',
    })
    expect(git.added).toEqual([])
  })

  it('drops a status-change event with a malformed payload', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    const { emitEvent } = await import('@hull/events/bus')
    const row = await emitEvent(db, {
      type: ISSUE_STATUS_CHANGED,
      source: 'issues',
      scope: 'public',
      payload: { issueId: 42, from: 'nope', to: 'nope' },
    })
    await orch.handleBusNote({
      id: row.id,
      type: ISSUE_STATUS_CHANGED,
      scope: 'public',
    })
    expect(git.added).toEqual([])
  })
})

describe('orchestrator → done with no build context', () => {
  it('tears down nothing and never calls the merge check', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'nd00' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    // Straight to done with no branch/worktree recorded — the no-branchName arm
    // treats it as "nothing to protect" and teardown is a no-op.
    await expect(
      orch.onStatusChanged(issue.id, 'building', 'done'),
    ).resolves.toBeUndefined()
    expect(git.removed).toEqual([])
  })
})

describe('orchestrator failure handling', () => {
  it('a failing builder turn is logged, never thrown out of the handler', async () => {
    const { deps } = makeDeps()
    const runtime = deps.runtime as FakeRuntime
    runtime.runTurn = () => Promise.reject(new Error('boom'))
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'er01' })
    // onStatusChanged fires the turn in the background and must still resolve.
    await expect(
      orch.onStatusChanged(issue.id, 'open', 'building'),
    ).resolves.toBeUndefined()
  })

  it('a reconcile that fails on one issue continues past it', async () => {
    const { deps } = makeDeps({
      // ensureBuild calls generateSlug for a fresh branch; make it throw.
      generateSlug: () => Promise.reject(new Error('no slug')),
    })
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'er02' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    // reconcile swallows the per-issue failure rather than rejecting.
    await expect(orch.reconcile()).resolves.toBeUndefined()
  })
})

describe('orchestrator startup reconciliation', () => {
  it('resumes issues stuck in building with no live session in this process', async () => {
    const { deps, runtime } = makeDeps()
    // An issue marooned in "building" by a server restart: status building,
    // has a session row, but the runtime registry is empty (fresh process).
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'kk11' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    const sessionId = uuidv7()
    await createSession(db, {
      id: sessionId,
      model: 'claude-sonnet-4-5',
      title: issue.title,
      cwd: '/wt/x-kk11',
      agentUserId: builderId,
    })
    await setBuildContext(db, issue.id, {
      branchName: 'x-kk11',
      worktreePath: '/wt/x-kk11',
      sessionId,
    })

    const orch = createOrchestrator(deps)
    await orch.reconcile()

    // It resumes by running a turn on the existing session.
    expect(runtime.turns).toHaveLength(1)
  })
})

// Helper: find the status_changed event id for an issue on the public scope.
async function findStatusEventId(
  database: Database,
  issueId: string,
): Promise<{ id: string }> {
  const { listEventsSince } = await import('@hull/events/service')
  const events = await listEventsSince(database, { scopes: ['public'] })
  const match = events.find(
    (e) =>
      e.type === ISSUE_STATUS_CHANGED &&
      (e.payload as { issueId: string }).issueId === issueId,
  )
  return { id: defined(match).id }
}
