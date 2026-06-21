import { uuidv7 } from '@earendil-works/pi-agent-core'
import { AuthStorage } from '@earendil-works/pi-coding-agent'
import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'
import { errorMessage } from '@hull/lib/errors'

import { defaultModelRef } from './models'
import { isHostedProvider, providersWithStatus } from './providers'
import { type AgentRuntime, DEFAULT_MODEL } from './runtime'
import { createServerRuntime } from './fake-session'
import {
  CHAT_PROFILE,
  getProfileByName,
  listExtensions,
  listProfiles,
  normalizeProfileInput,
  type ProfileInput,
  upsertProfile,
} from './profiles'
import {
  createSession,
  getMessages,
  getSession,
  listSessions,
  titleFromMessage,
} from './service'
import { toChatItems } from './transcript'

// The web doors onto the agent service. A turn is kicked off fire-and-forget on
// the server; the client polls the transcript and status. This works because
// Postgres is the source of truth — the request that starts a turn doesn't have
// to wait for it, and any later request reads the same durable state.

// One runtime per server process, created lazily on first server-side use. The
// registry must outlive individual requests so a turn can be queued into or
// cancelled. Lazy so this server-only wiring never runs in the client bundle.
let runtimeSingleton: AgentRuntime | undefined
function runtime(): AgentRuntime {
  runtimeSingleton ??= createServerRuntime(db)
  return runtimeSingleton
}

/**
 * Run a turn in the background, logging failures. The session row's error
 * status is recorded by runTurn itself (see runtime.ts); here we only keep the
 * floating promise from going unhandled.
 */
function fireTurn(sessionId: string, text: string): void {
  void runtime()
    .runTurn(sessionId, text)
    .catch((err: unknown) => {
      console.error(`agent turn ${sessionId} failed: ${errorMessage(err)}`)
    })
}

/** All sessions, newest activity first — the sidebar. */
export const listAgentSessions = createServerFn({ method: 'GET' }).handler(() =>
  listSessions(db),
)

/** A session's status plus its transcript as flat, view-ready items. */
export const getAgentChat = createServerFn({ method: 'GET' })
  .validator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }) => {
    const session = await getSession(db, sessionId)
    if (!session) return null
    const messages = await getMessages(db, sessionId)
    return { session, items: toChatItems(messages.map((m) => m.message)) }
  })

/**
 * Create a session from a first message and start its turn. Returns the id.
 *
 * The front-door chat boots the **chat** profile: read-only tools (read+bash),
 * no CLAUDE.md, no skills, no extensions. This deliberately removes file-write
 * from the front-door agent — it operates the ship's services and reads its
 * code, but to build or change something it files an issue (the intended end
 * state, "file an issue to build"). The builder profile, which can write, is
 * driven by M3's building agents, not this door. Falls back to the runtime
 * default if the chat profile hasn't been seeded (`npm run agent seed`).
 */
export const startAgentChat = createServerFn({ method: 'POST' })
  .validator((input: { text: string; model?: string }) => input)
  .handler(async ({ data }) => {
    const id = uuidv7()
    const chat = await getProfileByName(db, CHAT_PROFILE.name)
    await createSession(db, {
      id,
      model: data.model ?? DEFAULT_MODEL,
      title: titleFromMessage(data.text),
      profileId: chat?.id ?? null,
    })
    fireTurn(id, data.text)
    return { id }
  })

/** Send a message to an existing session (queued if a turn is in flight). */
export const sendAgentMessage = createServerFn({ method: 'POST' })
  .validator((input: { sessionId: string; text: string }) => input)
  .handler(({ data }) => {
    fireTurn(data.sessionId, data.text)
    return Promise.resolve({ ok: true })
  })

/** Cancel a running turn and force the session back to idle. */
export const cancelAgentChat = createServerFn({ method: 'POST' })
  .validator((sessionId: string) => sessionId)
  .handler(({ data: sessionId }) =>
    runtime()
      .cancel(sessionId)
      .then(() => ({ ok: true })),
  )

// --- Agent management (the Agents surface) ---------------------------------

/** Every profile, oldest first — the profiles list. */
export const listAgentProfiles = createServerFn({ method: 'GET' }).handler(() =>
  listProfiles(db),
)

/** Every registered extension — the options a profile picks from. */
export const listAgentExtensions = createServerFn({ method: 'GET' }).handler(
  () => listExtensions(db),
)

/**
 * Create a profile or update the one with the same name (idempotent by name, so
 * editing the chat/builder profile keeps its id and every session pointing at
 * it). The validator narrows the untrusted client input to a `ProfileInput`.
 */
export const saveAgentProfile = createServerFn({ method: 'POST' })
  .validator((input: ProfileInput) => normalizeProfileInput(input))
  .handler(({ data }) => upsertProfile(db, data))

// --- Model providers & keys (the Models surface) ---------------------------

/** The model a new session defaults to (the resolved SKYLARK_DEFAULT_MODEL). */
export const getDefaultModel = createServerFn({ method: 'GET' }).handler(() =>
  Promise.resolve({ ref: defaultModelRef() }),
)

/**
 * The hosted providers and whether each has a key configured. Auth lives in
 * pi.dev's own credential store (env var or `~/.pi/agent/auth.json`), the same
 * store the runtime reads when it boots a session — so a key added here is live
 * on the next turn.
 */
export const listModelProviders = createServerFn({ method: 'GET' }).handler(
  () => {
    const auth = AuthStorage.create()
    return Promise.resolve(
      providersWithStatus((id) => auth.getAuthStatus(id).configured),
    )
  },
)

/** Store an API key for a hosted provider. Rejects unknown providers / blanks. */
export const setProviderKey = createServerFn({ method: 'POST' })
  .validator((input: { provider: string; key: string }) => input)
  .handler(({ data }) => {
    if (!isHostedProvider(data.provider)) {
      throw new Error(`Unknown provider: ${data.provider}`)
    }
    const key = data.key.trim()
    if (!key) throw new Error('API key is empty')
    AuthStorage.create().set(data.provider, { type: 'api_key', key })
    return Promise.resolve({ ok: true })
  })

/** Remove a stored API key for a hosted provider. */
export const removeProviderKey = createServerFn({ method: 'POST' })
  .validator((provider: string) => provider)
  .handler(({ data: provider }) => {
    AuthStorage.create().remove(provider)
    return Promise.resolve({ ok: true })
  })
