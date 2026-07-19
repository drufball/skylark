import { uuidv7 } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'
import { listEventsSince } from '@hull/events/service'
import { createUser, getUserByHandle, seedCrew } from '@hull/users/service'
import { seedAgentConfig } from '@hull/agent/agent-config'
import { DEFAULT_MODEL, type TurnResult } from '@hull/agent/runtime'
import {
  createSession,
  getSession,
  listSessions,
  setStatus,
} from '@hull/agent/service'

import {
  branchNameFor,
  createOrchestrator,
  parseWorktreeInclude,
  SLUG_FALLBACK,
  slugFromCompletion,
  slugify,
  type GitOps,
  type Orchestrator,
  type OrchestratorDeps,
} from './orchestrator'
import { buildPrompt, generalPrompt } from './prompts'
import type { IssueStatus } from './schema'
import { getPlaybookByName, seedPlaybooks, upsertPlaybook } from './playbooks'
import {
  addComment,
  createIssue,
  getIssue,
  getIssueSession,
  ISSUE_STATUS_CHANGED,
  issueTopic,
  listComments,
  listIssueSessions,
  setBuildContext,
  claimIssueSession,
  transitionIssue,
} from './service'
import { ISSUE_HANDOFF, ISSUE_OWNER_PING, requestHandoff } from './handoff'

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
  jobSweeps = 0
  /** Every runtime call in arrival order — for reconcile ordering assertions. */
  order: string[] = []
  /** Optional hook to drive onEvent during a turn (status-line tests). */
  onTurn?: (
    sessionId: string,
    text: string,
    onEvent?: (e: AgentSessionEvent) => void,
  ) => void
  /** Optional override for what the job sweep does (failure tests). */
  onJobSweep?: () => Promise<void>

  runTurn(
    sessionId: string,
    text: string,
    onEvent?: (e: AgentSessionEvent) => void,
  ): Promise<TurnResult> {
    this.turns.push({ sessionId, text })
    this.order.push(`turn:${sessionId}`)
    this.onTurn?.(sessionId, text, onEvent)
    return Promise.resolve({ queued: false, messages: [] })
  }
  cancel(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId)
    this.order.push(`cancel:${sessionId}`)
    return Promise.resolve()
  }
  dispose(sessionId: string): void {
    this.disposed.push(sessionId)
  }
  reconcileJobs(): Promise<void> {
    this.jobSweeps++
    this.order.push('jobs')
    return this.onJobSweep?.() ?? Promise.resolve()
  }
}

let db: Database
let close: () => Promise<void>
let authorId: string
let builderId: string

beforeEach(async () => {
  ;({ db, close } = await freshDb())
  // seedAgentConfig creates the builder/hand/babysitter role users itself
  // (if missing) and configures them — no separate createUser for 'builder'.
  await seedAgentConfig(db)
  const author = await createUser(db, {
    id: uuidv7(),
    handle: 'drufball',
    displayName: 'Dru',
    type: 'human',
  })
  authorId = author.id
  builderId = defined(await getUserByHandle(db, 'builder')).id
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

/** The builder's session id on an issue (via the issue_sessions link). */
async function builderSessionId(issueId: string): Promise<string> {
  return defined(await getIssueSession(db, issueId, builderId)).sessionId
}

/**
 * Move the issue through the service (the durable write + emit every real door
 * makes), then hand the transition to the orchestrator — the order production
 * events arrive in, and what the act-on-durable-state guard expects.
 */
async function drive(
  orch: Orchestrator,
  issueId: string,
  to: IssueStatus,
): Promise<void> {
  await transitionIssue(db, { issueId, to, actorId: authorId })
  await orch.onStatusChanged(issueId, to)
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

describe('slugify', () => {
  it('lowercases and joins non-alnum runs into single hyphens', () => {
    expect(slugify('Fix the   Bug!! Now')).toBe('fix-the-bug-now')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('!!Hello, World!!')).toBe('hello-world')
  })

  it('caps at max and strips a hyphen left dangling by the cut', () => {
    // 'abcdefghij-klmnopqrst-...' sliced at 11 lands on the separator;
    // the trailing-hyphen pass must remove it.
    expect(slugify('abcdefghij klmnopqrst uvwxyz', 11)).toBe('abcdefghij')
    expect(slugify('a'.repeat(60)).length).toBeLessThanOrEqual(40)
  })

  it('falls back to "build" when the input reduces to nothing', () => {
    expect(slugify('!!!')).toBe('build')
    expect(slugify('')).toBe('build')
  })
})

describe('slugFromCompletion', () => {
  const title = 'Fix the login bug'

  it('slugifies the text blocks of a completion (happy path)', async () => {
    const slug = await slugFromCompletion(title, () =>
      Promise.resolve([{ type: 'text', text: 'Login Session Fix' }]),
    )
    expect(slug).toBe('login-session-fix')
  })

  it('joins multiple text blocks and skips non-text blocks', async () => {
    const slug = await slugFromCompletion(title, () =>
      Promise.resolve([
        { type: 'thinking', text: 'hmm let me think' },
        { type: 'text', text: 'login' },
        { type: 'tool_call' },
        { type: 'text' }, // a text block with no text must not become "undefined"
        { type: 'text', text: 'fix' },
      ]),
    )
    expect(slug).toBe('login-fix')
  })

  it('flattens a fenced/multiline completion into one slug', async () => {
    const slug = await slugFromCompletion(title, () =>
      Promise.resolve([{ type: 'text', text: '```\nlogin-fix\n```' }]),
    )
    expect(slug).toBe('login-fix')
  })

  it(`rejects the "${SLUG_FALLBACK}" sentinel and slugifies the title instead`, async () => {
    // slugify('') === SLUG_FALLBACK — an empty/garbage completion is
    // indistinguishable from a model that literally answered "build", and
    // neither should name the branch.
    const slug = await slugFromCompletion(title, () =>
      Promise.resolve([{ type: 'text', text: SLUG_FALLBACK }]),
    )
    expect(slug).toBe('fix-the-login-bug')
    const empty = await slugFromCompletion(title, () =>
      Promise.resolve([{ type: 'text', text: '!!!' }]),
    )
    expect(empty).toBe('fix-the-login-bug')
  })

  it('falls back to the title when the completion throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const slug = await slugFromCompletion(title, () =>
        Promise.reject(new Error('model offline')),
      )
      expect(slug).toBe('fix-the-login-bug')
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('model offline'),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('falls back to the title when no completion is available', async () => {
    expect(await slugFromCompletion(title, undefined)).toBe('fix-the-login-bug')
  })
})

describe('branchNameFor', () => {
  it('joins a slugified title with the issue nano', () => {
    expect(branchNameFor('My Cool Feature', 'ab12')).toBe(
      'my-cool-feature-ab12',
    )
  })
})

describe('buildPrompt', () => {
  it('includes the title, body, thread, and the baton to the babysitter', async () => {
    const issue = await createIssue(db, {
      title: 'Make it fast',
      body: 'The board feels sluggish.',
      authorId,
      nano: 'pp01',
    })
    const prompt = buildPrompt(
      issue,
      [
        { authorHandle: 'dru', body: 'start with the query' },
        { authorHandle: 'bix', body: 'mind the empty case' },
      ],
      'builder-1',
      'babysitter',
    )
    expect(prompt).toContain('#pp01')
    expect(prompt).toContain('Title: Make it fast')
    expect(prompt).toContain('The board feels sluggish.')
    expect(prompt).toContain('Thread so far:')
    // Each comment on its own line — pins the '\n' join between them.
    expect(prompt).toContain(
      '- @dru: start with the query\n- @bix: mind the empty case',
    )
    // The builder's part ends at an open PR: it hands the baton to the
    // babysitter and never shepherds or merges itself.
    expect(prompt).toContain(
      'SKYLARK_ACTOR=builder-1 npm run issue -- handoff pp01 babysitter',
    )
    expect(prompt).not.toContain('merge once green')
    expect(prompt).not.toMatch(/npm run issue -- done/)
  })

  it('omits the "Thread so far" block when there are no comments', async () => {
    const issue = await createIssue(db, {
      title: 'No discussion yet',
      body: 'body text',
      authorId,
      nano: 'pp02',
    })
    const prompt = buildPrompt(issue, [], 'builder-1', 'babysitter')
    expect(prompt).not.toContain('Thread so far')
  })

  it('omits the body block (and never prints null) when the issue has no body', async () => {
    const issue = await createIssue(db, {
      title: 'Just a title',
      authorId,
      nano: 'pp03',
    })
    const prompt = buildPrompt(issue, [], 'builder-1', 'babysitter')
    expect(prompt).toContain('Title: Just a title')
    expect(prompt).not.toContain('null')
    expect(prompt).not.toContain('undefined')
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

    await drive(orch, issue.id, 'building')

    const after = defined(await getIssue(db, issue.id))
    expect(after.branchName).toBe('add-widget-aa11')
    expect(after.worktreePath).toBe('/wt/add-widget-aa11')
    expect(git.added).toEqual([
      { path: '/wt/add-widget-aa11', branch: 'add-widget-aa11' },
    ])
    expect(git.copied).toHaveLength(1)

    // The builder's hand on the issue is recorded in issue_sessions, and the
    // session boots as the worktree cwd + the builder agent identity (its
    // config rides on that user row).
    const link = defined(await getIssueSession(db, issue.id, builderId))
    const session = defined(await getSession(db, link.sessionId))
    expect(session.cwd).toBe('/wt/add-widget-aa11')
    expect(session.agentUserId).toBe(builderId)
    expect(session.model).toBe(DEFAULT_MODEL)

    // A turn was seeded with a prompt that carries the issue + the CLI contract.
    expect(runtime.turns).toHaveLength(1)
    expect(runtime.turns[0].sessionId).toBe(link.sessionId)
    expect(runtime.turns[0].text).toContain('Add a widget')
    expect(runtime.turns[0].text).toContain('npm run issue')
    // The issue CLI is prefixed with the builder's actor id so its comments and
    // transitions attribute to the builder, not the operator.
    expect(runtime.turns[0].text).toContain(`SKYLARK_ACTOR=${builderId}`)
  })

  it('hands the baton to the entrypoint agent on → building', async () => {
    const { deps } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'Baton', authorId })

    await drive(orch, issue.id, 'building')

    // With no playbook seeded the entrypoint is the legacy builder — the hand
    // this transition seeds a turn for, and so the baton holder.
    expect(defined(await getIssue(db, issue.id)).batonHolderId).toBe(builderId)
  })

  it('is idempotent: a second → building reuses branch, worktree, and session', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'bb22' })

    await drive(orch, issue.id, 'building')
    const first = defined(await getIssue(db, issue.id))
    const firstSession = defined(
      await getIssueSession(db, issue.id, builderId),
    ).sessionId

    // Mark the worktree as already-existing for the second pass (a duplicate
    // event; the issue is still durably building).
    git.existing.add(defined(first.worktreePath))
    await orch.onStatusChanged(issue.id, 'building')

    expect(
      defined(await getIssueSession(db, issue.id, builderId)).sessionId,
    ).toBe(firstSession)
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

    await drive(orch, issue.id, 'building')

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
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await Promise.all([
      orch.onStatusChanged(issue.id, 'building'),
      orch.onStatusChanged(issue.id, 'building'),
    ])

    expect(git.added).toHaveLength(1)
    const sessions = await listSessions(db)
    expect(sessions).toHaveLength(1)
  })

  it('two orchestrators racing the same → building converge on ONE session (cross-process race)', async () => {
    // The real incident shape (#f5io): two processes (a reload window, a
    // reconcile racing a live event in another process) both handle → building
    // for the same issue. The in-process per-issue chain can't serialize across
    // processes — two separate orchestrator instances on one database model it.
    // Without database arbitration both miss the link check, both create a
    // session, and the loser's orphan twin gets fired a turn in the SAME
    // worktree.
    const a = makeDeps()
    const b = makeDeps()
    const orchA = createOrchestrator(a.deps)
    const orchB = createOrchestrator(b.deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'rc01' })

    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await Promise.all([
      orchA.onStatusChanged(issue.id, 'building'),
      orchB.onStatusChanged(issue.id, 'building'),
    ])

    // Exactly one live session per (issue, agent) — enforced by the database,
    // not by in-process discipline. The loser's session row must not survive.
    const sessions = await listSessions(db)
    expect(sessions).toHaveLength(1)

    // Every fired turn landed on the ONE linked session — never on an orphan.
    const linked = await builderSessionId(issue.id)
    expect(linked).toBe(sessions[0].id)
    const fired = [...a.runtime.turns, ...b.runtime.turns].map(
      (t) => t.sessionId,
    )
    expect(fired.length).toBeGreaterThan(0)
    for (const id of fired) expect(id).toBe(linked)
  })

  it('does not regenerate the slug once a branch exists (resume keeps the branch)', async () => {
    const generateSlug = vi.fn(() => Promise.resolve('first-slug'))
    const { deps } = makeDeps({ generateSlug })
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'cc33' })

    await drive(orch, issue.id, 'building')
    await orch.onStatusChanged(issue.id, 'building')

    expect(generateSlug).toHaveBeenCalledTimes(1)
    const after = defined(await getIssue(db, issue.id))
    expect(after.branchName).toBe('first-slug-cc33')
  })

  it('uses resolved babysitter handle from playbook, not hardcoded fallback', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    // Create a custom babysitter with a non-default handle
    const customBuilder = await createUser(db, {
      id: uuidv7(),
      handle: 'coder',
      displayName: 'Coder',
      type: 'agent',
    })
    const prShepherd = await createUser(db, {
      id: uuidv7(),
      handle: 'pr-shepherd',
      displayName: 'PR Shepherd',
      type: 'agent',
    })
    // Create a custom build playbook with the non-default babysitter
    await seedPlaybooks(db)
    const { upsertPlaybook } = await import('./playbooks')
    const customPlaybook = await upsertPlaybook(db, {
      name: 'build',
      description: 'Custom build playbook',
      memberIds: [customBuilder.id, prShepherd.id],
      entrypointId: customBuilder.id,
    })
    const issue = await createIssue(db, {
      title: 'Test custom PR shepherd',
      authorId,
      nano: 'cs99',
      playbookId: customPlaybook.id,
    })

    await drive(orch, issue.id, 'building')

    // The prompt should include the custom babysitter handle, not 'babysitter'
    expect(runtime.turns).toHaveLength(1)
    expect(runtime.turns[0].text).toContain('handoff cs99 pr-shepherd')
    expect(runtime.turns[0].text).toContain("pr-shepherd's job, not yours")
    expect(runtime.turns[0].text).not.toContain('babysitter')
  })
})

describe('orchestrator → open (agent paused)', () => {
  it('leaves the session and worktree intact', async () => {
    const { deps, git, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'dd44' })
    await drive(orch, issue.id, 'building')

    await drive(orch, issue.id, 'open')

    expect(git.removed).toEqual([])
    expect(runtime.disposed).toEqual([])
  })
})

describe('orchestrator → done (agent merged)', () => {
  it('pulls main, migrates, removes the worktree, and disposes the session', async () => {
    const { deps, git, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ee55' })
    await drive(orch, issue.id, 'building')
    const built = defined(await getIssue(db, issue.id))

    await drive(orch, issue.id, 'done')

    expect(git.pulls).toBe(1)
    expect(git.migrations).toBe(1)
    expect(git.removed).toEqual([defined(built.worktreePath)])
    expect(runtime.disposed).toContain(await builderSessionId(issue.id))
    // The baton the → building set is cleared on the terminal move.
    expect(built.batonHolderId).toBe(builderId)
    expect(defined(await getIssue(db, issue.id)).batonHolderId).toBeNull()
  })

  it('leaves the worktree standing if the branch is not actually merged', async () => {
    const { deps, git, runtime } = makeDeps()
    git.merged = false
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'nm66' })
    await drive(orch, issue.id, 'building')

    await drive(orch, issue.id, 'done')

    // No teardown — the PR isn't in main, so don't orphan it.
    expect(git.removed).toEqual([])
    expect(runtime.disposed).not.toContain(await builderSessionId(issue.id))
  })

  it('treats an erroring merge check as not-merged and keeps the worktree', async () => {
    const { deps, git } = makeDeps()
    git.branchMerged = () => Promise.reject(new Error('git blew up'))
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'mg77' })
    await drive(orch, issue.id, 'building')

    await drive(orch, issue.id, 'done')

    expect(git.removed).toEqual([])
  })

  it('never crashes if the self-pull fails — logs and continues', async () => {
    const { deps, git, runtime } = makeDeps()
    git.pullMain = () => Promise.reject(new Error('diverged'))
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ff66' })
    await drive(orch, issue.id, 'building')
    const built = defined(await getIssue(db, issue.id))

    // Must resolve, not throw — a failed self-update can't sink the server.
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'done',
      actorId: authorId,
    })
    await expect(
      orch.onStatusChanged(issue.id, 'done'),
    ).resolves.toBeUndefined()
    // Teardown still happened despite the pull failure.
    expect(git.removed).toEqual([defined(built.worktreePath)])
    expect(runtime.disposed).toContain(await builderSessionId(issue.id))
  })
})

describe('orchestrator → closed (human)', () => {
  it('cancels the in-flight turn, disposes the session, removes the worktree', async () => {
    const { deps, git, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'gg77' })
    await drive(orch, issue.id, 'building')
    const built = defined(await getIssue(db, issue.id))
    const sessionId = await builderSessionId(issue.id)

    await drive(orch, issue.id, 'closed')

    expect(runtime.cancelled).toContain(sessionId)
    expect(runtime.disposed).toContain(sessionId)
    expect(git.removed).toEqual([defined(built.worktreePath)])
  })

  it('closing an open issue with no build context is a no-op (nothing to tear down)', async () => {
    const { deps, git, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'hh88' })

    await transitionIssue(db, {
      issueId: issue.id,
      to: 'closed',
      actorId: authorId,
    })
    await expect(
      orch.onStatusChanged(issue.id, 'closed'),
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

    await drive(orch, issue.id, 'building')

    const after = defined(await getIssue(db, issue.id))
    expect(after.statusLine).toMatch(/bash/)
    expect(after.statusLineAt).not.toBeNull()
    expect(after.awaitingBackground).toBe(false)
  })

  it('marks the status line as awaiting a background job when the agent calls `background`', async () => {
    const { deps } = makeDeps()
    const runtime = deps.runtime as FakeRuntime
    runtime.onTurn = (_sessionId, _text, onEvent) => {
      onEvent?.({
        type: 'tool_execution_start',
        toolName: 'background',
        args: { command: 'gh pr checks --watch', label: 'PR #12 CI' },
      } as unknown as AgentSessionEvent)
    }
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ii98' })

    await drive(orch, issue.id, 'building')

    const after = defined(await getIssue(db, issue.id))
    expect(after.statusLine).toMatch(/PR #12 CI/)
    expect(after.awaitingBackground).toBe(true)
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
      topic: issueTopic(issue.id),
    })

    expect(git.added).toHaveLength(1)
  })

  it('acts exactly once per transition (single-emit with topic+audience)', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, {
      title: 'SingleEmit',
      authorId,
      nano: 'se01',
    })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })

    // One transition emits ONE event with topic="issue:<id>" and audience="public".
    // The dedup workaround is retired; the event arrives exactly once.
    const events = await listEventsSince(db, {
      topicPatterns: [`issue:${issue.id}`],
      audience: 'public',
    })
    const statusEvent = defined(
      events.find((e) => e.type === ISSUE_STATUS_CHANGED),
    )

    await orch.handleBusNote({
      id: statusEvent.id,
      type: ISSUE_STATUS_CHANGED,
      topic: `issue:${issue.id}`,
      audience: 'public',
    })

    // Acted exactly once — no duplicate events to filter.
    expect(git.added).toHaveLength(1)
  })

  it('ignores notes that are not status changes', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    await orch.handleBusNote({
      id: 'x',
      type: 'issue.commented',
      topic: 'issue:x',
    })
    expect(git.added).toEqual([])
  })

  it('drops a note whose event is gone', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    await orch.handleBusNote({
      id: 'no-such-event',
      type: ISSUE_STATUS_CHANGED,
      topic: 'issue:no-such-event',
    })
    expect(git.added).toEqual([])
  })

  it('does nothing for a stale → building event on a since-done issue', async () => {
    const { deps, git, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'st01' })
    // The transition emitted a → building event, but the issue moved on to
    // done before the note was handled (or the event is a replay).
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'done',
      actorId: authorId,
    })

    // findStatusEventId returns the OLDEST status event — the → building one.
    await orch.handleBusNote({
      id: (await findStatusEventId(db, issue.id)).id,
      type: ISSUE_STATUS_CHANGED,
      topic: issueTopic(issue.id),
    })

    // Durable state says done — no worktree resurrected, no turn fired.
    expect(git.added).toEqual([])
    expect(runtime.turns).toEqual([])
  })

  /** An issue durably in `building`, so a skipped guard would visibly act. */
  async function buildingIssue(nano: string) {
    const issue = await createIssue(db, { title: 'X', authorId, nano })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    return issue
  }

  it('ignores a status_changed event from another source, even with the right topic', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await buildingIssue('sc01')
    const { emitEvent } = await import('@hull/events/bus')
    const row = await emitEvent(db, {
      type: ISSUE_STATUS_CHANGED,
      source: 'chat', // ONLY the source is wrong
      topic: issueTopic(issue.id),
      audience: 'public',
      payload: { issueId: issue.id, from: 'open', to: 'building' },
    })
    await orch.handleBusNote({
      id: row.id,
      type: ISSUE_STATUS_CHANGED,
      topic: issueTopic(issue.id),
    })
    expect(git.added).toEqual([])
  })

  it('ignores a status_changed event whose topic names a different issue', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await buildingIssue('sc02')
    const { emitEvent } = await import('@hull/events/bus')
    const row = await emitEvent(db, {
      type: ISSUE_STATUS_CHANGED,
      source: 'issues',
      topic: 'issue:somewhere-else', // ONLY the topic is wrong
      audience: 'public',
      payload: { issueId: issue.id, from: 'open', to: 'building' },
    })
    await orch.handleBusNote({
      id: row.id,
      type: ISSUE_STATUS_CHANGED,
      topic: 'issue:somewhere-else',
    })
    expect(git.added).toEqual([])
  })

  it('drops a status_changed payload with one bad field at a time', async () => {
    const { deps, git, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await buildingIssue('sc03')
    const { emitEvent } = await import('@hull/events/bus')
    const good = { issueId: issue.id, from: 'open', to: 'building' }
    // Each variant violates exactly ONE payload guard (the envelope stays
    // consistent with the variant), so no guard can hide behind another.
    const variants: { payload: unknown; topic: string }[] = [
      { payload: { ...good, issueId: 42 }, topic: 'issue:42' },
      { payload: { ...good, from: 'nope' }, topic: issueTopic(issue.id) },
      { payload: { ...good, to: 'nope' }, topic: issueTopic(issue.id) },
    ]
    for (const { payload, topic } of variants) {
      const row = await emitEvent(db, {
        type: ISSUE_STATUS_CHANGED,
        source: 'issues',
        topic,
        audience: 'public',
        payload,
      })
      await orch.handleBusNote({
        id: row.id,
        type: ISSUE_STATUS_CHANGED,
        topic,
      })
    }
    expect(git.added).toEqual([])
    expect(runtime.turns).toEqual([])
  })

  it('drops a status-change event with a malformed payload', async () => {
    const { deps, git } = makeDeps()
    const orch = createOrchestrator(deps)
    const { emitEvent } = await import('@hull/events/bus')
    const row = await emitEvent(db, {
      type: ISSUE_STATUS_CHANGED,
      source: 'issues',
      topic: 'issue:42',
      audience: 'public',
      payload: { issueId: 42, from: 'nope', to: 'nope' },
    })
    await orch.handleBusNote({
      id: row.id,
      type: ISSUE_STATUS_CHANGED,
      topic: 'issue:42',
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
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'done',
      actorId: authorId,
    })
    await expect(
      orch.onStatusChanged(issue.id, 'done'),
    ).resolves.toBeUndefined()
    expect(git.removed).toEqual([])
  })
})

describe('orchestrator failure handling', () => {
  it('a failing builder turn is logged, never thrown out of the handler', async () => {
    const { deps } = makeDeps()
    const runtime = deps.runtime as FakeRuntime
    runtime.runTurn = () => Promise.reject(new Error('boom'))
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    try {
      const orch = createOrchestrator(deps)
      const issue = await createIssue(db, {
        title: 'X',
        authorId,
        nano: 'er01',
      })
      // onStatusChanged fires the turn in the background and must still resolve.
      await transitionIssue(db, {
        issueId: issue.id,
        to: 'building',
        actorId: authorId,
      })
      await expect(
        orch.onStatusChanged(issue.id, 'building'),
      ).resolves.toBeUndefined()
      // The fire-and-forget turn's rejection is caught and logged — pin the
      // catch, or a dropped `.catch` would only surface as an unhandled
      // rejection blamed elsewhere.
      await vi.waitFor(() => {
        expect(errSpy).toHaveBeenCalledWith(
          expect.stringContaining('failed: boom'),
        )
      })
    } finally {
      errSpy.mockRestore()
    }
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
    })
    await claimIssueSession(db, {
      issueId: issue.id,
      agentUserId: builderId,
      sessionId,
    })

    const orch = createOrchestrator(deps)
    await orch.reconcile()

    // It resumes by running a turn on the existing session.
    expect(runtime.turns).toHaveLength(1)
  })

  it('resume re-seeds a building issue directly (what reconcile calls per issue)', async () => {
    const { deps, git, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'rs01' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })

    await orch.resume(issue.id)

    expect(git.added).toHaveLength(1)
    expect(runtime.turns).toHaveLength(1)
  })

  it('cancels sessions stranded on running — a crashed turn must not jam the baton', async () => {
    const { deps, runtime } = makeDeps()
    // A reviewer agent was mid-turn when the process died: its session row is
    // stuck on 'running', and runningHands would refuse every future handoff
    // on this issue ("wait for their turn to end" — it never will).
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'kk12' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    const reviewer = await createUser(db, {
      id: uuidv7(),
      handle: 'reviewer',
      displayName: 'Reviewer',
      type: 'agent',
    })
    const stranded = uuidv7()
    await createSession(db, {
      id: stranded,
      model: 'claude-sonnet-4-5',
      cwd: '/wt/x-kk12',
      agentUserId: reviewer.id,
    })
    await claimIssueSession(db, {
      issueId: issue.id,
      agentUserId: reviewer.id,
      sessionId: stranded,
    })
    await setStatus(db, stranded, 'running')

    const orch = createOrchestrator(deps)
    await orch.reconcile()

    expect(runtime.cancelled).toContain(stranded)
  })

  it('cancels orphan worktree sessions no link points at, and never resumes them', async () => {
    const { deps, runtime } = makeDeps()
    // Pre-fix duplicate-spawn incidents (#f5io) left orphan twins: agent
    // sessions with an issue-worktree cwd that no issue_sessions row points
    // at. Reconcile follows links, so it must never resume one — but an
    // orphan left stuck on 'running' by a crash sits "mid-turn" forever;
    // sweep it back to idle. Its row stays: it is a durable transcript.
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'kk13' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await setBuildContext(db, issue.id, {
      branchName: 'x-kk13',
      worktreePath: '/wt/x-kk13',
    })
    const linked = uuidv7()
    await createSession(db, {
      id: linked,
      model: 'claude-sonnet-4-5',
      title: issue.title,
      cwd: '/wt/x-kk13',
      agentUserId: builderId,
    })
    await claimIssueSession(db, {
      issueId: issue.id,
      agentUserId: builderId,
      sessionId: linked,
    })
    // The orphan twin: same worktree, no link, stranded on 'running'.
    const orphan = uuidv7()
    await createSession(db, {
      id: orphan,
      model: 'claude-sonnet-4-5',
      title: issue.title,
      cwd: '/wt/x-kk13',
      agentUserId: builderId,
    })
    await setStatus(db, orphan, 'running')
    // An idle orphan is inert — nothing to sweep.
    const idleOrphan = uuidv7()
    await createSession(db, {
      id: idleOrphan,
      model: 'claude-sonnet-4-5',
      title: issue.title,
      cwd: '/wt/x-kk13',
      agentUserId: builderId,
    })
    // A running session OUTSIDE the worktree root (a chat session) is not
    // this sweep's business.
    const chatSession = uuidv7()
    await createSession(db, {
      id: chatSession,
      model: 'claude-sonnet-4-5',
      title: 'a chat',
      agentUserId: builderId,
    })
    await setStatus(db, chatSession, 'running')

    const orch = createOrchestrator(deps)
    await orch.reconcile()

    expect(runtime.cancelled).toContain(orphan)
    expect(runtime.cancelled).not.toContain(idleOrphan)
    expect(runtime.cancelled).not.toContain(chatSession)
    // Resumed turns went only to the linked session — never to an orphan.
    for (const turn of runtime.turns) {
      expect(turn.sessionId).toBe(linked)
    }
    // Data safety: every row is still there — cancelled, not deleted.
    expect(await getSession(db, orphan)).toBeDefined()
    expect(defined(await getSession(db, idleOrphan)).status).toBe('idle')
  })

  it('an orphan whose cancel fails is logged and does not sink the sweep', async () => {
    const { deps, runtime } = makeDeps()
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const doomed = uuidv7()
    const sweepable = uuidv7()
    for (const id of [doomed, sweepable]) {
      await createSession(db, {
        id,
        model: 'claude-sonnet-4-5',
        title: 'orphan',
        cwd: '/wt/x-kk14',
        agentUserId: builderId,
      })
      await setStatus(db, id, 'running')
    }
    const realCancel = runtime.cancel.bind(runtime)
    runtime.cancel = (sessionId: string) =>
      sessionId === doomed
        ? Promise.reject(new Error('boom'))
        : realCancel(sessionId)

    const orch = createOrchestrator(deps)
    await orch.reconcile()

    expect(runtime.cancelled).toContain(sweepable)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('cancelling orphan session'),
    )
    errorSpy.mockRestore()
  })

  it('sweeps lost background jobs LAST — after stranded cancels and re-seeded turns', async () => {
    // The ordering is the decision under test (#69iz): reconcileJobs clears
    // each durable row and resumes its session with "job lost". Run BEFORE
    // the issue sweep, a job-lost turn could mark its session `running` and
    // the sweep's cancel would abort it mid-message; run AFTER, the cancels
    // are done and a job-lost resume landing on a streaming re-seeded turn
    // just queues as a followUp on the same runtime.
    const { deps, runtime } = makeDeps()
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'kk15' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    const stranded = uuidv7()
    await createSession(db, {
      id: stranded,
      model: 'claude-sonnet-4-5',
      cwd: '/wt/x-kk15',
      agentUserId: builderId,
    })
    await claimIssueSession(db, {
      issueId: issue.id,
      agentUserId: builderId,
      sessionId: stranded,
    })
    await setStatus(db, stranded, 'running')

    const orch = createOrchestrator(deps)
    await orch.reconcile()

    // Exactly one sweep, strictly after everything the issue sweep did.
    expect(runtime.jobSweeps).toBe(1)
    expect(runtime.order).toContain(`cancel:${stranded}`)
    expect(runtime.order.at(-1)).toBe('jobs')
  })

  it('still sweeps lost background jobs when the issue sweep itself fails', async () => {
    // listIssues blowing up (db asleep at boot) must not strand the job
    // sweep — a session that lost its background job would otherwise wait
    // forever for a message that never comes.
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    try {
      const broken = new Proxy(
        {},
        {
          get() {
            throw new Error('db down')
          },
        },
      ) as unknown as Database
      const { deps, runtime } = makeDeps({ db: broken })
      const orch = createOrchestrator(deps)
      await expect(orch.reconcile()).resolves.toBeUndefined()
      expect(runtime.jobSweeps).toBe(1)
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('db down'))
    } finally {
      errSpy.mockRestore()
    }
  })

  it('a failing job sweep is logged, never thrown — boot must not sink', async () => {
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    try {
      const { deps, runtime } = makeDeps()
      runtime.onJobSweep = () => Promise.reject(new Error('sweep boom'))
      const orch = createOrchestrator(deps)
      await expect(orch.reconcile()).resolves.toBeUndefined()
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('sweep boom'))
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('orchestrator handoff (issue.handoff on the bus)', () => {
  /** The babysitter crew user seedAgentConfig already created + configured. */
  async function babysitter() {
    const user = defined(await getUserByHandle(db, 'babysitter'))
    return { user }
  }

  /** Build the issue, then hand it from the builder to `toHandle` on the bus. */
  async function handOff(
    orch: ReturnType<typeof createOrchestrator>,
    issue: { id: string; nano: string },
    toHandle: string,
    message: string,
  ) {
    await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builderId,
      target: toHandle,
      message,
    })
    const events = await listEventsSince(db, {
      topicPatterns: [`issue:${issue.id}`],
      audience: 'public',
    })
    // For OWNER target, requestHandoff emits ISSUE_OWNER_PING; for agents, ISSUE_HANDOFF
    const event = defined(
      events.find(
        (e) => e.type === ISSUE_HANDOFF || e.type === ISSUE_OWNER_PING,
      ),
    )
    await orch.handleBusNote({
      id: event.id,
      type: event.type,
      topic: issueTopic(issue.id),
    })
  }

  it('boots the target session in the issue worktree and fires the baton turn', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const { user } = await babysitter()
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ho01' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')

    await handOff(orch, issue, 'babysitter', 'PR #12 is open — take it home')

    // The baton-holder's session: recorded on issue_sessions, booted as the
    // TARGET's own identity (its config rides on the user row), in the SAME
    // worktree as the builder.
    const link = defined(await getIssueSession(db, issue.id, user.id))
    const session = defined(await getSession(db, link.sessionId))
    expect(session.agentUserId).toBe(user.id)
    expect(session.cwd).toBe('/wt/add-widget-ho01')

    // Turn 1 was the build seed; turn 2 is the baton, carrying the message and
    // the target's own actor prefix for the issue CLI.
    expect(runtime.turns).toHaveLength(2)
    expect(runtime.turns[1].sessionId).toBe(link.sessionId)
    expect(runtime.turns[1].text).toContain('PR #12 is open — take it home')
    expect(runtime.turns[1].text).toContain('@builder')
    expect(runtime.turns[1].text).toContain(`SKYLARK_ACTOR=${user.id}`)
  })

  it('reuses the target session on a second handoff — one hand per agent per issue', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const { user } = await babysitter()
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ho02' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')

    await handOff(orch, issue, 'babysitter', 'first pass')
    const first = defined(await getIssueSession(db, issue.id, user.id))

    await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builderId,
      target: 'babysitter',
      message: 'second pass',
    })
    const events = await listEventsSince(db, {
      topicPatterns: [`issue:${issue.id}`],
      audience: 'public',
    })
    const second = defined(
      events.filter((e) => e.type === ISSUE_HANDOFF).at(-1),
    )
    await orch.handleBusNote({
      id: second.id,
      type: ISSUE_HANDOFF,
      topic: issueTopic(issue.id),
    })

    expect(
      defined(await getIssueSession(db, issue.id, user.id)).sessionId,
    ).toBe(first.sessionId)
    // build turn + two baton turns, both on the same session.
    expect(runtime.turns).toHaveLength(3)
    expect(runtime.turns[2].sessionId).toBe(first.sessionId)
  })

  it('leaves OWNER handoffs to the notification path — no turn, no session', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ho03' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')

    await handOff(orch, issue, 'OWNER', 'checks green — merge?')

    // Only the build turn; the owner is pinged via their inbox, not a worktree.
    expect(runtime.turns).toHaveLength(1)
    expect(await getIssueSession(db, issue.id, authorId)).toBeUndefined()
  })

  it('tears down every hand on the issue when it is done', async () => {
    const { deps, runtime, git } = makeDeps()
    const orch = createOrchestrator(deps)
    const { user } = await babysitter()
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ho04' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')
    await handOff(orch, issue, 'babysitter', 'go')

    await drive(orch, issue.id, 'done')

    const links = await listIssueSessions(db, issue.id)
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(runtime.disposed).toContain(link.sessionId)
    }
    expect(git.removed).toHaveLength(1)
    void user
  })

  it('re-checks the baton inside the serialized handler — a racing second pass is dropped with a comment', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const { user } = await babysitter()
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ho07' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')
    // The babysitter is genuinely mid-turn by the time a second pass (which
    // squeaked past the door check before that turn started) is handled.
    await handOff(orch, issue, 'babysitter', 'first pass')
    const link = defined(await getIssueSession(db, issue.id, user.id))
    await setStatus(db, link.sessionId, 'running')

    const { emitEvent } = await import('@hull/events/bus')
    const tester = await createUser(db, {
      id: uuidv7(),
      handle: 'tester',
      displayName: 'Tester',
      type: 'agent',
    })
    const row = await emitEvent(db, {
      type: ISSUE_HANDOFF,
      source: 'issues',
      topic: issueTopic(issue.id),
      audience: 'public',
      payload: {
        issueId: issue.id,
        fromUserId: builderId,
        toUserId: tester.id,
        toHandle: 'tester',
        toOwner: false,
        message: 'also take a look',
      },
    })
    await orch.handleBusNote({
      id: row.id,
      type: ISSUE_HANDOFF,
      topic: issueTopic(issue.id),
    })

    // No third turn — and the dropped baton's message is on the thread.
    expect(runtime.turns).toHaveLength(2)
    const comments = await listComments(db, issue.id)
    expect(comments.at(-1)?.body).toContain('dropped')
    expect(comments.at(-1)?.body).toContain('also take a look')
  })

  it('drops a forged baton naming a human target — sessions never act as humans', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ho08' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')
    const { emitEvent } = await import('@hull/events/bus')
    // requestHandoff refuses human targets, so this can only be a forged or
    // replayed row — the consumer must re-validate, not trust the emitter.
    const row = await emitEvent(db, {
      type: ISSUE_HANDOFF,
      source: 'issues',
      topic: issueTopic(issue.id),
      audience: 'public',
      payload: {
        issueId: issue.id,
        fromUserId: builderId,
        toUserId: authorId, // a human
        toHandle: 'drufball',
        toOwner: false,
        message: 'act as dru',
      },
    })
    await orch.handleBusNote({
      id: row.id,
      type: ISSUE_HANDOFF,
      topic: issueTopic(issue.id),
    })
    expect(runtime.turns).toHaveLength(1)
    expect(await getIssueSession(db, issue.id, authorId)).toBeUndefined()
  })

  /** A built issue plus a baton-ready target — the base for forged-event tests. */
  async function builtWithTarget(orch: Orchestrator, nano: string) {
    const { user } = await babysitter()
    const issue = await createIssue(db, { title: 'X', authorId, nano })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')
    /** A payload that WOULD be delivered — each test breaks exactly one field. */
    const good = {
      issueId: issue.id,
      fromUserId: builderId,
      toUserId: user.id,
      toHandle: 'babysitter',
      toOwner: false,
      message: 'go',
    }
    return { issue, user, good }
  }

  it('ignores a handoff from another source, even with the right topic and audience', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const { issue, user, good } = await builtWithTarget(orch, 'hs01')
    const { emitEvent } = await import('@hull/events/bus')
    const row = await emitEvent(db, {
      type: ISSUE_HANDOFF,
      source: 'chat', // ONLY the source is wrong
      topic: issueTopic(issue.id),
      audience: 'public',
      payload: good,
    })
    await orch.handleBusNote({
      id: row.id,
      type: ISSUE_HANDOFF,
      topic: issueTopic(issue.id),
    })
    expect(runtime.turns).toHaveLength(1) // just the build seed
    expect(await getIssueSession(db, issue.id, user.id)).toBeUndefined()
  })

  it('ignores a handoff on the wrong audience, even with the right source and topic', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const { issue, user, good } = await builtWithTarget(orch, 'hs02')
    const { emitEvent } = await import('@hull/events/bus')
    const row = await emitEvent(db, {
      type: ISSUE_HANDOFF,
      source: 'issues',
      topic: issueTopic(issue.id),
      audience: 'members', // ONLY the audience is wrong
      payload: good,
    })
    await orch.handleBusNote({
      id: row.id,
      type: ISSUE_HANDOFF,
      topic: issueTopic(issue.id),
    })
    expect(runtime.turns).toHaveLength(1)
    expect(await getIssueSession(db, issue.id, user.id)).toBeUndefined()
  })

  it('leaves owner pings (issue.owner_ping) to the notification path even when the owner is an agent', async () => {
    // The target here is a real crew AGENT, so without the event type split,
    // the orchestrator might accidentally drive a worktree turn for an owner ping.
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const { issue, user, good } = await builtWithTarget(orch, 'hs03')
    const { emitEvent } = await import('@hull/events/bus')
    // Emit an owner ping (the new separate event type)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { toOwner, ...ownerPingPayload } = good // remove toOwner field
    const row = await emitEvent(db, {
      type: ISSUE_OWNER_PING,
      source: 'issues',
      topic: issueTopic(issue.id),
      audience: 'public',
      payload: ownerPingPayload,
    })
    await orch.handleBusNote({
      id: row.id,
      type: ISSUE_OWNER_PING,
      topic: issueTopic(issue.id),
    })
    // Only the initial build turn; the owner ping does not drive a turn
    expect(runtime.turns).toHaveLength(1)
    expect(await getIssueSession(db, issue.id, user.id)).toBeUndefined()
  })

  it('drops a handoff payload with one non-string field at a time', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const { issue, good } = await builtWithTarget(orch, 'hs04')
    const { emitEvent } = await import('@hull/events/bus')
    // Each variant breaks exactly ONE field (the envelope stays consistent
    // with it), so every shape guard is individually load-bearing.
    const variants: { payload: unknown; topic: string }[] = [
      { payload: { ...good, issueId: 42 }, topic: 'issue:42' },
      { payload: { ...good, fromUserId: 42 }, topic: issueTopic(issue.id) },
      { payload: { ...good, toUserId: 42 }, topic: issueTopic(issue.id) },
      { payload: { ...good, message: 42 }, topic: issueTopic(issue.id) },
    ]
    for (const { payload, topic } of variants) {
      const row = await emitEvent(db, {
        type: ISSUE_HANDOFF,
        source: 'issues',
        topic,
        audience: 'public',
        payload,
      })
      await orch.handleBusNote({ id: row.id, type: ISSUE_HANDOFF, topic })
    }
    expect(runtime.turns).toHaveLength(1) // just the build seed
  })

  it('ignores a handoff whose envelope disagrees with its payload', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const { user } = await babysitter()
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ho09' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')
    const { emitEvent } = await import('@hull/events/bus')
    // The payload names this issue, but the event sits on another topic — a
    // forged row must not get to start work on an issue it wasn't emitted on.
    const row = await emitEvent(db, {
      type: ISSUE_HANDOFF,
      source: 'issues',
      topic: 'issue:somewhere-else',
      audience: 'public',
      payload: {
        issueId: issue.id,
        fromUserId: builderId,
        toUserId: user.id,
        toHandle: 'babysitter',
        toOwner: false,
        message: 'go',
      },
    })
    await orch.handleBusNote({
      id: row.id,
      type: ISSUE_HANDOFF,
      topic: 'issue:somewhere-else',
    })
    expect(runtime.turns).toHaveLength(1)
  })

  it('drops a stale handoff for an issue no longer building', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    await babysitter()
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ho05' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')
    // Emit the handoff while building, but move the issue on before the bus
    // note is handled — the orchestrator must re-check durable state.
    await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builderId,
      target: 'babysitter',
      message: 'go',
    })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'open',
      actorId: authorId,
    })
    const events = await listEventsSince(db, {
      topicPatterns: [`issue:${issue.id}`],
      audience: 'public',
    })
    const event = defined(events.find((e) => e.type === ISSUE_HANDOFF))

    await orch.handleBusNote({
      id: event.id,
      type: ISSUE_HANDOFF,
      topic: issueTopic(issue.id),
    })

    expect(runtime.turns).toHaveLength(1) // just the build seed
    // The undeliverable baton's message survives on the thread, not just in a
    // console only the host laptop sees.
    const comments = await listComments(db, issue.id)
    expect(comments.at(-1)?.body).toContain('dropped')
    expect(comments.at(-1)?.body).toContain('go')
  })

  it('drops a handoff whose target user no longer exists', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'ho06' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')
    const { emitEvent } = await import('@hull/events/bus')
    // A handoff event naming a user id that was never (or is no longer) crew —
    // e.g. replayed from another ship's log. Dropped, not crashed on.
    const row = await emitEvent(db, {
      type: ISSUE_HANDOFF,
      source: 'issues',
      topic: issueTopic(issue.id),
      audience: 'public',
      payload: {
        issueId: issue.id,
        fromUserId: builderId,
        toUserId: uuidv7(),
        toHandle: 'ghost',
        toOwner: false,
        message: 'go',
      },
    })
    await orch.handleBusNote({
      id: row.id,
      type: ISSUE_HANDOFF,
      topic: issueTopic(issue.id),
    })
    expect(runtime.turns).toHaveLength(1) // just the build seed
  })

  it('drops a handoff note with a malformed payload', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const { emitEvent } = await import('@hull/events/bus')
    const row = await emitEvent(db, {
      type: ISSUE_HANDOFF,
      source: 'issues',
      topic: 'issue:42',
      audience: 'public',
      payload: { issueId: 42, toUserId: null, message: 7 },
    })
    await orch.handleBusNote({
      id: row.id,
      type: ISSUE_HANDOFF,
      topic: 'issue:42',
    })
    expect(runtime.turns).toEqual([])
  })
})

describe('orchestrator playbooks', () => {
  /** Seed the full crew, agent config, and standard playbooks on top of beforeEach. */
  async function seeded() {
    await seedCrew(db)
    await seedAgentConfig(db)
    await seedPlaybooks(db)
    return {
      hand: defined(await getUserByHandle(db, 'hand')),
      general: defined(await getPlaybookByName(db, 'general')),
    }
  }

  it('a general-playbook issue boots the hand — its own identity, a script-free prompt', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const { hand, general } = await seeded()
    const issue = await createIssue(db, {
      title: 'Summarize this week',
      authorId,
      nano: 'pb01',
      playbookId: general.id,
    })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')

    const link = defined(await getIssueSession(db, issue.id, hand.id))
    const session = defined(await getSession(db, link.sessionId))
    expect(session.agentUserId).toBe(hand.id)
    expect(session.cwd).toBe('/wt/add-widget-pb01')

    expect(runtime.turns).toHaveLength(1)
    expect(runtime.turns[0].text).toContain('Summarize this week')
    expect(runtime.turns[0].text).toContain(`SKYLARK_ACTOR=${hand.id}`)
    // No build script: the general playbook has no build-feature contract.
    expect(runtime.turns[0].text).not.toContain('build-feature')
  })

  it('folds a member’s role-in-strategy brief into a baton pass on that playbook', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const { hand } = await seeded()
    const tilde = defined(await getUserByHandle(db, 'tilde'))
    const triage = await upsertPlaybook(db, {
      name: 'triage',
      memberIds: [hand.id, tilde.id],
      entrypointId: hand.id,
      memberInstructions: {
        [tilde.id]:
          'You review for architecture soundness only — leave everything else to others.',
      },
    })
    const issue = await createIssue(db, {
      title: 'Review the new gateway',
      authorId,
      nano: 'pb04',
      playbookId: triage.id,
    })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')

    await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: hand.id,
      target: 'tilde',
      message: 'Please take a look',
    })
    const events = await listEventsSince(db, {
      topicPatterns: [`issue:${issue.id}`],
      audience: 'public',
    })
    const event = defined(events.find((e) => e.type === ISSUE_HANDOFF))
    await orch.handleBusNote({
      id: event.id,
      type: event.type,
      topic: `issue:${issue.id}`,
    })

    // Turn 1 seeded the entrypoint (hand); turn 2 is the baton to tilde,
    // carrying tilde's role-in-strategy brief from the playbook.
    expect(runtime.turns).toHaveLength(2)
    expect(runtime.turns[1].text).toContain('Your role on this playbook:')
    expect(runtime.turns[1].text).toContain(
      'You review for architecture soundness only',
    )
  })

  it('a default (no-playbook) issue still runs the build contract via the builder', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    await seeded()
    const issue = await createIssue(db, { title: 'X', authorId, nano: 'pb02' })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')

    const link = defined(await getIssueSession(db, issue.id, builderId))
    const session = defined(await getSession(db, link.sessionId))
    expect(session.agentUserId).toBe(builderId)
    expect(runtime.turns[0].text).toContain('build-feature')
  })

  it('drops a forged baton to an agent outside the playbook roster, with a comment', async () => {
    const { deps, runtime } = makeDeps()
    const orch = createOrchestrator(deps)
    const { general } = await seeded()
    const issue = await createIssue(db, {
      title: 'X',
      authorId,
      nano: 'pb03',
      playbookId: general.id,
    })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await orch.onStatusChanged(issue.id, 'building')
    const { emitEvent } = await import('@hull/events/bus')
    // The builder is a real agent, but not on the general playbook's roster.
    const row = await emitEvent(db, {
      type: ISSUE_HANDOFF,
      source: 'issues',
      topic: issueTopic(issue.id),
      audience: 'public',
      payload: {
        issueId: issue.id,
        fromUserId: authorId,
        toUserId: builderId,
        toHandle: 'builder',
        toOwner: false,
        message: 'come build this',
      },
    })
    await orch.handleBusNote({
      id: row.id,
      type: ISSUE_HANDOFF,
      topic: issueTopic(issue.id),
    })

    expect(runtime.turns).toHaveLength(1) // the hand's seed only
    const comments = await listComments(db, issue.id)
    expect(comments.at(-1)?.body).toContain('dropped')
  })
})

describe('generalPrompt', () => {
  it('carries the issue, thread, and the full CLI contract — but no build script', async () => {
    const issue = await createIssue(db, {
      title: 'Plan the offsite',
      body: 'Three days, remote crew.',
      authorId,
      nano: 'gp01',
    })
    const prompt = generalPrompt(
      issue,
      [{ authorHandle: 'dru', body: 'keep it cheap' }],
      'hand-1',
    )
    expect(prompt).toContain('#gp01')
    expect(prompt).toContain('Plan the offsite')
    expect(prompt).toContain('Three days, remote crew.')
    expect(prompt).toContain('- @dru: keep it cheap')
    expect(prompt).toContain('SKYLARK_ACTOR=hand-1 npm run issue -- done gp01')
    expect(prompt).toContain('handoff gp01 OWNER')
    expect(prompt).not.toContain('build-feature')
    expect(prompt).not.toContain('PR')
  })
})

// Helper: find the status_changed event id for an issue on the public scope.
async function findStatusEventId(
  database: Database,
  issueId: string,
): Promise<{ id: string }> {
  const events = await listEventsSince(database, {
    topicPatterns: ['issue:*'],
    audience: 'public',
  })
  const match = events.find(
    (e) =>
      e.type === ISSUE_STATUS_CHANGED &&
      (e.payload as { issueId: string }).issueId === issueId,
  )
  return { id: defined(match).id }
}
