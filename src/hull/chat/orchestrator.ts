import { uuidv7 } from '@earendil-works/pi-agent-core'

import type { Database } from '@hull/db/client'
import { notifyOnly } from '@hull/events/bus'
import { MEMBERS_AUDIENCE } from '@hull/events/service'
import { createSession } from '@hull/agent/service'
import { DEFAULT_MODEL, type RunsTurns } from '@hull/agent/runtime'
import { toChatItems } from '@hull/agent/transcript'
import { chatProgressLine } from '@hull/agent/progress'

import {
  addMessage,
  chatScope,
  formatTranscript,
  listMembers,
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

  return { respond, reply }
}

export type ChatOrchestrator = ReturnType<typeof createChatOrchestrator>
