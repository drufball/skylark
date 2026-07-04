import { uuidv7 } from '@earendil-works/pi-agent-core'

import type { Database } from '@hull/db/client'
import { DEFAULT_MODEL, type RunsTurns } from '@hull/agent/runtime'
import { createSession, getSession } from '@hull/agent/service'
import type { NotifyPayload } from '@hull/events/bus'
import { getEventById, trustedEvent } from '@hull/events/service'
import { getUserById, handleOf } from '@hull/users/service'
import { errorMessage } from '@hull/lib/errors'
import { issuesProgressLine } from '@hull/agent/progress'

import {
  addComment,
  getIssue,
  getIssueSession,
  ISSUE_STATUS_CHANGED,
  issueTopic,
  listComments,
  listIssues,
  listIssueSessions,
  recordIssueSession,
  setBuildContext,
  setStatusLine,
} from './service'
import {
  ISSUE_HANDOFF,
  runningHands,
  type IssueHandoffPayload,
} from './handoff'
import { BUILD_PLAYBOOK_NAME, instructionsFor, playbookFor } from './playbooks'
import type { IssueRow, IssueStatus } from './schema'
import { buildPrompt, generalPrompt, handoffPrompt } from './prompts'

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
 * What slugify answers when the input reduces to nothing — and therefore the
 * one slug an LLM suggestion can never claim: a model completion that
 * slugifies to this sentinel is indistinguishable from an empty/garbage
 * answer, so slugFromCompletion rejects it and names the branch from the
 * title instead.
 */
export const SLUG_FALLBACK = 'build'

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
  return slug || SLUG_FALLBACK
}

/** One block of a model completion, as slugFromCompletion reads it. */
export interface CompletionBlock {
  type: string
  text?: string
}

/**
 * The slug decision behind generateSlug (orchestrator-live.ts), pure of the
 * model call: gather the completion's text blocks, slugify them, and reject
 * the SLUG_FALLBACK sentinel (an empty or "build" answer must not name the
 * branch). No completion available (`undefined`), or one that throws, falls
 * back to slugifying the title — the branch is always valid with no network.
 */
export async function slugFromCompletion(
  title: string,
  complete: (() => Promise<CompletionBlock[]>) | undefined,
): Promise<string> {
  if (!complete) return slugify(title)
  try {
    const text = (await complete())
      .filter(
        (c): c is { type: 'text'; text: string } =>
          c.type === 'text' && typeof c.text === 'string',
      )
      .map((c) => c.text)
      .join(' ')
    const slug = slugify(text)
    return slug === SLUG_FALLBACK ? slugify(title) : slug
  } catch (err) {
    console.warn(`slug LLM call failed, using title: ${errorMessage(err)}`)
    return slugify(title)
  }
}

/**
 * The branch name for an issue: `<slug>-<nano>`. The nano makes it unique and
 * traceable back to the issue at a glance; the slug makes it readable.
 */
export function branchNameFor(slug: string, nano: string): string {
  return `${slugify(slug)}-${nano}`
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
  // open→building→open→building — and ensureEntrypoint's check-then-act
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
  function fireTurn(issueId: string, sessionId: string, text: string) {
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
        console.error(`issue turn ${sessionId} failed: ${errorMessage(err)}`)
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
   * Ensure the issue's ONE worktree exists, idempotently, and return its path.
   * Generates the branch on first build; reuses it (and the worktree) after.
   */
  async function ensureWorktree(issue: IssueRow): Promise<string> {
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
    }
    // Persist idempotently (on a reuse these are the same values) — and BEFORE
    // any session is created, so a DB failure there can't strand a worktree
    // with no branchName recorded (which would re-generate a fresh slug + a
    // second worktree on the next event).
    await setBuildContext(db, issue.id, { branchName, worktreePath })
    return worktreePath
  }

  /**
   * Ensure an agent's session on this issue exists (one per issue × agent,
   * recorded on issue_sessions), in the issue's worktree, booted as the
   * agent's own identity — its config rides on the user row. Reused on every
   * later turn.
   */
  async function ensureAgentSession(input: {
    issue: IssueRow
    agentUserId: string
    worktreePath: string
    title: string
  }): Promise<string> {
    const existing = await getIssueSession(
      db,
      input.issue.id,
      input.agentUserId,
    )
    if (existing) return existing.sessionId

    const sessionId = uuidv7()
    await createSession(db, {
      id: sessionId,
      model: DEFAULT_MODEL,
      title: input.title,
      cwd: input.worktreePath,
      agentUserId: input.agentUserId,
    })
    await recordIssueSession(db, {
      issueId: input.issue.id,
      agentUserId: input.agentUserId,
      sessionId,
    })
    return sessionId
  }

  /**
   * Who starts this issue: the playbook's entrypoint agent, or — on a ship
   * with nothing seeded, or a roster whose agent has left the crew — the
   * legacy builder identity. `build` is whether the entrypoint runs the
   * build-feature contract or the plain general brief.
   */
  async function entryFor(
    issue: IssueRow,
  ): Promise<{ userId: string; build: boolean }> {
    const playbook = await playbookFor(db, issue)
    if (playbook) {
      const entry = await getUserById(db, playbook.entrypointId)
      if (entry) {
        return {
          userId: entry.id,
          build: playbook.name === BUILD_PLAYBOOK_NAME,
        }
      }
      console.warn(
        `playbook ${playbook.name} entrypoint is gone; falling back to the builder`,
      )
    }
    return { userId: builderUserId, build: true }
  }

  /**
   * Get the babysitter handle for a build playbook: the non-entrypoint member
   * who shepherds PRs. For the build playbook, this is the member who isn't
   * the entrypoint (builder → babysitter). Falls back to 'babysitter' if the
   * playbook structure is unexpected or members aren't resolved.
   */
  async function babysitterHandleFor(issue: IssueRow): Promise<string> {
    const playbook = await playbookFor(db, issue)
    if (playbook?.name !== BUILD_PLAYBOOK_NAME) {
      return 'babysitter' // Defensive: non-build playbooks don't use this
    }
    // The babysitter is the member who isn't the entrypoint
    const nonEntryIds = playbook.memberIds.filter(
      (id) => id !== playbook.entrypointId,
    )
    if (nonEntryIds.length > 0) {
      const babysitter = await getUserById(db, nonEntryIds[0])
      if (babysitter) return babysitter.handle
    }
    // Fallback if the playbook is missing members or they're gone
    return 'babysitter'
  }

  /** Ensure the worktree + the entrypoint's session exist, idempotently. */
  async function ensureEntrypoint(
    issue: IssueRow,
  ): Promise<{ sessionId: string; entryUserId: string; build: boolean }> {
    const entry = await entryFor(issue)
    const worktreePath = await ensureWorktree(issue)
    const sessionId = await ensureAgentSession({
      issue,
      agentUserId: entry.userId,
      worktreePath,
      title: issue.title,
    })
    return { sessionId, entryUserId: entry.userId, build: entry.build }
  }

  /** Tear down the worktree + every hand's session (done/closed). Idempotent. */
  async function teardown(issue: IssueRow): Promise<void> {
    for (const hand of await listIssueSessions(db, issue.id)) {
      runtime.dispose(hand.sessionId)
    }
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
  function onStatusChanged(issueId: string, to: IssueStatus): Promise<void> {
    return serialize(issueId, () => applyTransition(issueId, to))
  }

  /**
   * Re-drive a `building` issue's lifecycle (startup reconciliation): the same
   * serialized applyTransition a live → building event takes, so a resume
   * racing a bus note for the same issue still can't double-create anything.
   */
  function resume(issueId: string): Promise<void> {
    return serialize(issueId, () => applyTransition(issueId, 'building'))
  }

  async function applyTransition(
    issueId: string,
    to: IssueStatus,
  ): Promise<void> {
    const issue = await getIssue(db, issueId)
    if (!issue) return
    // Act on durable state, not the event: transitionIssue writes the status
    // BEFORE emitting, so by handling time the row reads `to` — unless the
    // issue has since moved on, in which case this event is stale or replayed
    // and must not re-run side-effects (a stale → building on a since-done
    // issue would recreate its worktree and fire a turn). Stale events are
    // normal; drop them quietly.
    if (issue.status !== to) return

    switch (to) {
      case 'building': {
        // → building, whether a fresh open→building or a resume from open. Both
        // ensure the playbook entrypoint's hand exists (idempotent), then
        // seed/resume the turn with the latest thread — the build-feature
        // contract for the build playbook, the plain brief for anything else.
        const { sessionId, entryUserId, build } = await ensureEntrypoint(issue)
        const fresh = await getIssue(db, issueId)
        const thread = await threadFor(issueId)
        const playbook = await playbookFor(db, issue)
        const prompt = build
          ? buildPrompt(
              fresh ?? issue,
              thread,
              entryUserId,
              await babysitterHandleFor(issue),
            )
          : generalPrompt(
              fresh ?? issue,
              thread,
              entryUserId,
              playbook && instructionsFor(playbook, entryUserId),
            )
        fireTurn(issueId, sessionId, prompt)
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
        // Human cancelled: stop every in-flight turn, dispose, remove the worktree.
        for (const hand of await listIssueSessions(db, issueId)) {
          await runtime.cancel(hand.sessionId)
        }
        await teardown(issue)
        break
    }
  }

  /**
   * A baton that can't be delivered must not evaporate: the from-agent already
   * printed "baton passed" and stopped, so the handoff message is written back
   * onto the thread where every watcher (and the owner) can see it and act.
   */
  async function dropHandoff(
    payload: IssueHandoffPayload,
    reason: string,
  ): Promise<void> {
    await addComment(db, {
      issueId: payload.issueId,
      authorId: payload.fromUserId,
      body:
        `⚠ Handoff to @${payload.toHandle} was dropped: ${reason}. ` +
        `The message was:\n\n> ${payload.message}`,
    })
  }

  /**
   * React to a baton pass: ensure the target agent's session exists in the
   * issue's ONE worktree (booted as the target's own identity — its config
   * rides on the user row) and fire a turn briefed with the handoff message.
   * Owner pings never land here
   * — the notifications reactor carries those to an inbox/wake instead.
   * Re-reads the issue so a stale event (the issue moved on before this note
   * was handled) is dropped rather than acted on.
   */
  async function applyHandoff(payload: IssueHandoffPayload): Promise<void> {
    const issue = await getIssue(db, payload.issueId)
    if (!issue) return
    if (issue.status !== 'building') {
      // Raced a close/pause between emit and handling.
      await dropHandoff(payload, `the issue is ${issue.status}, not building`)
      return
    }
    // Re-validate against durable state, not just the payload: requestHandoff
    // only emits baton passes to agents, but a replayed, stale, or forged
    // event must not boot a worktree session that acts as a HUMAN.
    const target = await getUserById(db, payload.toUserId)
    if (target?.type !== 'agent') {
      console.warn(
        `handoff on #${issue.nano} dropped: target is not a crew agent`,
      )
      return
    }
    // The playbook is the roster: a baton to an agent outside it — forged, or
    // emitted before the playbook changed — must not put a new hand on the
    // issue. Same durable-state re-check as the door's, for the same reason.
    const playbook = await playbookFor(db, issue)
    if (playbook && !playbook.memberIds.includes(target.id)) {
      await dropHandoff(
        payload,
        `@${target.handle} is not on this issue's playbook (${playbook.name})`,
      )
      return
    }
    // Re-check the baton HERE, inside the per-issue chain, where check-and-act
    // is atomic. requestHandoff's door check can race another pass (its emit
    // and this handler are seconds apart); two batons both passing the door
    // must not both fire — that's two agents committing into one worktree.
    const busy = await runningHands(db, issue.id, payload.fromUserId)
    if (busy.length > 0) {
      await dropHandoff(payload, 'another agent is already mid-turn')
      return
    }
    const worktreePath = await ensureWorktree(issue)
    const sessionId = await ensureAgentSession({
      issue,
      agentUserId: target.id,
      worktreePath,
      title: `${issue.title} (@${target.handle})`,
    })
    const fromHandle = await handleOf(db, payload.fromUserId)
    fireTurn(
      issue.id,
      sessionId,
      handoffPrompt(
        issue,
        fromHandle,
        payload.message,
        target.id,
        playbook && instructionsFor(playbook, target.id),
      ),
    )
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
   * The ship-log subscription handler: a status_changed or handoff note
   * arrived. Read the full event by id (the note carries only
   * {id,type,topic,audience}), and drive the transition or the baton pass.
   * Other event types are ignored. With the single-emit model (topic +
   * audience), each event arrives exactly once — the dedup workaround is
   * retired. Payload shapes are validated rather than trusted: a replayed or
   * another ship's event must not sail unchecked into the lifecycle; a bad
   * payload is dropped quietly.
   */
  async function handleBusNote(note: NotifyPayload): Promise<void> {
    if (note.type === ISSUE_STATUS_CHANGED) {
      const event = await getEventById(db, note.id)
      if (!event) return
      const payload = event.payload as {
        issueId?: unknown
        from?: unknown
        to?: unknown
      }
      if (typeof payload.issueId !== 'string') return
      if (!isStatus(payload.from) || !isStatus(payload.to)) return
      // The envelope must agree with the payload: only this service's own
      // event, on the very issue the payload names, may drive the lifecycle.
      if (
        !trustedEvent(event, {
          source: 'issues',
          topic: issueTopic(payload.issueId),
        })
      )
        return
      await onStatusChanged(payload.issueId, payload.to)
      return
    }
    if (note.type === ISSUE_HANDOFF) {
      const event = await getEventById(db, note.id)
      if (!event) return
      const p = event.payload as Partial<IssueHandoffPayload>
      if (
        typeof p.issueId !== 'string' ||
        typeof p.fromUserId !== 'string' ||
        typeof p.toUserId !== 'string' ||
        typeof p.message !== 'string'
      )
        return
      // The envelope must agree with the payload: a handoff is only acted on
      // when the durable event came from this service, on the public audience,
      // on the very issue the payload names. A row whose topic points at a
      // different issue must not start work in that issue's worktree.
      if (
        !trustedEvent(event, {
          source: 'issues',
          audience: 'public',
          topic: issueTopic(p.issueId),
        })
      )
        return
      // issue.handoff drives worktree turns; owner pings are now the separate
      // issue.owner_ping type, handled by the notifications reactor.
      const payload: IssueHandoffPayload = {
        issueId: p.issueId,
        fromUserId: p.fromUserId,
        toUserId: p.toUserId,
        toHandle: typeof p.toHandle === 'string' ? p.toHandle : '?',
        message: p.message,
      }
      await serialize(payload.issueId, () => applyHandoff(payload))
    }
  }

  /**
   * Startup reconciliation: after a server restart (e.g. the HMR reload a done
   * refresh triggers), an issue can be stuck in `building` with a session row
   * but no live session in this fresh process. Resume each by re-seeding a turn
   * — idempotent ensureEntrypoint reuses the existing worktree + session.
   */
  async function reconcile(): Promise<void> {
    const all = await listIssues(db)
    for (const issue of all) {
      if (issue.status !== 'building') continue
      // A fresh process has no live turns, so any issue session still marked
      // 'running' was stranded by a crash/restart — and a stranded row jams
      // the baton forever (runningHands reads it as mid-turn, and every
      // future handoff is refused). Cancel sweeps it back to idle.
      for (const hand of await listIssueSessions(db, issue.id)) {
        const session = await getSession(db, hand.sessionId)
        if (session?.status !== 'running') continue
        await runtime.cancel(hand.sessionId).catch((err: unknown) => {
          console.error(
            `reconcile ${issue.nano}: cancelling stranded session failed: ${errorMessage(err)}`,
          )
        })
      }
      // Route through the same serialized building path so a reconcile racing a
      // live bus note for the same issue can't double-create its worktree.
      await resume(issue.id).catch((err: unknown) => {
        console.error(
          `reconcile ${issue.nano} failed (continuing): ${errorMessage(err)}`,
        )
      })
    }
  }

  return { onStatusChanged, resume, handleBusNote, reconcile }
}

export type Orchestrator = ReturnType<typeof createOrchestrator>
