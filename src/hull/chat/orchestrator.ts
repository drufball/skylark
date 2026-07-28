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
import { chatProgressLine } from '@hull/agent/progress'

import { chatDocsDir } from './docs'
import {
  formatTranscript,
  getMessage,
  listAllChats,
  listCanvasPages,
  listChatViewers,
  listMembers,
  listMessages,
  messagesSinceAgent,
  setMemberProgress,
  setMemberSeen,
  setMemberSession,
  targetsForMessage,
  type ChatMemberView,
  type ChatViewerView,
} from './service'
import {
  CHAT_AGENT_PROGRESS,
  CHAT_MESSAGE_POSTED,
  chatTopic,
  type ChatAgentProgressPayload,
} from './topic'

/**
 * The chat orchestrator: **dispatch, not ventriloquism.** When a human posts to
 * a chat it decides which agent members should answer (1:1 → the agent always;
 * group → only on @mention), feeds each one the messages it hasn't read, and
 * runs a turn. It does NOT put words in the agent's mouth: the agent speaks for
 * itself, by calling the `chat_post` tool registered on its own session
 * (session-tools.ts). Chat posts nothing on any agent's behalf.
 *
 * That inversion is the point. Lifting the assistant's text out of a finished
 * turn meant a codec sat between an agent and its own words — one that had to
 * track every SDK message-shape change, that could only speak once, at the very
 * end, and that couldn't tell "the agent had nothing to say" from "the shape
 * changed". Now the agent decides what is worth saying, can say it mid-turn, and
 * can raise a widget through the same door. What the orchestrator still owns is
 * everything ABOUT dispatch: who answers, what they're shown, the progress
 * bubble, and how far they've read.
 *
 * It reacts to the ship's log, not to an inline call: every posted message emits
 * a durable `chat.message_posted` event, and `handleBusNote` drives the reply
 * off the bus — the same path whether the message came from the web door,
 * another process (the chat CLI), or an agent's own `chat_post`. `reconcile`
 * re-drives any human message left unanswered by a restart.
 *
 * `wake` is the other entrance: when the waker delivers an agent's unread
 * notifications, the orchestrator drives one turn on the agent's own INBOX
 * session — a bare session owned by the agent, bound to no chat, cwd the repo
 * root. It backs no chat membership, so it gets no `chat_post` tool: routing an
 * update means FINDING the right chat first, which is the chat CLI's job.
 *
 * The clean chat transcript and the agent's full tool-call transcript are still
 * two surfaces over one conversation — but now the seam between them is the
 * agent's own tool call, not a filter chat runs over the transcript. While the
 * turn runs we translate its events into `chat.agent_progress` so the chat UI
 * can show a live "working…" line; that line means only "this agent is mid-turn"
 * and never "a reply is coming" (see driveTurn).
 *
 * The agent runtime is injected so the decision + dispatch flow is unit-tested
 * against PGlite with a fake runtime — no network, no real pi session.
 */

/** The slice of the agent runtime the chat orchestrator drives. */
export type ChatAgentRuntime = RunsTurns

/**
 * The situational header every agent turn opens with: who the agent is, which
 * chat this is, **how to speak**, and the concrete command for filing work.
 * Repeated per turn (cheap, and it survives session compaction).
 *
 * The speaking instruction is the load-bearing part, and it is not decoration.
 * Chat no longer lifts an agent's text into the conversation, so an agent that
 * doesn't call `chat_post` says NOTHING AT ALL. This header is the only thing
 * standing between a resident agent and total silence — if you edit it, verify a
 * real turn still speaks, not just that the tests pass.
 */
export function turnContext(input: {
  chatId: string
  handle: string
  userId: string
  /**
   * What each human in the chat has open on the canvas right now. Omitted (or
   * empty) in a chat with no canvas at all, which is most of them — a paragraph
   * about a surface that doesn't exist would be noise in every single turn.
   */
  viewers?: ChatViewerView[]
}): string {
  const cmd = actorCmd(
    input.userId,
    'issue',
    'new',
    '"<title>"',
    '--body',
    '"<details>"',
  )
  const docsDir = chatDocsDir(input.chatId)
  return `[You are @${input.handle} in chat ${input.chatId}.

HOW TO SPEAK: call the \`chat_post\` tool. That is the ONLY way anything reaches
the crew — text you write outside a tool call stays in your own session
transcript and nobody in the chat ever sees it. Post as soon as you have
something useful (you may post several times in one turn rather than saving it
all for the end). If you genuinely have nothing to add, end the turn without
posting: silence is allowed, and the crew is shown that you read it.

If you need a decision and you know the possible answers, call \`chat_widget\`
with action "raise" and kind "choice" instead of typing the question — the crew
gets tappable options above the composer and their answer arrives as an ordinary
message. Better than "yes or no?" on a phone. There are other kinds too (a
pinned note, a live list of issues); \`chat_widget\`'s own description lists
every kind this ship can render and the props each one takes.

THIS CHAT'S OWN DOCS FOLDER is ${docsDir} in the shared files (same library as
everything else, nothing siloed — just a place to keep this chat's own working
docs grouped). Read or write it with bash, e.g.
  ${actorCmd(input.userId, 'files', 'write', `${docsDir}/<file>`, '--stdin')}
and put it in front of the crew with \`chat_widget\` (kind "files", props
{ "folder": "${docsDir}" }) — or point that same widget at any other path or
folder in the shared library; this is a shortcut for this chat's own folder,
not the only place a files widget may look.

${canvasContext(input.viewers ?? [])}To file work for the ship, use bash:
  ${cmd}
As filed work moves you will be woken on your own inbox session with the
updates — post follow-ups back to this chat with \`chat_post\`.]`
}

/**
 * The canvas paragraph of the header: which page each person has open, so
 * "what's this?" is answerable.
 *
 * Per PERSON, never per chat — three members can be on three different pages,
 * so the header names each of them rather than claiming the conversation has a
 * page. And it says out loud that the agent cannot move somebody's view: an
 * agent that believes it can will try, find no door, and waste a turn — while a
 * crew member whose page was yanked out from under them loses trust in the whole
 * surface. Agent-driven focus is a later, carefully-designed thing.
 *
 * Empty for a chat with no canvas (every chat, until somebody makes a page), so
 * nothing is spent on a surface that isn't there.
 */
function canvasContext(viewers: ChatViewerView[]): string {
  if (viewers.length === 0) return ''
  const lines = viewers.map(
    (v) =>
      `  @${v.handle} — ${v.pageTitle === null ? 'the thread' : `canvas page “${v.pageTitle}”`}`,
  )
  return `WHAT EACH PERSON IS LOOKING AT (their own view, not a shared one — so
"what's this?" means whatever is on THEIR page). You cannot move anyone's view;
put a widget where you want it seen and say so.
${lines.join('\n')}

`
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

  /**
   * Show one live progress line for the chat's "working…" placeholder: emitted
   * transiently on the bus (for a mounted view watching live) AND persisted on
   * the member row (so it's still there after a page navigation, when the SSE
   * connection reopens and re-runs the loader instead of catching a live
   * event). The durable write is the source of truth the loader reads; the
   * ephemeral emit just avoids waiting on a round trip while the tab is open.
   */
  async function setProgress(
    chatId: string,
    agentUserId: string,
    line: string,
  ): Promise<void> {
    const payload: ChatAgentProgressPayload = { chatId, agentUserId, line }
    notifyOnly({
      type: CHAT_AGENT_PROGRESS,
      source: 'chat',
      topic: chatTopic(chatId),
      audience: MEMBERS_AUDIENCE,
      payload,
    })
    await setMemberProgress(db, chatId, agentUserId, line)
  }

  /**
   * The turn is over: clear the durable line AND say so on the bus.
   *
   * The announcement is not optional. A posted message used to double as
   * "the turn ended" for a live tab — the reply always arrived last — and after
   * the inversion it doesn't mean that at all: the agent posts from inside its
   * turn and may keep working, or may finish having said nothing. Observed live
   * before this existed: a silent turn left the status line spinning for five
   * minutes, until the page was reloaded. An empty line is the end-of-turn
   * signal (see topic.ts).
   */
  async function clearProgress(
    chatId: string,
    agentUserId: string,
  ): Promise<void> {
    const payload: ChatAgentProgressPayload = { chatId, agentUserId, line: '' }
    notifyOnly({
      type: CHAT_AGENT_PROGRESS,
      source: 'chat',
      topic: chatTopic(chatId),
      audience: MEMBERS_AUDIENCE,
      payload,
    })
    await setMemberProgress(db, chatId, agentUserId, null)
  }

  /**
   * Drive one turn of an agent member's backing session with `prompt`, showing
   * a live progress line in the chat while it runs. **Nothing is posted here** —
   * whatever the agent wanted to say it already said, mid-turn, through its own
   * `chat_post` tool.
   *
   * The progress line means exactly one thing: **this agent is mid-turn.** It
   * cannot mean "a reply is coming", because the agent may have posted twenty
   * seconds ago and still be working, or may never post at all. So the bubble is
   * cleared when the turn ENDS, and a message appearing while it still spins is
   * correct, not a glitch. (Before the inversion the message always arrived last,
   * which let the bubble pretend to be a promise.)
   */
  async function driveTurn(
    chatId: string,
    agent: ChatMemberView,
    prompt: string,
  ): Promise<void> {
    const sessionId = await ensureSession(chatId, agent)

    // Whether THIS call owns the bubble it started (so `finally` should clear
    // it): true unless the result comes back `queued` — a queued call's prompt
    // was folded into a turn already in flight, and that turn (not this one) is
    // the one still mid-turn, so clearing it here would blank an active
    // "working…" out from under it. Defaults true so a THROWN turn (this call's
    // own) still clears its bubble on the way out.
    let ownsTurn = true
    try {
      // One "thinking…" up front, then a line per meaningful step — deduped, so
      // a turn writes a handful of durable progress events, never one per
      // delta.
      let lastLine = 'thinking…'
      await setProgress(chatId, agent.userId, lastLine)
      const result = await runtime.runTurn(sessionId, prompt, (event) => {
        const line = chatProgressLine(event)
        if (line && line !== lastLine) {
          lastLine = line
          void setProgress(chatId, agent.userId, line).catch(
            /* v8 ignore next 2 -- defensive: a progress-line write failing must never break a reply */
            (err: unknown) => {
              console.error(`chat progress line failed: ${errorMessage(err)}`)
            },
          )
        }
      })
      if (result.queued) ownsTurn = false
    } finally {
      // The status line is scoped to the turn that owns it: whether it finished,
      // said nothing, or threw, this agent is no longer mid-turn once ITS
      // driveTurn returns — but a queued call must leave the actively running
      // turn's line alone.
      if (ownsTurn) await clearProgress(chatId, agent.userId)
    }
  }

  /**
   * Dispatch one agent's turn: feed it the messages it hasn't read, run the
   * turn, then mark how far it read.
   *
   * The watermark advance is what makes silence survivable. An agent speaks
   * through its own tool now, so a turn that ends with no post is an ordinary
   * outcome — and with no mark of its own, those messages would be unseen
   * forever and re-fed on every later reply. We advance to the tail we FED (not
   * to whatever is newest now), so a message that landed mid-turn stays unseen
   * and draws its own turn.
   *
   * Advanced only on a turn that completed: a thrown turn leaves the watermark
   * where it was, so the work is re-driven rather than silently dropped. A
   * QUEUED turn does advance — its prompt was folded into the turn already in
   * flight, which means the agent was shown these messages (and `setMemberSeen`
   * is monotonic, so the two finishing out of order is harmless).
   */
  async function reply(chatId: string, agentUserId: string): Promise<void> {
    const members = await listMembers(db, chatId)
    const agent = members.find((m) => m.userId === agentUserId)
    if (!agent) return

    const unseen = await messagesSinceAgent(db, chatId, agentUserId)
    if (unseen.length === 0) return
    const readThrough = unseen[unseen.length - 1].id
    // Only when the chat HAS a canvas: no pages, nothing to say about them.
    const hasCanvas = (await listCanvasPages(db, chatId)).length > 0
    const prompt = `${turnContext({
      chatId,
      handle: agent.handle,
      userId: agent.userId,
      viewers: hasCanvas ? await listChatViewers(db, chatId) : [],
    })}\n\n${formatTranscript(
      unseen.map((m) => ({ handle: m.authorHandle, body: m.body })),
    )}`
    await driveTurn(chatId, agent, prompt)
    await setMemberSeen(db, chatId, agentUserId, readThrough)
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
   * behalf. The inbox session backs no chat membership, so it gets no
   * `chat_post` tool (session-tools.ts): the CLI is the right door here
   * precisely because routing means FINDING a chat before speaking into one.
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
   * and run each turn. Agents take their turns in sequence (a small crew), and
   * each one says whatever it decides to say through its own `chat_post` — so
   * one agent's post is a new posted-message event the others may then hear,
   * except that `targetsForMessage` gives an agent-authored message no targets
   * at all. Agents never trigger agents, however wide the door gets.
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
