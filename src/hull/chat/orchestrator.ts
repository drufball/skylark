import { uuidv7 } from '@earendil-works/pi-agent-core'

import type { Database } from '@hull/db/client'
import { notifyOnly, type NotifyPayload } from '@hull/events/bus'
import { getEventById, MEMBERS_AUDIENCE } from '@hull/events/service'
import { errorMessage } from '@hull/lib/errors'
import { createSession } from '@hull/agent/service'
import { DEFAULT_MODEL, type RunsTurns } from '@hull/agent/runtime'
import { toChatItems } from '@hull/agent/transcript'
import { chatProgressLine } from '@hull/agent/progress'

import {
  addMessage,
  CHAT_MESSAGE_POSTED,
  chatScope,
  formatTranscript,
  getMessage,
  listAllChats,
  listMembers,
  listMessages,
  messagesSinceAgent,
  setMemberSession,
  targetsForMessage,
} from './service'

/**
 * The chat orchestrator: when a human posts to a chat, it decides which agent
 * members should answer (1:1 → the agent always; group → only on @mention) and
 * drives each one's backing agent session to produce a reply, which it posts
 * back as a chat message authored by that agent.
 *
 * It reacts to the ship's log, not to an inline call: every posted message emits
 * a durable `chat.message_posted` event, and `handleBusNote` drives the reply
 * off the bus — the same path whether the message came from the web door or
 * (in future) another process, mirroring the issues orchestrator. `reconcile`
 * re-drives any human message left unanswered by a restart.
 *
 * The clean chat transcript and the agent's full tool-call transcript are two
 * surfaces over one conversation: we feed the agent the chat messages it hasn't
 * seen, run a turn, and lift only the assistant's *text* back into the chat —
 * thinking and tool calls stay in the agent session (visible in the Agents
 * view). While the turn runs we translate its events into `chat.agent_progress`
 * so the chat UI can show a live "working…" placeholder, replaced by the message
 * when the turn ends.
 *
 * The agent runtime is injected so the decision + reply flow is unit-tested
 * against PGlite with a fake runtime — no network, no real pi session.
 */

/** The slice of the agent runtime the chat orchestrator drives. */
export type ChatAgentRuntime = RunsTurns

/** Lift the assistant's text out of the messages a turn produced. */
export function assistantTextFrom(messages: unknown[]): string {
  return toChatItems(messages)
    .filter((item) => item.kind === 'assistant')
    .map((item) => item.text)
    .join('\n\n')
    .trim()
}

export interface ChatOrchestratorDeps {
  db: Database
  runtime: ChatAgentRuntime
}

export function createChatOrchestrator({ db, runtime }: ChatOrchestratorDeps) {
  /** Ensure the agent member has a backing session for this chat; return its id. */
  async function ensureSession(
    chatId: string,
    agent: {
      userId: string
      profileId: string | null
      sessionId: string | null
    },
  ): Promise<string> {
    if (agent.sessionId) return agent.sessionId
    const id = uuidv7()
    await createSession(db, {
      id,
      model: DEFAULT_MODEL,
      profileId: agent.profileId,
      agentUserId: agent.userId,
      // The session inherits this chat's visibility (members only).
      origin: chatScope(chatId),
    })
    await setMemberSession(db, chatId, agent.userId, id)
    return id
  }

  /** Emit one live progress line for the chat's "working…" placeholder. */
  function emitProgress(
    chatId: string,
    agentUserId: string,
    line: string,
  ): void {
    // Progress is transient UI — notify-only, not durable, not replayed. It
    // still carries the chat's topic + members audience so the SSE route gates
    // it exactly like a durable chat event (members-only, this chat's topic).
    notifyOnly(db, {
      type: 'chat.agent_progress',
      source: 'chat',
      topic: chatScope(chatId),
      audience: MEMBERS_AUDIENCE,
      payload: { chatId, agentUserId, line },
    })
  }

  /** Run one agent's reply: feed unseen messages, take a turn, post the text. */
  async function reply(chatId: string, agentUserId: string): Promise<void> {
    const members = await listMembers(db, chatId)
    const agent = members.find((m) => m.userId === agentUserId)
    if (!agent) return

    const sessionId = await ensureSession(chatId, agent)
    const unseen = await messagesSinceAgent(db, chatId, agentUserId)
    if (unseen.length === 0) return
    const prompt = formatTranscript(
      unseen.map((m) => ({ handle: m.authorHandle, body: m.body })),
    )

    // One "thinking…" up front, then a line per meaningful step — deduped, so a
    // turn writes a handful of durable progress events, never one per delta.
    let lastLine = 'thinking…'
    emitProgress(chatId, agentUserId, lastLine)
    const produced = await runtime.runTurn(sessionId, prompt, (event) => {
      const line = chatProgressLine(event)
      if (line && line !== lastLine) {
        lastLine = line
        emitProgress(chatId, agentUserId, line)
      }
    })

    const text = assistantTextFrom(produced)
    if (text) {
      await addMessage(db, {
        id: uuidv7(),
        chatId,
        authorId: agentUserId,
        body: text,
      })
    }
  }

  /**
   * React to a freshly-posted message: figure out which agents should answer
   * and run each reply. Agents answer in sequence (a small crew), each reply
   * landing as its own chat message + event.
   */
  async function respond(input: {
    chatId: string
    authorId: string
    body: string
  }): Promise<void> {
    const members = await listMembers(db, input.chatId)
    const targets = targetsForMessage({
      members,
      authorId: input.authorId,
      body: input.body,
    })
    for (const agentUserId of targets) {
      await reply(input.chatId, agentUserId)
    }
  }

  /**
   * The ship-log subscription handler: a `chat.message_posted` note arrived.
   * Read the full event by id (the note carries only {id,type,topic,audience}),
   * fetch the message it points at, and drive the reply. An agent-authored
   * message resolves to no targets (only a human triggers a reply), so the
   * agent's own reply event can't cascade into a loop. A bad payload or a
   * vanished message is dropped quietly — another ship's event must not sail
   * unchecked into the reply flow.
   */
  async function handleBusNote(note: NotifyPayload): Promise<void> {
    if (note.type !== CHAT_MESSAGE_POSTED) return
    const event = await getEventById(db, note.id)
    if (!event) return
    const payload = event.payload as {
      chatId?: unknown
      messageId?: unknown
      authorId?: unknown
    }
    if (
      typeof payload.chatId !== 'string' ||
      typeof payload.messageId !== 'string' ||
      typeof payload.authorId !== 'string'
    )
      return
    const message = await getMessage(db, payload.messageId)
    if (!message) return
    await respond({
      chatId: payload.chatId,
      authorId: payload.authorId,
      body: message.body,
    })
  }

  /**
   * Startup reconciliation: a `chat.message_posted` event is only delivered to
   * the bus subscription live, so a human message posted just before a restart
   * leaves an agent reply owed but undriven. For every chat, re-drive the reply
   * to its latest human message — `reply`'s "unseen since the agent" check makes
   * this idempotent, so a chat that's already caught up is left untouched.
   */
  async function reconcile(): Promise<void> {
    for (const chat of await listAllChats(db)) {
      await resumeChat(chat.id).catch((err: unknown) => {
        console.error(
          `chat reconcile ${chat.id} failed (continuing): ${errorMessage(err)}`,
        )
      })
    }
  }

  /** Re-drive the reply to a chat's most recent human message, if any. */
  async function resumeChat(chatId: string): Promise<void> {
    const [members, messages] = await Promise.all([
      listMembers(db, chatId),
      listMessages(db, chatId),
    ])
    const humanIds = new Set(
      members.filter((m) => m.type === 'human').map((m) => m.userId),
    )
    // messages are ascending by id, so the last human entry is the latest one.
    // We re-drive targeting off this single message; in the rare case a restart
    // lands between two rapid human posts whose @mentions differ, reconcile
    // picks targets from the later body. The reply *content* is always correct
    // (reply re-derives from messagesSinceAgent); only the who-answers decision
    // uses this body — an acceptable edge for a restart-recovery path.
    const lastHuman = messages.filter((m) => humanIds.has(m.authorId)).at(-1)
    if (!lastHuman) return
    await respond({
      chatId,
      authorId: lastHuman.authorId,
      body: lastHuman.body,
    })
  }

  return { respond, reply, handleBusNote, reconcile }
}

export type ChatOrchestrator = ReturnType<typeof createChatOrchestrator>
