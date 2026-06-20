import { uuidv7 } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

import type { Database } from '@hull/db/client'
import { getProfileByName } from '@hull/agent/profiles'
import { createSession } from '@hull/agent/service'
import { getEventById } from '@hull/events/service'
import { errorMessage } from '@hull/lib/errors'

import {
  getIssue,
  ISSUE_STATUS_CHANGED,
  listComments,
  listIssues,
  setBuildContext,
  setStatusLine,
} from './service'
import type { IssueRow, IssueStatus } from './schema'

/**
 * The orchestrator: the heart of M3 and the thing that proves the event bus. It
 * runs in the web-server process, subscribes to the ship's log, and reacts to
 * `issue.status_changed` events by driving the worktree + builder lifecycle.
 *
 * It MUST be event-driven, not just called inline, because an agent-initiated
 * transition arrives from a SEPARATE process — the builder runs `npm run issue
 * …` from its bash tool, which inserts a row + pg_notify; the web server's one
 * LISTEN connection fans that onto `shipLogBus`, and this orchestrator's
 * subscription hears it. So a turn the agent ran in its own CLI still moves the
 * lifecycle here.
 *
 * Every side-effect is idempotent: a worktree or session may already exist
 * (a duplicate event, a resume), so we check-then-act and never double-create.
 *
 * The decision logic is pure of I/O by injection — `GitOps` (worktree/git/fs),
 * the agent runtime, the slug generator are all dependencies — so the whole
 * lifecycle is unit-tested against fakes (orchestrator.test.ts). The live
 * end-to-end builder (a real LLM building real code) is exercised manually, not
 * in CI; see issues/zine.md.
 */

// --- Pure helpers (unit-tested directly) -----------------------------------

/**
 * Parse a `.worktreeinclude` file (`.gitignore` syntax, the subset we use):
 * one pattern per line, `#` comments and blank lines dropped, lines trimmed.
 * These are the gitignored paths copied into a fresh worktree — `git worktree
 * add` does NOT carry them, mirroring what Claude Code's worktree copy does.
 */
export function parseWorktreeInclude(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/**
 * Turn a human title (or an LLM-suggested phrase) into a git-ref-safe slug:
 * lowercase, alnum runs joined by single hyphens, trimmed, capped. A fallback
 * keeps the branch valid if the input reduces to nothing.
 */
export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '')
  return slug || 'build'
}

/**
 * The branch name for an issue: `<slug>-<nano>`. The nano makes it unique and
 * traceable back to the issue at a glance; the slug makes it readable.
 */
export function branchNameFor(slug: string, nano: string): string {
  return `${slugify(slug)}-${nano}`
}

/**
 * A short progress line for the board/thread, derived from a live agent event.
 * Returns null for events that carry no progress worth showing (so the existing
 * line stays put rather than flickering to nothing).
 */
export function statusLineFromEvent(event: AgentSessionEvent): string | null {
  switch (event.type) {
    case 'tool_execution_start': {
      const args: unknown = event.args
      const detail =
        typeof args === 'object' && args && 'command' in args
          ? String(args.command)
          : ''
      const text = `🔧 ${event.toolName} ${detail}`.trim()
      return text.length > 120 ? `${text.slice(0, 119)}…` : text
    }
    case 'turn_end':
    case 'agent_end':
      return 'thinking…'
    default:
      return null
  }
}

/**
 * The prompt a builder session is seeded with: the issue (title, body, the
 * thread so far) plus the contract for reporting back through the issue CLI.
 * Pure so the wording is reviewable and testable without booting an agent.
 */
export function buildPrompt(
  issue: IssueRow,
  comments: { authorHandle: string; body: string }[],
  /**
   * The builder's user id, prefixed onto the issue CLI commands as
   * `SKYLARK_ACTOR=<id>` so the agent's comments and transitions attribute to
   * the builder. A command-level prefix sets the env for exactly that child
   * process, so concurrent builders never race on a shared process env.
   */
  builderUserId: string,
): string {
  const thread =
    comments.length > 0
      ? '\n\nThread so far:\n' +
        comments.map((c) => `- @${c.authorHandle}: ${c.body}`).join('\n')
      : ''
  const issueCmd = `SKYLARK_ACTOR=${builderUserId} npm run issue --`
  return (
    `Build this issue (#${issue.nano}).\n\n` +
    `Title: ${issue.title}\n` +
    (issue.body ? `\n${issue.body}\n` : '') +
    thread +
    '\n\nFollow the ship-feature skill end to end: red-green TDD, `npm run check` ' +
    'clean, branch, push, open a PR, shepherd CI and the agentic reviews, and ' +
    'merge once green. You are already on the issue branch in a dedicated worktree.\n\n' +
    'Report back through the issue CLI. Always run it with the actor prefix shown ' +
    'so your comments and transitions are attributed to you:\n' +
    `- When the work is fully merged into main, run: ${issueCmd} done ${issue.nano}\n` +
    `- If you need clarification, post it and pause: ${issueCmd} comment ${issue.nano} "<question>" ` +
    `then ${issueCmd} open ${issue.nano}, then stop and wait.\n`
  )
}

// --- The injected boundaries -----------------------------------------------

/** Everything the orchestrator does to git, the filesystem, and the checkout. */
export interface GitOps {
  /** Does a worktree already exist at this path? (idempotency check.) */
  worktreeExists(path: string): Promise<boolean>
  /** `git worktree add <path> -b <branch>` (creates the branch + checkout). */
  addWorktree(path: string, branch: string): Promise<void>
  /** `git worktree remove --force <path>`. */
  removeWorktree(path: string): Promise<void>
  /** Copy the gitignored `.worktreeinclude` files from the main checkout in. */
  copyWorktreeIncludes(
    from: string,
    to: string,
    patterns: string[],
  ): Promise<void>
  /** `git pull --ff-only` in the server's own checkout (the done refresh). */
  pullMain(): Promise<void>
  /** `npm run db:migrate` in the server's checkout (merged work may add migrations). */
  runMigrations(): Promise<void>
}

/** The slice of the agent runtime the orchestrator drives (a fake stands in). */
export interface OrchestratorRuntime {
  runTurn(
    sessionId: string,
    text: string,
    onEvent?: (event: AgentSessionEvent) => void,
  ): Promise<void>
  cancel(sessionId: string): Promise<void>
  dispose(sessionId: string): void
}

export interface OrchestratorDeps {
  db: Database
  git: GitOps
  runtime: OrchestratorRuntime
  /** The crew member builder sessions act as (→ users.id). */
  builderUserId: string
  /** Root for worktrees, e.g. `~/skylark/worktrees`. */
  worktreeRoot: string
  /** Generate a short branch slug from the issue (a cheap LLM call live). */
  generateSlug: (issue: IssueRow) => Promise<string>
}

/** A tiny note off the ship-log bus: just enough to read the full event by id. */
export interface BusNote {
  id: string
  type: string
  scope: string
}

export function createOrchestrator(deps: OrchestratorDeps) {
  const { db, git, runtime, builderUserId, worktreeRoot } = deps

  /**
   * Fire a turn in the background, streaming the agent's progress into the
   * issue's status line. Fire-and-forget: a turn is long-lived and the
   * orchestrator must not block the event handler on it. Failures are logged,
   * never thrown — the session row's error status is the runtime's job.
   */
  function fireBuilderTurn(issueId: string, sessionId: string, text: string) {
    void runtime
      .runTurn(sessionId, text, (event) => {
        const line = statusLineFromEvent(event)
        if (line)
          void setStatusLine(db, issueId, line).catch((err: unknown) => {
            console.error(`issue status line failed: ${errorMessage(err)}`)
          })
      })
      .catch((err: unknown) => {
        console.error(`builder turn ${sessionId} failed: ${errorMessage(err)}`)
      })
  }

  /** Resolve the issue's thread into prompt-ready {authorHandle, body} items. */
  async function threadFor(
    issueId: string,
  ): Promise<{ authorHandle: string; body: string }[]> {
    const comments = await listComments(db, issueId)
    const { getUserById } = await import('@hull/users/service')
    const out: { authorHandle: string; body: string }[] = []
    for (const c of comments) {
      const who = await getUserById(db, c.authorId)
      out.push({ authorHandle: who?.handle ?? '?', body: c.body })
    }
    return out
  }

  /**
   * Ensure the worktree + builder session exist for an issue, idempotently, and
   * return the session id and whether the turn should be seeded fresh (build)
   * or resumed. Generates the branch + worktree on first build; reuses both on
   * a resume.
   */
  async function ensureBuild(issue: IssueRow): Promise<{ sessionId: string }> {
    let branchName = issue.branchName
    let worktreePath = issue.worktreePath

    if (!branchName) {
      const slug = await deps.generateSlug(issue)
      branchName = branchNameFor(slug, issue.nano)
      worktreePath = `${worktreeRoot}/${branchName}`
    }
    /* v8 ignore next -- branchName is always set above; narrows the type */
    worktreePath ??= `${worktreeRoot}/${branchName}`

    // Create the worktree only if absent (a resume, or a duplicate event, finds
    // it already there). git worktree add does NOT copy gitignored files, so we
    // mirror Claude Code and copy the .worktreeinclude set in afterward.
    if (!(await git.worktreeExists(worktreePath))) {
      await git.addWorktree(worktreePath, branchName)
      const patterns = await readWorktreeIncludes()
      await git.copyWorktreeIncludes(process.cwd(), worktreePath, patterns)
    }

    // Reuse the existing builder session if the issue already has one.
    let sessionId = issue.sessionId
    if (!sessionId) {
      sessionId = uuidv7()
      const builder = await getProfileByName(db, 'builder')
      await createSession(db, {
        id: sessionId,
        model: 'claude-sonnet-4-5',
        title: issue.title,
        profileId: builder?.id ?? null,
        cwd: worktreePath,
        agentUserId: builderUserId,
      })
    }

    await setBuildContext(db, issue.id, { branchName, worktreePath, sessionId })
    return { sessionId }
  }

  /** Tear down the worktree + session for an issue (done/closed). Idempotent. */
  async function teardown(issue: IssueRow): Promise<void> {
    if (issue.sessionId) runtime.dispose(issue.sessionId)
    if (issue.worktreePath && (await git.worktreeExists(issue.worktreePath))) {
      await git.removeWorktree(issue.worktreePath)
    }
  }

  /**
   * React to a status transition. The single decision point for the build
   * lifecycle — every door (web, CLI, another process) lands here through the
   * ship's log. Re-reads the issue row so the decision is on durable state, not
   * the event payload.
   */
  async function onStatusChanged(
    issueId: string,
    _from: IssueStatus,
    to: IssueStatus,
  ): Promise<void> {
    const issue = await getIssue(db, issueId)
    if (!issue) return

    switch (to) {
      case 'building': {
        // → building, whether a fresh open→building or a resume from open. Both
        // ensure the build exists (idempotent), then seed/resume the turn with
        // the latest thread.
        const { sessionId } = await ensureBuild(issue)
        const fresh = await getIssue(db, issueId)
        const thread = await threadFor(issueId)
        const prompt = buildPrompt(fresh ?? issue, thread, builderUserId)
        fireBuilderTurn(issueId, sessionId, prompt)
        break
      }
      case 'open':
        // Agent paused: it commented and set open, then ended its turn. Leave
        // the session idle on its worktree — a resume reuses both. No teardown.
        break
      case 'done':
        // Agent merged. Refresh the server's own checkout from main (defensive:
        // ff-only, log failures, never crash), apply any new migrations, then
        // tear the build down. Vite HMR reloads the server on the pulled files.
        await refreshFromMain()
        await teardown(issue)
        break
      case 'closed':
        // Human cancelled: stop the in-flight turn, dispose, remove the worktree.
        if (issue.sessionId) await runtime.cancel(issue.sessionId)
        await teardown(issue)
        break
    }
  }

  /**
   * The self-modifying refresh: pull main into the running server's checkout
   * and migrate. This is a known sharp edge (a process updating its own code),
   * so it's deliberately defensive — ff-only, every failure logged, NEVER
   * thrown. A failed self-update must not sink the server; the merged work is
   * already safe in main and the next deploy/restart picks it up.
   */
  async function refreshFromMain(): Promise<void> {
    try {
      await git.pullMain()
      await git.runMigrations()
    } catch (err) {
      console.error(`done-refresh failed (continuing): ${errorMessage(err)}`)
    }
  }

  /**
   * The ship-log subscription handler: a status_changed note arrived. Read the
   * full event by id (the note carries only {id,type,scope}), and drive the
   * transition. Other event types are ignored.
   */
  async function handleBusNote(note: BusNote): Promise<void> {
    if (note.type !== ISSUE_STATUS_CHANGED) return
    const event = await getEventById(db, note.id)
    if (!event) return
    const payload = event.payload as {
      issueId: string
      from: IssueStatus
      to: IssueStatus
    }
    await onStatusChanged(payload.issueId, payload.from, payload.to)
  }

  /**
   * Startup reconciliation: after a server restart (e.g. the HMR reload a done
   * refresh triggers), an issue can be stuck in `building` with a session row
   * but no live session in this fresh process. Resume each by re-seeding a turn
   * — idempotent ensureBuild reuses the existing worktree + session.
   */
  async function reconcile(): Promise<void> {
    const all = await listIssues(db)
    for (const issue of all) {
      if (issue.status !== 'building') continue
      try {
        const { sessionId } = await ensureBuild(issue)
        const thread = await threadFor(issue.id)
        fireBuilderTurn(
          issue.id,
          sessionId,
          buildPrompt(issue, thread, builderUserId),
        )
      } catch (err) {
        console.error(
          `reconcile ${issue.nano} failed (continuing): ${errorMessage(err)}`,
        )
      }
    }
  }

  return { onStatusChanged, handleBusNote, reconcile }
}

export type Orchestrator = ReturnType<typeof createOrchestrator>

/* v8 ignore start -- live filesystem read of the repo's .worktreeinclude */
/**
 * Read and parse the repo's `.worktreeinclude` (falls back to just `.env` if the
 * file is missing). Impure file read, kept out of the pure parser above.
 */
async function readWorktreeIncludes(): Promise<string[]> {
  const { readFile } = await import('node:fs/promises')
  try {
    const text = await readFile('.worktreeinclude', 'utf8')
    return parseWorktreeInclude(text)
  } catch {
    return ['.env']
  }
}
/* v8 ignore stop */
