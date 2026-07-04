import { uuidv7 } from '@earendil-works/pi-agent-core'
import { createServerFn } from '@tanstack/react-start'

import { db, systemDb } from '@hull/db/client'
import { canSeeTopic } from '@hull/access/visibility'
import { errorMessage } from '@hull/lib/errors'
import { currentActor, withCurrentActor } from '@hull/users/actor'

import {
  defaultModelRef,
  gatewayApiKey,
  gatewayBaseUrl,
  parseGatewayModels,
} from './models'
import { type AgentRuntime, DEFAULT_MODEL } from './runtime'
import { sessionTopic } from './topic'
import { createServerRuntime } from './server-runtime'
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
//
// Two access patterns live here on purpose, not as an unfinished migration:
// the READ doors (listAgentSessions/getAgentChat) run under `withCurrentActor`
// and let RLS filter — the policy is the gate. The ACTION doors (send/cancel)
// instead probe with `canSeeTopic` (the same unified gate the SSE stream uses,
// via the session's topic) and then act, because the effect they guard is a
// RUNTIME call (fire/cancel a turn), not a DB write — so there's no insert for a
// WITH CHECK policy to gate.

// One runtime per server process, created lazily on first server-side use. The
// registry must outlive individual requests so a turn can be queued into or
// cancelled. Lazy so this server-only wiring never runs in the client bundle.
// It runs on `systemDb`: persisting a turn's transcript is fixed plumbing (it
// writes the one session it's running), not an LLM-driven read of arbitrary
// rows — and a chat-backing session's writes would otherwise fail closed under
// app_user with no actor.
let runtimeSingleton: AgentRuntime | undefined
function runtime(): AgentRuntime {
  runtimeSingleton ??= createServerRuntime(systemDb)
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
  // The same unified gate the SSE stream uses, via the session's topic — no
  // bespoke per-door check.
  return canSeeTopic(db, actor.id, sessionTopic(sessionId))
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
 *
 * @public — forward-built door, not yet wired to a route. Kept intentionally;
 * knip's unused-export gate respects @public. To be wired by the user-management
 * UI work (see board issue).
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

// --- Models (the gateway surface) -------------------------------------------

/** The model a new session defaults to (the resolved SKYLARK_DEFAULT_MODEL). */
export const getDefaultModel = createServerFn({ method: 'GET' }).handler(() =>
  Promise.resolve({ ref: defaultModelRef() }),
)

/** What the gateway probe reports: reachable + the model names it serves. */
export interface GatewayModels {
  ok: boolean
  models: string[]
}

/* v8 ignore start -- live HTTP edge to the gateway; parseGatewayModels is the
   unit-tested part */
/**
 * The models the LiteLLM gateway serves (`GET /v1/models`), best-effort: a
 * gateway that's down or misconfigured reads as `ok: false` with no models —
 * the Models page renders that as guidance, never an error. The short timeout
 * keeps a down gateway from stalling page loads.
 */
export const listGatewayModels = createServerFn({ method: 'GET' }).handler(
  async (): Promise<GatewayModels> => {
    try {
      const res = await fetch(`${gatewayBaseUrl()}/models`, {
        headers: { authorization: `Bearer ${gatewayApiKey()}` },
        signal: AbortSignal.timeout(1500),
      })
      if (!res.ok) return { ok: false, models: [] }
      return { ok: true, models: parseGatewayModels(await res.json()) }
    } catch {
      return { ok: false, models: [] }
    }
  },
)
/* v8 ignore stop */
