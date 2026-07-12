import { uuidv7 } from '@earendil-works/pi-agent-core'

import type { Database } from '@hull/db/client'
import { notifyOnly, type NotifyPayload } from '@hull/events/bus'
import {
  getEventById,
  MEMBERS_AUDIENCE,
  trustedEvent,
} from '@hull/events/service'
import { errorMessage } from '@hull/lib/errors'
import { actorCmd } from '@hull/lib/actor-cmd'
import { createSession, findAgentSessionByTitle } from '@hull/agent/service'
import { getUserById } from '@hull/users/service'
import { DEFAULT_MODEL, type RunsTurns } from '@hull/agent/runtime'
import { toChatItems } from '@hull/agent/transcript'
import { chatProgressLine } from '@hull/agent/progress'

import {
  addMessage,
  formatTranscript,
  getMessage,
  listAllChats,
  listMembers,
  listMessages,
  messagesSinceAgent,
  setMemberSession,
  targetsForMessage,
  type ChatMemberView,
} from './service'
import {
  CHAT_AGENT_PROGRESS,
  CHAT_MESSAGE_POSTED,
  chatTopic,
  type ChatAgentProgressPayload,
} from './topic'

/**
 * The chat orchestrator: when a human posts to a chat, it decides which agent
 * members should answer (1:1 → the agent always; group → only on @mention) and
 * drives each one's backing agent session to produce a reply, which it posts
 * back as a chat message authored by that agent.
 *
 * It reacts to the ship's log, not to an inline call: every posted message emits
 * a durable `chat.message_posted` event, and `handleBusNote` drives the reply
 * off the bus — the same path whether the message came from the web door or
 * another process (the chat CLI), mirroring the issues orchestrator. `reconcile`
 * re-drives any human message left unanswered by a restart.
 *
 * `wake` is the other entrance: when the waker delivers an agent's unread
 * notifications, the orchestrator drives one turn on the agent's own INBOX
 * session — a bare session owned by the agent, bound to no chat, cwd the repo
 * root. The turn is briefed on the updates and told to decide for itself which
 * conversation they belong in, using the chat CLI to search its chats and post
 * there; nothing is posted on the agent's behalf.
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

/**
 * The situational header every agent turn opens with: which chat this is, who
 * the agent is, and the concrete command for filing work. Repeated per turn
 * (cheap, and it survives session compaction).
 */
export function turnContext(input: {
  chatId: string
  handle: string
  userId: string
}): string {
  const cmd = actorCmd(
    input.userId,
    'issue',
    'new',
    '"<title>"',
    '--body',
    '"<details>"',
  )
  return `[You are @${input.handle} in chat ${input.chatId}.
To file work for the ship, use bash:
  ${cmd}
As filed work moves you will be woken on your own inbox session with the
updates — post follow-ups back to this chat with the chat CLI
(\`npm run chat -- post ${input.chatId} "<update>"\`).]`
}

/**
 * The well-known title of an agent's inbox session — the find-or-create key.
 * Session titles are set only at creation and never rewritten (see the agent
 * service), so looking up (agentUserId, INBOX_SESSION_TITLE) always converges
 * on the same session.
 */
export const INBOX_SESSION_TITLE = 'Inbox'

/**
 * The situational header a wake turn opens with: who the agent is, that this
 * is its inbox (not a chat), and the concrete chat-CLI commands for routing
 * an update to the conversation it belongs in.
 */
export function inboxTurnContext(input: {
  handle: string
  userId: string
}): string {
  const listCmd = actorCmd(input.userId, 'chat', 'list')
  const showCmd = actorCmd(input.userId, 'chat', 'show', '<chatId>')
  const postCmd = actorCmd(
    input.userId,
    'chat',
    'post',
    '<chatId>',
    '"<update>"',
  )
  return `[You are @${input.handle}. This is your inbox session — updates on
work you're watching land here; it is not a chat. Your only job is to decide
which conversation each update belongs in: search your chats for where the
work was planned, use bash:
  ${listCmd}
  ${showCmd}
and post a concise update there with:
  ${postCmd}
Do not investigate, debug, or do the work yourself — another session owns it;
the crew in the chat you post to decides any follow-up. If no chat fits, do
nothing.]`
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
      sessionId: string | null
    },
  ): Promise<string> {
    if (agent.sessionId) return agent.sessionId
    const id = uuidv7()
    await createSession(db, {
      id,
      // The ship default (the agent's own model override still wins at boot).
      model: DEFAULT_MODEL,
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
    const payload: ChatAgentProgressPayload = { chatId, agentUserId, line }
    notifyOnly({
      type: CHAT_AGENT_PROGRESS,
      source: 'chat',
      topic: chatTopic(chatId),
      audience: MEMBERS_AUDIENCE,
      payload,
    })
  }

  /**
   * Drive one turn of an agent member's backing session with `prompt`, showing
   * live progress in the chat and posting the assistant's text back as the
   * agent's message. The shared spine of `reply` (a human spoke) and `wake`
   * (a notification arrived) — the two differ only in what the prompt says.
   */
  async function driveTurn(
    chatId: string,
    agent: ChatMemberView,
    prompt: string,
  ): Promise<void> {
    const sessionId = await ensureSession(chatId, agent)

    // One "thinking…" up front, then a line per meaningful step — deduped, so a
    // turn writes a handful of durable progress events, never one per delta.
    let lastLine = 'thinking…'
    emitProgress(chatId, agent.userId, lastLine)
    const result = await runtime.runTurn(sessionId, prompt, (event) => {
      const line = chatProgressLine(event)
      if (line && line !== lastLine) {
        lastLine = line
        emitProgress(chatId, agent.userId, line)
      }
    })

    // Queued: the prompt was folded into a turn already in flight on this
    // session, whose eventual reply covers it — post nothing here, or the
    // agent would double-speak (and an empty result is NOT "the agent had
    // nothing to say").
    if (result.queued) return

    const text = assistantTextFrom(result.messages)
    if (text) {
      await addMessage(db, {
        id: uuidv7(),
        chatId,
        authorId: agent.userId,
        body: text,
      })
    }
  }

  /** Run one agent's reply: feed unseen messages, take a turn, post the text. */
  async function reply(chatId: string, agentUserId: string): Promise<void> {
    const members = await listMembers(db, chatId)
    const agent = members.find((m) => m.userId === agentUserId)
    if (!agent) return

    const unseen = await messagesSinceAgent(db, chatId, agentUserId)
    if (unseen.length === 0) return
    const prompt = `${turnContext({
      chatId,
      handle: agent.handle,
      userId: agent.userId,
    })}\n\n${formatTranscript(
      unseen.map((m) => ({ handle: m.authorHandle, body: m.body })),
    )}`
    await driveTurn(chatId, agent, prompt)
  }

  /**
   * The agent's inbox session: a bare session the agent owns — bound to no
   * chat, cwd the repo root (so the ship's CLIs work) — found by its
   * well-known title or created on first wake. The waker serializes wakes per
   * agent (one in flight, never two), so find-or-create doesn't race with
   * itself in this process.
   */
  async function ensureInboxSession(agent: { id: string }): Promise<string> {
    const existing = await findAgentSessionByTitle(
      db,
      agent.id,
      INBOX_SESSION_TITLE,
    )
    if (existing) return existing.id
    const id = uuidv7()
    await createSession(db, {
      id,
      // The ship default (an agent's own model override still wins at boot).
      model: DEFAULT_MODEL,
      title: INBOX_SESSION_TITLE,
      agentUserId: agent.id,
      // cwd omitted → repo root: the wake turn drives `npm run chat` etc.
    })
    return id
  }

  /**
   * Wake an agent with a briefing (the waker composes it): run one turn on the
   * agent's own inbox session. The turn's instructions (inboxTurnContext) tell
   * the agent to route the update itself — find the chat where the work was
   * planned via the chat CLI and post there — so nothing is posted on its
   * behalf; the assistant text stays in the session (the Agents view).
   * A failed turn rejects, which is what keeps the waker's batch unread for a
   * retry. Humans are never woken — their inbox has the bell.
   */
  async function wake(agentUserId: string, briefing: string): Promise<void> {
    const agent = await getUserById(db, agentUserId)
    if (agent?.type !== 'agent') return

    const sessionId = await ensureInboxSession(agent)
    const prompt = `${inboxTurnContext({
      handle: agent.handle,
      userId: agent.id,
    })}\n\n${briefing}`
    await runtime.runTurn(sessionId, prompt)
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
    // The envelope must agree with the payload: only chat's own event, on the
    // very chat the payload names, may drive a reply into that chat.
    if (
      !trustedEvent(event, {
        source: 'chat',
        topic: chatTopic(payload.chatId),
      })
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

  return { respond, reply, wake, handleBusNote, reconcile }
}

export type ChatOrchestrator = ReturnType<typeof createChatOrchestrator>
