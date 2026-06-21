import { uuidv7 } from '@earendil-works/pi-agent-core'
import { AuthStorage } from '@earendil-works/pi-coding-agent'
import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'
import { canSeeSession } from '@hull/access/visibility'
import { errorMessage } from '@hull/lib/errors'
import { currentActor, withCurrentActor } from '@hull/users/actor'

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

/**
 * May the current actor see this session? A session inherits its origin's
 * visibility (an issue's builder session is public; a chat's backing session
 * follows that chat's membership; a bare/monitor session is crew-visible) —
 * resolved by the same `canSeeTopic` gate the SSE stream uses, so the Agents
 * monitor can't read a private chat's transcript the stream already hides.
 */
async function actorCanSeeSession(sessionId: string): Promise<boolean> {
  const actor = await currentActor()
  return canSeeSession(db, actor.id, sessionId)
}

/** Refuse an action on a session the actor can't see. */
function notAllowed(): never {
  throw new Error('not allowed')
}

/** Sessions the current actor may see, newest activity first — the sidebar. */
export const listAgentSessions = createServerFn({ method: 'GET' }).handler(() =>
  // RLS filters the list to what this actor may see — no per-session probe.
  withCurrentActor((tx) => listSessions(tx)),
)

/** A session's status plus its transcript — null if the actor may not see it. */
export const getAgentChat = createServerFn({ method: 'GET' })
  .validator((sessionId: string) => sessionId)
  .handler(({ data: sessionId }) =>
    withCurrentActor(async (tx) => {
      const session = await getSession(tx, sessionId)
      if (!session) return null // RLS hid it (not visible) or it doesn't exist
      const messages = await getMessages(tx, sessionId)
      return { session, items: toChatItems(messages.map((m) => m.message)) }
    }),
  )

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
  .handler(async ({ data }) => {
    // Can't poke a session you can't see — e.g. a private chat's backing agent.
    if (!(await actorCanSeeSession(data.sessionId))) notAllowed()
    fireTurn(data.sessionId, data.text)
    return { ok: true }
  })

/** Cancel a running turn and force the session back to idle. */
export const cancelAgentChat = createServerFn({ method: 'POST' })
  .validator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }) => {
    if (!(await actorCanSeeSession(sessionId))) notAllowed()
    await runtime().cancel(sessionId)
    return { ok: true }
  })

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
