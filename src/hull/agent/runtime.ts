import type { AgentMessage } from '@earendil-works/pi-agent-core'
import {
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { getModels } from '@earendil-works/pi-ai'

import type { Database } from '@hull/db/client'
import { emitEvent } from '@hull/events/bus'
import { errorMessage } from '@hull/lib/errors'

import { readContextFiles, skillDirs } from './config'
import {
  appendMessage,
  getMessages,
  getSession,
  setStatus,
  type SessionStatus,
} from './service'

// `setStatus` is wrapped by `announceStatus` below (which also emits to the
// ship's log); the runtime never sets status without announcing it.

/**
 * How the runtime announces what's happening to the ship's log. Decoupled
 * behind this type so a failed emit never breaks a turn (see `safeEmit`) and so
 * tests can observe emits without a database NOTIFY. The default wires the real
 * events service, giving both the CLI and the web live chat updates for free.
 */
export type AgentEmitter = (event: {
  type: string
  source: string
  scope: string
  payload: unknown
}) => Promise<unknown>

/** The scope every event for a session is published under. */
export function sessionScope(sessionId: string): string {
  return `session:${sessionId}`
}

/** Default model when a session doesn't pin one. Anthropic only, for now. */
export const DEFAULT_MODEL = 'claude-sonnet-4-5'

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

export type SessionFactory = (model: string) => Promise<PiSession>

/* v8 ignore start -- live pi.dev/Claude wiring, exercised by the CLI not units */
/** Resolve an Anthropic model id to a pi.dev model, or throw if unknown. */
function resolveModel(modelId: string) {
  const model = getModels('anthropic').find((m) => m.id === modelId)
  if (!model) throw new Error(`Unknown Anthropic model: ${modelId}`)
  return model
}

/**
 * The real session factory: a live pi.dev agent talking to Claude, with the
 * full coding toolset (read/bash/edit/write) operating on the ship's repo. No
 * file persistence — pi's own SessionManager is in-memory because Postgres is
 * our source of truth.
 *
 * Auto-compaction is disabled deliberately. Compaction rewrites the in-memory
 * transcript (summarizing earlier messages in place), which would break our
 * index-based, append-only persistence (see `flush`). Keeping it off means the
 * live transcript only ever grows by appends, so it stays in lockstep with the
 * durable log. The trade-off — a single boot can't exceed the context window —
 * is fine while sessions are short-lived and rebuilt from full history each
 * boot; context-window management that preserves the full log is future work.
 *
 * The agent shares the ship's config: CLAUDE.md and the same skills the human's
 * Claude Code session uses, fed in through pi.dev's resource loader (see
 * config.ts). Hooks are not shared — those are Claude Code harness shell-hooks
 * about the human's git flow; pi.dev's equivalent is TS extensions, which the
 * loader can take via additionalExtensionPaths when we want them.
 */
export const createPiSession: SessionFactory = async (model) => {
  const cwd = process.cwd()
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    additionalSkillPaths: skillDirs(cwd),
    agentsFilesOverride: (base) => ({
      agentsFiles: [...base.agentsFiles, ...readContextFiles(cwd)],
    }),
  })
  await resourceLoader.reload()

  const { session } = await createAgentSession({
    model: resolveModel(model),
    sessionManager: SessionManager.inMemory(),
    cwd,
    resourceLoader,
  })
  session.setAutoCompactionEnabled(false)
  return session
}
/* v8 ignore stop */

interface Entry {
  session: PiSession
  /** How many messages of session.messages are already durable in Postgres. */
  persistedCount: number
  /** Serializes DB writes so turn-boundary flushes never race. */
  persistChain: Promise<void>
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
}) {
  const { db, factory } = deps
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
          scope: sessionScope(sessionId),
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
   * Append every message past persistedCount to Postgres, in order. This is
   * append-only by index, which is correct only because the live transcript
   * never rewrites earlier entries — auto-compaction is disabled in
   * `createPiSession` precisely to uphold that. Each durable message is then
   * announced on the ship's log so subscribers (the web chat) update live.
   */
  async function flush(sessionId: string, entry: Entry): Promise<void> {
    const all = entry.session.messages
    for (let i = entry.persistedCount; i < all.length; i++) {
      const message = all[i]
      await appendMessage(db, { sessionId, role: message.role, message })
      safeEmit(sessionId, 'agent.message', { role: message.role })
    }
    entry.persistedCount = all.length
  }

  /** Boot a fresh ephemeral session seeded from stored history, or reuse a live one. */
  async function ensureEntry(sessionId: string): Promise<Entry> {
    const existing = registry.get(sessionId)
    if (existing) return existing

    const row = await getSession(db, sessionId)
    if (!row) throw new Error(`No such session: ${sessionId}`)

    const session = await factory(row.model)
    const history = (await getMessages(db, sessionId)).map(
      (r) => r.message as AgentMessage,
    )
    session.agent.state.messages = history

    const entry: Entry = {
      session,
      persistedCount: history.length,
      persistChain: Promise.resolve(),
    }
    session.subscribe((event) => {
      if (event.type === 'turn_end' || event.type === 'agent_end') {
        entry.persistChain = entry.persistChain.then(() =>
          flush(sessionId, entry),
        )
      }
    })
    registry.set(sessionId, entry)
    return entry
  }

  /**
   * Send a user message to a session.
   * - If a turn is already in flight, the message is queued (followUp) and
   *   delivered after the current turn — this returns immediately.
   * - Otherwise the session boots from history (if not already live) and the
   *   turn runs to completion, persisting at each turn boundary.
   *
   * `onEvent` streams live events (deltas, tool calls) to the caller — the CLI
   * prints them; the web layer relays them.
   */
  async function runTurn(
    sessionId: string,
    text: string,
    onEvent?: (event: AgentSessionEvent) => void,
  ): Promise<void> {
    const entry = await ensureEntry(sessionId)
    const unsub = onEvent ? entry.session.subscribe(onEvent) : undefined

    try {
      if (entry.session.isStreaming) {
        await entry.session.followUp(text)
        return
      }
      await announceStatus(sessionId, 'running')
      try {
        await entry.session.prompt(text)
        await entry.persistChain
        await announceStatus(sessionId, 'idle')
      } catch (err) {
        await entry.persistChain
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
    const entry = registry.get(sessionId)
    if (entry) {
      await entry.session.abort()
      await entry.persistChain
    }
    await announceStatus(sessionId, 'idle')
  }

  /** Drop a live session, releasing it from the registry. */
  function dispose(sessionId: string): void {
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
