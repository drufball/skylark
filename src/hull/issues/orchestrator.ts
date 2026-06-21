import { uuidv7 } from '@earendil-works/pi-agent-core'

import type { Database } from '@hull/db/client'
import { getProfileByName } from '@hull/agent/profiles'
import { DEFAULT_MODEL, type RunsTurns } from '@hull/agent/runtime'
import { createSession } from '@hull/agent/service'
import type { NotifyPayload } from '@hull/events/bus'
import { getEventById } from '@hull/events/service'
import { handleOf } from '@hull/users/service'
import { errorMessage } from '@hull/lib/errors'
import { issuesProgressLine } from '@hull/agent/progress'

import {
  getIssue,
  issueScope,
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

/** Is this value one of the four issue statuses? Guards untrusted event payloads. */
function isStatus(value: unknown): value is IssueStatus {
  return (
    value === 'open' ||
    value === 'building' ||
    value === 'done' ||
    value === 'closed'
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
  /** Read + parse the repo's `.worktreeinclude` (the gitignored files to copy in). */
  readWorktreeIncludes(): Promise<string[]>
  /** Is `branch` an ancestor of `main` — i.e. has its work actually merged? */
  branchMerged(branch: string): Promise<boolean>
}

/** The slice of the agent runtime the orchestrator drives (a fake stands in). */
export interface OrchestratorRuntime extends RunsTurns {
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

export function createOrchestrator(deps: OrchestratorDeps) {
  const { db, git, runtime, builderUserId, worktreeRoot } = deps

  // Serialize all work for a single issue. Events for the same issue can arrive
  // concurrently — a reconcile-on-boot racing a live bus note, a rapid
  // open→building→open→building — and ensureBuild's check-then-act
  // (worktreeExists → addWorktree) would otherwise let two passes both miss the
  // worktree and create it (and a second session) twice. A per-issue promise
  // chain makes each issue's transitions run one at a time; different issues
  // still run in parallel.
  // The stored chain is "settle-only": it never rejects (a thrown `work` is
  // caught into the tail), so the next link runs after the prior one regardless
  // of outcome and a failure never leaves an unhandled rejection on the chain.
  // The caller gets a separate promise that DOES reflect `work`'s result.
  const chains = new Map<string, Promise<void>>()
  function serialize(
    issueId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const prior = chains.get(issueId) ?? Promise.resolve()
    const result = prior.then(work)
    const tail = result.catch(() => undefined)
    chains.set(issueId, tail)
    // Keep the map bounded: once this link is the tail, drop it.
    void tail.then(() => {
      if (chains.get(issueId) === tail) chains.delete(issueId)
    })
    return result
  }

  /**
   * Fire a turn in the background, streaming the agent's progress into the
   * issue's status line. Fire-and-forget: a turn is long-lived and the
   * orchestrator must not block the event handler on it. Failures are logged,
   * never thrown — the session row's error status is the runtime's job.
   */
  function fireBuilderTurn(issueId: string, sessionId: string, text: string) {
    void runtime
      .runTurn(sessionId, text, (event) => {
        const line = issuesProgressLine(event)
        if (line)
          void setStatusLine(db, issueId, line).catch(
            /* v8 ignore next 2 -- defensive: a status-line write failing must never break a build */
            (err: unknown) => {
              console.error(`issue status line failed: ${errorMessage(err)}`)
            },
          )
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
    return Promise.all(
      comments.map(async (c) => ({
        authorHandle: await handleOf(db, c.authorId),
        body: c.body,
      })),
    )
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
      const patterns = await git.readWorktreeIncludes()
      await git.copyWorktreeIncludes(process.cwd(), worktreePath, patterns)
      // Persist the branch + worktree the moment they exist on disk — BEFORE
      // creating the session — so a DB failure on createSession can't strand a
      // worktree with no branchName recorded (which would re-generate a fresh
      // slug + a second worktree on the next event). A resume returns here,
      // finds the worktree present, and skips straight past.
      await setBuildContext(db, issue.id, { branchName, worktreePath })
    }

    // Reuse the existing builder session if the issue already has one.
    let sessionId = issue.sessionId
    if (!sessionId) {
      sessionId = uuidv7()
      const builder = await getProfileByName(db, 'builder')
      await createSession(db, {
        id: sessionId,
        model: DEFAULT_MODEL,
        title: issue.title,
        profileId: builder?.id ?? null,
        cwd: worktreePath,
        agentUserId: builderUserId,
        // The builder session inherits the issue's visibility (public board).
        origin: issueScope(issue.id),
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
   * ship's log. Serialized per issue so concurrent events for the same issue
   * can't double-create a worktree/session; re-reads the issue row so the
   * decision is on durable state, not the event payload.
   */
  function onStatusChanged(
    issueId: string,
    from: IssueStatus,
    to: IssueStatus,
  ): Promise<void> {
    return serialize(issueId, () => applyTransition(issueId, from, to))
  }

  async function applyTransition(
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
      case 'done': {
        // Agent says merged. Refresh the server's own checkout from main
        // (defensive: ff-only, log failures, never crash), apply any new
        // migrations — then tear the build down. Vite HMR reloads the server on
        // the pulled files.
        await refreshFromMain()
        // The prompt asks the agent to set `done` only after a real merge, but a
        // prompt isn't a contract. Don't tear down a worktree whose branch isn't
        // actually in main yet — that would orphan an in-flight PR with no
        // worktree to amend from. If we can't confirm the merge, leave the build
        // standing (a human can close it). A missing branchName is treated as
        // "nothing to protect" and torn down.
        const merged = issue.branchName
          ? await git.branchMerged(issue.branchName).catch(() => false)
          : true
        if (merged) await teardown(issue)
        else
          console.warn(
            `issue ${issue.nano} set done but ${issue.branchName ?? '?'} is not in main; leaving the worktree standing`,
          )
        break
      }
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
   * full event by id (the note carries only {id,type,topic,audience}), and drive
   * the transition. Other event types are ignored. With the single-emit model
   * (topic + audience), each transition arrives exactly once — the dedup
   * workaround is retired.
   */
  async function handleBusNote(note: NotifyPayload): Promise<void> {
    if (note.type !== ISSUE_STATUS_CHANGED) return
    const event = await getEventById(db, note.id)
    if (!event) return
    const payload = event.payload as {
      issueId?: unknown
      from?: unknown
      to?: unknown
    }
    // Validate the shape rather than trust it: today only transitionIssue emits
    // this, but a replayed or another ship's event must not sail unchecked into
    // the lifecycle. A bad payload is dropped quietly.
    if (typeof payload.issueId !== 'string') return
    if (!isStatus(payload.from) || !isStatus(payload.to)) return
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
      // Route through the same serialized building path so a reconcile racing a
      // live bus note for the same issue can't double-create its worktree.
      await onStatusChanged(issue.id, 'building', 'building').catch(
        (err: unknown) => {
          console.error(
            `reconcile ${issue.nano} failed (continuing): ${errorMessage(err)}`,
          )
        },
      )
    }
  }

  return { onStatusChanged, handleBusNote, reconcile }
}

export type Orchestrator = ReturnType<typeof createOrchestrator>
