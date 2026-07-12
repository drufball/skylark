import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { Database } from '@hull/db/client'
import { emitEvent } from '@hull/events/bus'
import type { AppendEventInput } from '@hull/events/service'
import { errorMessage } from '@hull/lib/errors'

import { createBackgroundJobs, defaultSpawn, type SpawnFn } from './background'
import { createBackgroundTool } from './background-tool'
import { getUserById } from '@hull/users/service'

import { withAgentMemory, type AgentMemoryLoader } from './memory'
import { defaultModelRef, gatewayApiKey, resolveModel } from './models'
import { resolveExtensionPaths } from './agent-config'
import { resolveSessionOptions, type AgentConfig } from './session-config'
import {
  appendMessage,
  getMessages,
  getSession,
  setStatus,
  type SessionStatus,
} from './service'
import { sessionTopic } from './topic'

// `setStatus` is wrapped by `announceStatus` below (which also emits to the
// ship's log); the runtime never sets status without announcing it.

/**
 * How the runtime announces what's happening to the ship's log. It's the events
 * service's own `AppendEventInput` — one contract, no near-duplicate — so it
 * already carries `actorId` for when turns thread the acting user through.
 * Decoupled behind this type so a failed emit never breaks a turn (see
 * `safeEmit`) and so tests can observe emits without a database NOTIFY. The
 * default wires the real events service, so CLI and web both get live updates.
 */
export type AgentEmitter = (event: AppendEventInput) => Promise<unknown>

/**
 * Default model when a session doesn't pin one. Resolved from
 * `SKYLARK_DEFAULT_MODEL`, falling back to the strong hosted default
 * (`claude-sonnet-5`). Every model name is a gateway name — what serves it is
 * decided in the gateway's admin UI. Read once at boot; hoist sets the env
 * before `npm run dev` starts. Pin per session / per agent to override.
 */
export const DEFAULT_MODEL = defaultModelRef()

/**
 * The config a session boots with when it has no agentUserId — identical to
 * the original hardcoded behavior: full coding tools, CLAUDE.md and the
 * repo's skills, no extensions, no system-prompt override. Keeps every
 * unattributed session (and a bare CLI `new`) booting exactly as it always
 * did.
 */
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  systemPrompt: null,
  tools: null,
  readContextFiles: true,
  useRepoSkills: true,
  extensionPaths: [],
  model: null,
}

/**
 * What a turn call produced. `queued` means the text was folded into a turn
 * already in flight (followUp) — no messages belong to THIS call; the running
 * turn's eventual result covers it. Explicit, because "queued" and "completed
 * with no text" must not look alike to callers deciding whether to post a
 * reply.
 */
export type TurnResult =
  | { queued: true }
  | { queued: false; messages: AgentMessage[] }

/**
 * Anything that can run an agent turn — the minimal slice other services drive
 * the runtime through, so each can declare a fake of just this. The real
 * `AgentRuntime` satisfies it structurally; the chat and issues orchestrators
 * build their runtime dependency on top of it.
 */
export interface RunsTurns {
  runTurn(
    sessionId: string,
    text: string,
    onEvent?: (event: AgentSessionEvent) => void,
  ): Promise<TurnResult>
}

/**
 * The slice of pi.dev's AgentSession the runtime drives. Narrowing to this makes
 * the runtime testable with a fake — the real createAgentSession result
 * satisfies it structurally.
 */
export interface PiSession {
  readonly messages: AgentMessage[]
  readonly isStreaming: boolean
  readonly agent: { state: { messages: AgentMessage[] } }
  subscribe(listener: (event: AgentSessionEvent) => void): () => void
  prompt(text: string): Promise<void>
  followUp(text: string): Promise<void>
  abort(): Promise<void>
  dispose(): void
}

/**
 * Boots a live pi.dev session for an agent config in a given working
 * directory. Config-driven: the runtime resolves a session's config (off its
 * agentUserId, and its registered extensions) and hands the factory
 * everything it needs. A fake stands in for tests; the real one
 * (`createPiSession`) is the live Claude wiring.
 */
export type SessionFactory = (
  config: AgentConfig,
  cwd: string,
  /** The session's pinned model; the config's model override wins if set. */
  model: string,
  /** Extra tools to register on the session (e.g. the per-session `background` tool). */
  customTools?: ToolDefinition[],
) => Promise<PiSession>

/* v8 ignore start -- live pi.dev/Claude wiring, exercised by the CLI not units */
/**
 * The real session factory: a live pi.dev agent talking to Claude, configured
 * by an agent's config. The pure config→options mapping lives in
 * session-config.ts (`resolveSessionOptions`) and is unit-tested; here we only
 * feed those options to pi's resource loader and `createAgentSession`. No file
 * persistence — pi's SessionManager is in-memory because Postgres is our
 * source of truth.
 *
 * Per-session `cwd`. Every pi tool (bash/read/edit/write) operates relative to
 * the `cwd` passed here, NOT process.cwd() — verified in the SDK and in
 * runtime-cwd.test.ts. That's what lets M3 run several builders in-process on
 * different git worktrees without collision.
 *
 * Auto-compaction is ON. A long builder session will overflow the context
 * window otherwise. Compaction rewrites the in-memory transcript in place
 * (collapsing a prefix into a summary), but the durable Postgres log stays the
 * full, append-only history: the runtime flushes the pre-compaction transcript
 * on `compaction_start` and rebases its baseline on `compaction_end` (see
 * `ensureEntry`), so the summary is never persisted and no message is lost.
 *
 * The config decides: tools, system prompt, whether to feed CLAUDE.md,
 * whether to load the repo's skills, and which extensions to load. Extensions
 * are pi.dev's answer to the human's Claude Code hooks (build-gates mirrors the
 * commit/landing/session-start gates), wired via additionalExtensionPaths.
 */
export const createPiSession: SessionFactory = async (
  config,
  cwd,
  model,
  customTools,
) => {
  const options = resolveSessionOptions(config, cwd)

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.loader.cwd,
    agentDir: getAgentDir(),
    noSkills: options.loader.noSkills,
    noContextFiles: options.loader.noContextFiles,
    additionalSkillPaths: options.loader.additionalSkillPaths,
    additionalExtensionPaths: options.loader.additionalExtensionPaths,
    systemPrompt: options.loader.systemPrompt ?? undefined,
    agentsFilesOverride: (base) => ({
      agentsFiles: [...base.agentsFiles, ...options.loader.contextFiles],
    }),
  })
  await resourceLoader.reload()

  // Every model resolves to the LiteLLM gateway; register its key with pi's
  // auth store so the OpenAI client authenticates. Provider keys (Anthropic,
  // OpenAI, …) never reach the app — they live in .env and are read by the
  // gateway container alone.
  const authStorage = AuthStorage.create()
  authStorage.setRuntimeApiKey('litellm', gatewayApiKey())

  const { session } = await createAgentSession({
    model: resolveModel(options.model ?? model),
    modelRegistry: ModelRegistry.create(authStorage),
    sessionManager: SessionManager.inMemory(),
    cwd: options.session.cwd,
    tools: options.session.tools,
    customTools,
    resourceLoader,
  })
  session.setAutoCompactionEnabled(true)
  return session
}
/* v8 ignore stop */

interface Entry {
  session: PiSession
  /** How many messages of session.messages are already durable in Postgres. */
  persistedCount: number
  /** Serializes DB writes so turn-boundary flushes never race. */
  persistChain: Promise<void>
  /**
   * Accumulates messages flushed during the current turn. Reset at the start
   * of each turn; returned at the end.
   */
  currentTurnMessages: AgentMessage[]
}

/**
 * Drives pi.dev sessions while keeping Postgres the source of truth.
 *
 * Each live session is ephemeral and rebuilt from stored messages. We persist
 * the new tail of the transcript at every turn boundary (`turn_end`/`agent_end`),
 * so a crash loses at most the in-flight turn. The registry is per-process: it's
 * what lets a long-lived host (the web server) queue into and cancel a running
 * turn. A short-lived CLI invocation just boots, runs one turn, and disposes.
 */
export function createAgentRuntime(deps: {
  db: Database
  factory: SessionFactory
  /** How turns announce themselves to the ship's log. Defaults to the real bus. */
  emit?: AgentEmitter
  /** How background jobs spawn processes. Defaults to a real shell child. */
  spawn?: SpawnFn
  /**
   * Loads a named agent's persistent memory at session boot (see memory.ts).
   * Omitted → sessions boot on their config alone.
   */
  memory?: AgentMemoryLoader
}) {
  const { db, factory } = deps

  // Background jobs let an agent hand off a long wait (CI, a slow build) and end
  // its turn; when the job finishes we re-invoke the session with the result.
  // `runTurn` is referenced before its declaration but only CALLED later (on a
  // job's completion), by which point the agent has ended its turn and the
  // session is idle, so the resume prompts cleanly.
  const jobs = createBackgroundJobs({
    spawn: deps.spawn ?? defaultSpawn,
    /* v8 ignore start -- live bridge: fires only when a real background job
       completes through a real session; runTurn itself is unit-tested */
    resume: (sessionId, message) => {
      void runTurn(sessionId, message).catch((err: unknown) => {
        console.error(`background resume ${sessionId}: ${errorMessage(err)}`)
      })
    },
    /* v8 ignore stop */
  })
  const emit: AgentEmitter = deps.emit ?? ((event) => emitEvent(db, event))
  const registry = new Map<string, Entry>()

  /**
   * Announce something on the ship's log, scoped to the session. Emission is
   * fire-and-forget and swallows its own errors: a turn's durability lives in
   * Postgres (the append already happened), so a broken ship's log must never
   * fail or stall a turn.
   */
  function safeEmit(sessionId: string, type: string, payload: unknown): void {
    void Promise.resolve()
      .then(() =>
        emit({
          type,
          source: 'agent',
          topic: sessionTopic(sessionId),
          audience: 'members',
          payload,
        }),
      )
      .catch((err: unknown) => {
        console.error(`agent emit ${type} failed: ${errorMessage(err)}`)
      })
  }

  /** Set the stored status and announce the change on the ship's log. */
  async function announceStatus(
    sessionId: string,
    status: SessionStatus,
    error?: string,
  ): Promise<void> {
    await setStatus(db, sessionId, status, error)
    safeEmit(sessionId, 'agent.status', { status, error: error ?? null })
  }

  /**
   * Append the new tail of `snapshot` (everything past persistedCount) to
   * Postgres, in order, then advance persistedCount. Each durable message is
   * announced on the ship's log so subscribers (the web chat) update live.
   *
   * `snapshot` is captured by the caller, not re-read here — that's what makes
   * compaction safe. The durable log is append-only and monotonic: a message is
   * written once, in order, and never rewritten, even though pi.dev's in-memory
   * transcript IS rewritten by compaction (see `onCompactionStart`).
   *
   * Returns the messages that were flushed (the new tail).
   */
  async function flushSnapshot(
    sessionId: string,
    entry: Entry,
    snapshot: AgentMessage[],
  ): Promise<AgentMessage[]> {
    const flushed: AgentMessage[] = []
    for (let i = entry.persistedCount; i < snapshot.length; i++) {
      const message = snapshot[i]
      await appendMessage(db, { sessionId, role: message.role, message })
      safeEmit(sessionId, 'agent.message', { role: message.role })
      flushed.push(message)
    }
    entry.persistedCount = snapshot.length
    return flushed
  }

  /** Flush whatever the live transcript currently holds (turn-boundary case). */
  function flush(sessionId: string, entry: Entry): Promise<AgentMessage[]> {
    return flushSnapshot(sessionId, entry, entry.session.messages)
  }

  /**
   * Resolve the config a session boots with into an `AgentConfig` (its
   * extension ids turned into repo-relative paths). A session with no
   * agentUserId — unattributed, or a plain CLI `new` — falls back to the
   * built-in default: full coding tools, CLAUDE.md + repo skills, no
   * extensions. That keeps every unattributed session booting exactly as
   * before agent config existed.
   */
  async function resolveAgentConfig(
    agentUserId: string | null,
  ): Promise<AgentConfig> {
    if (!agentUserId) return DEFAULT_AGENT_CONFIG
    const user = await getUserById(db, agentUserId)
    /* v8 ignore next -- unreachable behind the agent_sessions.agent_user_id FK; defensive only */
    if (!user) throw new Error(`No such user: ${agentUserId}`)
    return {
      systemPrompt: user.systemPrompt,
      tools: user.tools,
      readContextFiles: user.readContextFiles,
      useRepoSkills: user.useRepoSkills,
      extensionPaths: await resolveExtensionPaths(db, user.extensionIds),
      model: user.model,
    }
  }

  /** Boot a fresh ephemeral session seeded from stored history, or reuse a live one. */
  async function ensureEntry(sessionId: string): Promise<Entry> {
    const existing = registry.get(sessionId)
    if (existing) return existing

    const row = await getSession(db, sessionId)
    if (!row) throw new Error(`No such session: ${sessionId}`)

    let config = await resolveAgentConfig(row.agentUserId)
    // A session acting as a named agent boots with that agent's persistent
    // memory folded into its system prompt (identity, index, how to update).
    if (row.agentUserId && deps.memory) {
      const memory = await deps.memory(row.agentUserId)
      if (memory) config = withAgentMemory(config, memory)
    }
    const cwd = row.cwd ?? process.cwd()
    const session = await factory(config, cwd, row.model, [
      createBackgroundTool(sessionId, cwd, jobs),
    ])
    const history = (await getMessages(db, sessionId)).map(
      (r) => r.message as AgentMessage,
    )
    session.agent.state.messages = history

    const entry: Entry = {
      session,
      persistedCount: history.length,
      persistChain: Promise.resolve(),
      currentTurnMessages: [],
    }
    session.subscribe((event) => {
      if (event.type === 'turn_end' || event.type === 'agent_end') {
        entry.persistChain = entry.persistChain.then(async () => {
          const flushed = await flush(sessionId, entry)
          entry.currentTurnMessages.push(...flushed)
        })
      } else if (event.type === 'compaction_start') {
        // Compaction is about to rewrite the in-memory transcript in place
        // (collapsing a prefix into a summary). Snapshot the FULL transcript
        // NOW, synchronously, before pi reassigns the array, and flush that —
        // so every pre-compaction message lands in the durable log. We snapshot
        // a shallow copy because the array reference is reused/reassigned.
        const snapshot = [...entry.session.messages]
        entry.persistChain = entry.persistChain.then(async () => {
          const flushed = await flushSnapshot(sessionId, entry, snapshot)
          entry.currentTurnMessages.push(...flushed)
        })
      } else if (event.type === 'compaction_end') {
        // The transcript is now [summary, ...recentSuffix] — shorter, and the
        // synthetic summary at the head is NOT history. Rebase persistedCount
        // onto the new length so (a) the summary and the already-durable suffix
        // are never (re)persisted, and (b) post-compaction appends continue to
        // grow the durable log monotonically from here.
        //
        // Read the length NOW, synchronously, at the moment compaction ends —
        // not inside the deferred .then. By the time the chain runs, the agent
        // may already have appended post-compaction messages, and we must not
        // count those as already-persisted. We still enqueue the rebase on the
        // chain so it lands after the compaction_start flush.
        const rebasedCount = entry.session.messages.length
        entry.persistChain = entry.persistChain.then(() => {
          entry.persistedCount = rebasedCount
        })
      }
    })
    registry.set(sessionId, entry)
    return entry
  }

  /**
   * Send a user message to a session and report what happened.
   * - If a turn is already in flight, the message is queued (followUp) and
   *   delivered after the current turn — this returns `{ queued: true }`
   *   immediately; the in-flight turn's result covers the queued text.
   * - Otherwise the session boots from history (if not already live) and the
   *   turn runs to completion, persisting at each turn boundary and returning
   *   `{ queued: false, messages }` — the agent messages durably appended
   *   this turn.
   *
   * `onEvent` streams live events (deltas, tool calls) to the caller — the CLI
   * prints them; the web layer relays them.
   *
   * Robust to compaction: the returned messages are what flush actually
   * appended to Postgres during this turn, not an index slice of the in-memory
   * array (which gets rewritten by compaction).
   */
  async function runTurn(
    sessionId: string,
    text: string,
    onEvent?: (event: AgentSessionEvent) => void,
  ): Promise<TurnResult> {
    const entry = await ensureEntry(sessionId)
    const unsub = onEvent ? entry.session.subscribe(onEvent) : undefined

    try {
      if (entry.session.isStreaming) {
        await entry.session.followUp(text)
        return { queued: true }
      }
      // Reset the accumulator for this turn.
      entry.currentTurnMessages = []
      await announceStatus(sessionId, 'running')
      try {
        await entry.session.prompt(text)
        await entry.persistChain
        await announceStatus(sessionId, 'idle')
        // Return a copy so callers can't mutate the runtime's internal state.
        return { queued: false, messages: [...entry.currentTurnMessages] }
      } catch (err) {
        // A turn (or a flush on its persistChain) failed. Drop the live entry:
        // its persistChain may now be permanently rejected, and reusing it would
        // wedge the session forever in a long-lived host (the next runTurn would
        // `await` the dead chain and rethrow without ever running). Disposing
        // forces the next turn to rebuild a clean session from the durable log —
        // the same crash-recovery path any other process would take.
        await entry.persistChain.catch(() => undefined)
        dispose(sessionId)
        await announceStatus(sessionId, 'error', errorMessage(err))
        throw err
      }
    } finally {
      unsub?.()
    }
  }

  /**
   * Cancel a running turn. Aborts the live session if this process owns it, then
   * forces the stored status back to idle (so a row stranded on "running" by a
   * crash in another process is recoverable from anywhere).
   */
  async function cancel(sessionId: string): Promise<void> {
    jobs.cancelForSession(sessionId)
    const entry = registry.get(sessionId)
    if (entry) {
      await entry.session.abort()
      await entry.persistChain
    }
    await announceStatus(sessionId, 'idle')
  }

  /** Drop a live session, releasing it from the registry. */
  function dispose(sessionId: string): void {
    jobs.cancelForSession(sessionId)
    const entry = registry.get(sessionId)
    if (!entry) return
    entry.session.dispose()
    registry.delete(sessionId)
  }

  function disposeAll(): void {
    for (const id of [...registry.keys()]) dispose(id)
  }

  return { runTurn, cancel, dispose, disposeAll }
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>
