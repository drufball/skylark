import { uuidv7 } from '@earendil-works/pi-agent-core'
import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'
import { errorMessage } from '@hull/lib/errors'

import {
  type AgentRuntime,
  createAgentRuntime,
  createPiSession,
  DEFAULT_MODEL,
} from './runtime'
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
  runtimeSingleton ??= createAgentRuntime({ db, factory: createPiSession })
  return runtimeSingleton
}

/** Run a turn in the background, recording failures on the session row. */
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

/** Create a session from a first message and start its turn. Returns the id. */
export const startAgentChat = createServerFn({ method: 'POST' })
  .validator((input: { text: string; model?: string }) => input)
  .handler(async ({ data }) => {
    const id = uuidv7()
    await createSession(db, {
      id,
      model: data.model ?? DEFAULT_MODEL,
      title: titleFromMessage(data.text),
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
