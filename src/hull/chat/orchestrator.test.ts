import { uuidv7 } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '@hull/db/client'
import { appendMessage, getSession } from '@hull/agent/service'
import { shipLogBus } from '@hull/events/bus'
import { listEventsSince } from '@hull/events/service'
import { defined, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import { type ChatAgentRuntime, createChatOrchestrator } from './orchestrator'
import {
  addMessage,
  createChat,
  listMembers,
  listMessages,
  messagesSinceAgent,
  setMemberProgress,
} from './service'
import { chatMembers } from './schema'
import { CHAT_MESSAGE_POSTED, chatTopic } from './topic'

// Pin DEFAULT_MODEL to a sentinel so the assertion below checks the ambient
// ship default is what actually lands on the session row — hermetic under
// any SKYLARK_DEFAULT_MODEL in the machine's environment.
const TEST_DEFAULT_MODEL = 'test/ship-default-model'
vi.mock('@hull/agent/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hull/agent/runtime')>()),
  DEFAULT_MODEL: 'test/ship-default-model',
}))

/** The id of the chat.message_posted event addMessage emitted for a chat. */
async function postedEventId(db: Database, chatId: string): Promise<string> {
  const events = await listEventsSince(db, {
    topicPatterns: [chatTopic(chatId)],
    audience: 'members',
  })
  return defined(events.find((e) => e.type === CHAT_MESSAGE_POSTED)).id
}

/**
 * Post as the agent whose backing session this is — what the real `chat_post`
 * tool does (chat's own addMessage, authored by the agent, resolved from nothing
 * but the session it was registered on). The fakes below use it so a "reply" in
 * these tests travels the same path a live agent's words do: the agent speaks,
 * the orchestrator never does.
 */
async function postAsAgent(
  db: Database,
  sessionId: string,
  body: string,
): Promise<void> {
  const [member] = await db
    .select()
    .from(chatMembers)
    .where(eq(chatMembers.sessionId, sessionId))
  await addMessage(db, {
    id: uuidv7(),
    chatId: member.chatId,
    authorId: member.userId,
    body,
  })
}

/**
 * A fake runtime standing in for an agent that speaks for itself: on a turn it
 * streams one progress event, records a transcript message, and posts `replyText`
 * into the chat through the same door `chat_post` uses. No network, no real pi
 * session — and nothing for the orchestrator to lift.
 */
function speakingRuntime(db: Database, replyText: string): ChatAgentRuntime {
  return {
    async runTurn(sessionId, _text, onEvent) {
      onEvent?.({
        type: 'tool_execution_start',
        toolName: 'read',
      } as unknown as AgentSessionEvent)
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: replyText }],
      }
      await appendMessage(db, { sessionId, role: 'assistant', message })
      await postAsAgent(db, sessionId, replyText)
      return { queued: false, messages: [message as never] }
    },
  }
}

/**
 * A fake runtime for an agent that takes its turn and decides to say nothing —
 * an ordinary outcome now that speaking is the agent's own move. Its transcript
 * is full of assistant text; none of it may reach the chat.
 */
function silentRuntime(db: Database): ChatAgentRuntime {
  return {
    async runTurn(sessionId) {
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: 'thinking to myself, not to them' }],
      }
      await appendMessage(db, { sessionId, role: 'assistant', message })
      return { queued: false as const, messages: [message as never] }
    },
  }
}

describe('chat orchestrator', () => {
  let db: Database
  let close: () => Promise<void>
  let dru: string
  let tilde: string
  let bix: string

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    dru = uuidv7()
    tilde = uuidv7()
    bix = uuidv7()
    await createUser(db, {
      id: dru,
      handle: 'dru',
      displayName: 'Dru',
      type: 'human',
    })
    await createUser(db, {
      id: tilde,
      handle: 'tilde',
      displayName: 'Tilde',
      type: 'agent',
    })
    await createUser(db, {
      id: bix,
      handle: 'bix',
      displayName: 'Bix',
      type: 'agent',
    })
  })
  afterEach(() => close())

  it('auto-replies in a 1:1, posting the agent message', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, {
      id: uuidv7(),
      chatId,
      authorId: dru,
      body: 'hello tilde',
    })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'hi dru'),
    })
    await orch.respond({ chatId, authorId: dru, body: 'hello tilde' })

    const messages = await listMessages(db, chatId)
    expect(messages.map((m) => `${m.authorHandle}:${m.body}`)).toEqual([
      'dru:hello tilde',
      'tilde:hi dru',
    ])

    // A backing session was created and recorded on the membership — and it
    // boots on the ship default (pinned to a sentinel above).
    const members = await listMembers(db, chatId)
    const sessionId = members.find((m) => m.userId === tilde)?.sessionId
    expect(sessionId).not.toBeNull()
    const session = await getSession(db, defined(sessionId ?? undefined))
    expect(session?.model).toBe(TEST_DEFAULT_MODEL)
  })

  it('emits transient progress events that are NOT persisted', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, {
      id: uuidv7(),
      chatId,
      authorId: dru,
      body: 'hello tilde',
    })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'hi dru'),
    })
    await orch.respond({ chatId, authorId: dru, body: 'hello tilde' })

    // Progress events should NOT be in the durable log.
    const events = await listEventsSince(db, {
      topicPatterns: [chatTopic(chatId)],
      audience: 'members',
    })
    expect(events.map((e) => e.type)).not.toContain('chat.agent_progress')
  })

  it('persists the progress line on the member row so it survives navigation, then clears it once the turn ends', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'go' })

    const tool = (toolName: string) =>
      ({
        type: 'tool_execution_start',
        toolName,
      }) as unknown as AgentSessionEvent

    let seenDuringTurn: string | null | undefined
    const streaming: ChatAgentRuntime = {
      async runTurn(sessionId, _text, onEvent) {
        onEvent?.(tool('read'))
        // Read the member row WHILE the turn is "in flight" (from this fake's
        // point of view) to prove the line landed durably, not just on the bus.
        seenDuringTurn = (await listMembers(db, chatId)).find(
          (m) => m.userId === tilde,
        )?.progressLine
        const message = {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        }
        await appendMessage(db, { sessionId, role: 'assistant', message })
        return { queued: false as const, messages: [message as never] }
      },
    }

    const orch = createChatOrchestrator({ db, runtime: streaming })
    await orch.respond({ chatId, authorId: dru, body: 'go' })

    expect(seenDuringTurn).toBe('using read…')
    // Once the turn's done and the reply posted, the bubble clears.
    const after = await listMembers(db, chatId)
    expect(after.find((m) => m.userId === tilde)?.progressLine).toBeNull()
  })

  it('clears the persisted progress line when the turn ends without speaking', async () => {
    // Silence is deliberate, not ghosting: the bubble comes DOWN (there is no
    // reply coming), and nothing is auto-posted in the agent's place — that
    // would be the ventriloquism this slice deleted.
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'hi' })

    const orch = createChatOrchestrator({ db, runtime: silentRuntime(db) })
    await orch.respond({ chatId, authorId: dru, body: 'hi' })

    const members = await listMembers(db, chatId)
    expect(members.find((m) => m.userId === tilde)?.progressLine).toBeNull()
    expect(await listMessages(db, chatId)).toHaveLength(1) // only the human's
  })

  it('clears the persisted progress line even when the turn throws', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'boom?' })

    const throwing: ChatAgentRuntime = {
      runTurn: () => Promise.reject(new Error('turn failed')),
    }
    const orch = createChatOrchestrator({ db, runtime: throwing })
    await expect(
      orch.respond({ chatId, authorId: dru, body: 'boom?' }),
    ).rejects.toThrow('turn failed')

    const members = await listMembers(db, chatId)
    expect(members.find((m) => m.userId === tilde)?.progressLine).toBeNull()
  })

  it('leaves no stale bubble mid-navigation: a fresh load of members reflects the live line', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'go' })

    // Simulate a page navigating away and back mid-turn: nothing but a fresh
    // listMembers call (no SSE, no in-memory state) stands in for "the route
    // remounted and re-ran its loader."
    let midTurnLine: string | null | undefined
    const runtime: ChatAgentRuntime = {
      async runTurn(sessionId) {
        midTurnLine = (await listMembers(db, chatId)).find(
          (m) => m.userId === tilde,
        )?.progressLine
        const message = {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        }
        await appendMessage(db, { sessionId, role: 'assistant', message })
        return { queued: false as const, messages: [message as never] }
      },
    }
    const orch = createChatOrchestrator({ db, runtime })
    await orch.respond({ chatId, authorId: dru, body: 'go' })

    expect(midTurnLine).toBe('thinking…')
  })

  it('emits one progress line per distinct step, deduping consecutive repeats', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'go' })

    // Capture the transient progress lines off the in-process bus.
    const lines: string[] = []
    const unsubscribe = shipLogBus.subscribe((note) => {
      if (note.type === 'chat.agent_progress') {
        lines.push((note.ephemeral?.payload as { line: string }).line)
      }
    })

    // A turn that streams: two identical tool steps (the second is a repeat),
    // a turn-boundary event chat maps to no line, then a different tool step.
    const tool = (toolName: string) =>
      ({
        type: 'tool_execution_start',
        toolName,
      }) as unknown as AgentSessionEvent
    const streaming: ChatAgentRuntime = {
      async runTurn(sessionId, _text, onEvent) {
        onEvent?.(tool('read'))
        onEvent?.(tool('read')) // consecutive duplicate → must be dropped
        onEvent?.({ type: 'turn_end' } as unknown as AgentSessionEvent) // no line
        onEvent?.(tool('write'))
        const message = {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        }
        await appendMessage(db, { sessionId, role: 'assistant', message })
        return { queued: false as const, messages: [message as never] }
      },
    }

    const orch = createChatOrchestrator({ db, runtime: streaming })
    try {
      await orch.respond({ chatId, authorId: dru, body: 'go' })
    } finally {
      unsubscribe()
    }

    // The leading "thinking…", then one line per *distinct* step: the repeated
    // 'read' collapses, and the line-less turn boundary adds nothing. Then the
    // blank end-of-turn line — see the next test for why it has to be there.
    expect(lines).toEqual([
      'thinking…',
      'using read…',
      'using write…',
      '', // the turn ended
    ])
  })

  it('announces the END of a silent turn, so a live tab stops spinning', async () => {
    // Found live: a turn that said nothing left the "working…" line spinning
    // for five minutes in an open browser. A posted message used to double as
    // "the turn is over" — after the inversion it doesn't (the agent posts
    // mid-turn, or never), so the end has to be said out loud on the bus.
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'fyi' })

    const lines: string[] = []
    const unsubscribe = shipLogBus.subscribe((note) => {
      if (note.type === 'chat.agent_progress') {
        lines.push((note.ephemeral?.payload as { line: string }).line)
      }
    })
    const orch = createChatOrchestrator({ db, runtime: silentRuntime(db) })
    try {
      await orch.respond({ chatId, authorId: dru, body: 'fyi' })
    } finally {
      unsubscribe()
    }

    expect(lines.at(-1)).toBe('')
    // And the durable half agrees, for a tab that reloads instead of listening.
    expect(
      (await listMembers(db, chatId)).find((m) => m.userId === tilde)
        ?.progressLine,
    ).toBeNull()
  })

  it('does not announce an end-of-turn on a queued call', async () => {
    // The turn that's actually running still owns the status line; saying "the
    // turn ended" here would blank an active one out from under it.
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'hi' })
    await setMemberProgress(db, chatId, tilde, 'using bash…')

    const lines: string[] = []
    const unsubscribe = shipLogBus.subscribe((note) => {
      if (note.type === 'chat.agent_progress') {
        lines.push((note.ephemeral?.payload as { line: string }).line)
      }
    })
    const queued: ChatAgentRuntime = {
      runTurn: () => Promise.resolve({ queued: true }),
    }
    const orch = createChatOrchestrator({ db, runtime: queued })
    try {
      await orch.respond({ chatId, authorId: dru, body: 'hi' })
    } finally {
      unsubscribe()
    }

    expect(lines).not.toContain('')
  })

  it('reuses the backing session across turns', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'ok'),
    })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'one' })
    await orch.respond({ chatId, authorId: dru, body: 'one' })
    const first = defined(
      (await listMembers(db, chatId)).find((m) => m.userId === tilde)
        ?.sessionId,
    )

    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'two' })
    await orch.respond({ chatId, authorId: dru, body: 'two' })
    const second = defined(
      (await listMembers(db, chatId)).find((m) => m.userId === tilde)
        ?.sessionId,
    )
    expect(second).toBe(first)
  })

  it('never speaks for the agent, however much text the turn produced', async () => {
    // THE pin on the inversion. A turn whose transcript is nothing but
    // assistant prose must leave the chat untouched: chat has no codec over the
    // transcript any more, so words reach the crew only when the agent itself
    // calls chat_post. If this test ever goes green with a message in the chat,
    // the ventriloquist is back.
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'hi' })

    const chatty: ChatAgentRuntime = {
      runTurn: () =>
        Promise.resolve({
          queued: false as const,
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'this must NOT reach the chat' }],
            },
          ] as never[],
        }),
    }
    const orch = createChatOrchestrator({ db, runtime: chatty })
    await orch.respond({ chatId, authorId: dru, body: 'hi' })

    expect(await listMessages(db, chatId)).toHaveLength(1) // only the human's
  })

  it('posts more than once in a turn when the agent does — chat adds nothing', async () => {
    // The agent decides how much to say and when. Two posts mid-turn arrive as
    // two ordinary messages, in order, with no "one reply per turn" ceiling —
    // which the old lift-and-post codec structurally imposed.
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'look?' })

    const chatty: ChatAgentRuntime = {
      async runTurn(sessionId) {
        await postAsAgent(db, sessionId, 'looking now')
        await postAsAgent(db, sessionId, 'found it')
        return { queued: false as const, messages: [] }
      },
    }
    const orch = createChatOrchestrator({ db, runtime: chatty })
    await orch.respond({ chatId, authorId: dru, body: 'look?' })

    expect((await listMessages(db, chatId)).map((m) => m.body)).toEqual([
      'look?',
      'looking now',
      'found it',
    ])
  })

  it("an agent's own post @mentioning another agent triggers nobody", async () => {
    // The inversion widens the path to this door — an agent's words are now a
    // real posted message travelling the whole reply path — so nail it down.
    // `targetsForMessage` filters on the AUTHOR, not the text: only a human's
    // message triggers a reply, so no cascade, no infinite loop, no bill.
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde, bix] })
    await addMessage(db, {
      id: uuidv7(),
      chatId,
      authorId: dru,
      body: 'thoughts @tilde?',
    })

    // Tilde answers and hands off in the same breath — the tempting thing an
    // agent will absolutely try.
    const handsOff: ChatAgentRuntime = {
      async runTurn(sessionId) {
        await postAsAgent(db, sessionId, 'my take. what do you think @bix?')
        return { queued: false as const, messages: [] }
      },
    }
    const orch = createChatOrchestrator({ db, runtime: handsOff })
    await orch.respond({ chatId, authorId: dru, body: 'thoughts @tilde?' })
    // Drive the reply path over tilde's OWN message, exactly as the bus would.
    const spoke = defined((await listMessages(db, chatId)).at(-1))
    await orch.respond({
      chatId,
      authorId: spoke.authorId,
      body: spoke.body,
    })

    const authors = (await listMessages(db, chatId)).map((m) => m.authorHandle)
    expect(authors).toEqual(['dru', 'tilde'])
    expect(authors).not.toContain('bix')
  })

  it('posts nothing (and logs no error) when the turn was queued mid-flight', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'hi' })

    // The agent's session is mid-turn: the prompt is folded into that turn,
    // whose eventual reply covers it — this call must not post anything, and
    // "queued" is a normal outcome, not an error.
    const queued: ChatAgentRuntime = {
      runTurn: () => Promise.resolve({ queued: true }),
    }
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    try {
      const orch = createChatOrchestrator({ db, runtime: queued })
      await orch.respond({ chatId, authorId: dru, body: 'hi' })

      // Only the human's message — no empty agent message, no logged error.
      expect(await listMessages(db, chatId)).toHaveLength(1)
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  it('does not null the bubble on a queued call — only the turn that owns it clears it', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'hi' })

    // Some OTHER, still-in-flight turn owns the bubble right now. This call's
    // prompt gets folded into that turn (queued) — it must not be the one to
    // null the bubble in its `finally`, since the turn that's actually running
    // still owns it and will clear it itself when IT finishes.
    await setMemberProgress(db, chatId, tilde, 'using bash…')
    const queued: ChatAgentRuntime = {
      runTurn: () => Promise.resolve({ queued: true }),
    }
    const orch = createChatOrchestrator({ db, runtime: queued })
    await orch.respond({ chatId, authorId: dru, body: 'hi' })

    const members = await listMembers(db, chatId)
    expect(members.find((m) => m.userId === tilde)?.progressLine).not.toBeNull()
  })

  it('answers only the @mentioned agent in a group', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde, bix] })
    await addMessage(db, {
      id: uuidv7(),
      chatId,
      authorId: dru,
      body: 'thoughts @bix?',
    })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'my take'),
    })
    await orch.respond({ chatId, authorId: dru, body: 'thoughts @bix?' })

    const authors = (await listMessages(db, chatId)).map((m) => m.authorHandle)
    expect(authors).toContain('bix')
    expect(authors).not.toContain('tilde')
  })

  it('stays silent in a group with no mention', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde, bix] })
    await addMessage(db, {
      id: uuidv7(),
      chatId,
      authorId: dru,
      body: 'hi all',
    })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'x'),
    })
    await orch.respond({ chatId, authorId: dru, body: 'hi all' })

    expect(await listMessages(db, chatId)).toHaveLength(1) // only the human's
  })

  it('marks how far a SILENT turn read, so those messages are never re-fed', async () => {
    // Without the watermark this is the forever bug: a turn that says nothing
    // leaves no trace, so every later reply re-feeds the same history and the
    // agent answers a conversation it already read.
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'hi' })

    const orch = createChatOrchestrator({ db, runtime: silentRuntime(db) })
    await orch.respond({ chatId, authorId: dru, body: 'hi' })

    expect(await messagesSinceAgent(db, chatId, tilde)).toEqual([])
    const seen = (await listMembers(db, chatId)).find((m) => m.userId === tilde)
    expect(seen?.lastSeenMessageId).toBe(
      defined((await listMessages(db, chatId)).at(0)).id,
    )
  })

  it('marks only the tail it FED, leaving a message that landed mid-turn unseen', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'first' })

    // The human types again while the agent is working. That message was never
    // in the prompt, so it must draw its own turn rather than being marked read.
    const interrupting: ChatAgentRuntime = {
      async runTurn() {
        await addMessage(db, {
          id: uuidv7(),
          chatId,
          authorId: dru,
          body: 'actually, also this',
        })
        return { queued: false as const, messages: [] }
      },
    }
    const orch = createChatOrchestrator({ db, runtime: interrupting })
    await orch.respond({ chatId, authorId: dru, body: 'first' })

    expect(
      (await messagesSinceAgent(db, chatId, tilde)).map((m) => m.body),
    ).toEqual(['actually, also this'])
  })

  it('leaves the watermark alone when the turn throws, so the work is re-driven', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'hi' })

    const throwing: ChatAgentRuntime = {
      runTurn: () => Promise.reject(new Error('turn failed')),
    }
    const orch = createChatOrchestrator({ db, runtime: throwing })
    await expect(
      orch.respond({ chatId, authorId: dru, body: 'hi' }),
    ).rejects.toThrow('turn failed')

    expect(
      (await messagesSinceAgent(db, chatId, tilde)).map((m) => m.body),
    ).toEqual(['hi'])
  })

  it('does not re-drive a turn that already spoke but lost its watermark write', async () => {
    // The crash ordering the two-halved watermark exists for: the agent's
    // chat_post committed, then the ship died before the watermark landed. The
    // POST is the second half of the watermark, so reconcile leaves it alone —
    // the crew never sees the same reply twice.
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'hi' })
    // Post as the agent WITHOUT any watermark write — exactly the crash state.
    await addMessage(db, {
      id: uuidv7(),
      chatId,
      authorId: tilde,
      body: 'already answered',
    })
    expect(
      (await listMembers(db, chatId)).find((m) => m.userId === tilde)
        ?.lastSeenMessageId,
    ).toBeNull()

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'second time!'),
    })
    await orch.reconcile()

    expect((await listMessages(db, chatId)).map((m) => m.body)).toEqual([
      'hi',
      'already answered',
    ])
  })

  it('reconcile stays idempotent after a silent turn', async () => {
    // The other crash ordering, and the one the column exists for: the turn
    // said nothing and only the watermark marks it. Reconcile must not re-drive
    // it on every boot.
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'hi' })

    let turns = 0
    const counting: ChatAgentRuntime = {
      runTurn: () => {
        turns++
        return Promise.resolve({ queued: false as const, messages: [] })
      },
    }
    const orch = createChatOrchestrator({ db, runtime: counting })
    await orch.reconcile()
    await orch.reconcile()
    await orch.reconcile()

    expect(turns).toBe(1)
    expect(await listMessages(db, chatId)).toHaveLength(1)
  })

  it('drives a reply when a chat.message_posted note arrives off the bus', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, {
      id: uuidv7(),
      chatId,
      authorId: dru,
      body: 'hello tilde',
    })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'hi dru'),
    })
    await orch.handleBusNote({
      id: await postedEventId(db, chatId),
      type: CHAT_MESSAGE_POSTED,
    })

    expect((await listMessages(db, chatId)).map((m) => m.authorHandle)).toEqual(
      ['dru', 'tilde'],
    )
  })

  it('ignores a bus note that is not a chat message', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'hi' })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'x'),
    })
    await orch.handleBusNote({
      id: await postedEventId(db, chatId),
      type: 'issue.status_changed',
    })

    expect(await listMessages(db, chatId)).toHaveLength(1) // no reply
  })

  it('drops a note whose event or message is gone', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'x'),
    })
    await orch.handleBusNote({ id: 'no-such-event', type: CHAT_MESSAGE_POSTED })

    expect(await listMessages(db, chatId)).toHaveLength(0)
  })

  it('does not cascade on an agent-authored message (no reply loop)', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    // The agent itself posts — its own posted-message event must not trigger a
    // reply (only a human triggers), so there's no infinite cascade.
    await addMessage(db, {
      id: uuidv7(),
      chatId,
      authorId: tilde,
      body: 'i spoke',
    })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'loop?'),
    })
    await orch.handleBusNote({
      id: await postedEventId(db, chatId),
      type: CHAT_MESSAGE_POSTED,
    })

    expect(await listMessages(db, chatId)).toHaveLength(1) // the agent's only
  })

  it('reconcile answers a human message a restart left unanswered, idempotently', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    // A human message landed but the reply never ran (turn interrupted).
    await addMessage(db, {
      id: uuidv7(),
      chatId,
      authorId: dru,
      body: 'still there?',
    })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'here!'),
    })
    await orch.reconcile()
    expect((await listMessages(db, chatId)).map((m) => m.authorHandle)).toEqual(
      ['dru', 'tilde'],
    )

    // Running reconcile again must not double-reply — the agent already answered.
    await orch.reconcile()
    expect(await listMessages(db, chatId)).toHaveLength(2)
  })

  it('reconcile leaves an already-answered chat untouched', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'ok'),
    })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'hi' })
    await orch.respond({ chatId, authorId: dru, body: 'hi' })
    expect(await listMessages(db, chatId)).toHaveLength(2)

    await orch.reconcile()
    expect(await listMessages(db, chatId)).toHaveLength(2)
  })

  it('reconcile is a no-op for a chat with only agent messages', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: tilde, body: 'hi' })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'x'),
    })
    await orch.reconcile()

    expect(await listMessages(db, chatId)).toHaveLength(1)
  })

  it('drops a posted-message note whose payload is malformed', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    // A real event row, but the payload is missing the string fields the
    // handler needs — another ship's event must not sail unchecked.
    const { emitEvent } = await import('@hull/events/bus')
    const row = await emitEvent(db, {
      type: CHAT_MESSAGE_POSTED,
      source: 'chat',
      topic: chatTopic(chatId),
      audience: 'members',
      payload: { chatId: 42 },
    })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'x'),
    })
    await orch.handleBusNote({ id: row.id, type: CHAT_MESSAGE_POSTED })

    expect(await listMessages(db, chatId)).toHaveLength(0)
  })

  it('ignores a posted-message event from another source, even with the right topic', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    const msgId = uuidv7()
    await addMessage(db, { id: msgId, chatId, authorId: dru, body: 'hi' })
    const { emitEvent } = await import('@hull/events/bus')
    const row = await emitEvent(db, {
      type: CHAT_MESSAGE_POSTED,
      source: 'issues', // ONLY the source is wrong
      topic: chatTopic(chatId),
      audience: 'members',
      payload: { chatId, messageId: msgId, authorId: dru },
    })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'x'),
    })
    await orch.handleBusNote({ id: row.id, type: CHAT_MESSAGE_POSTED })

    expect(await listMessages(db, chatId)).toHaveLength(1) // no reply
  })

  it('ignores a posted-message event whose topic names a different chat', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    const msgId = uuidv7()
    await addMessage(db, { id: msgId, chatId, authorId: dru, body: 'hi' })
    const { emitEvent } = await import('@hull/events/bus')
    const row = await emitEvent(db, {
      type: CHAT_MESSAGE_POSTED,
      source: 'chat',
      topic: chatTopic('somewhere-else'), // ONLY the topic is wrong
      audience: 'members',
      payload: { chatId, messageId: msgId, authorId: dru },
    })

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'x'),
    })
    await orch.handleBusNote({ id: row.id, type: CHAT_MESSAGE_POSTED })

    expect(await listMessages(db, chatId)).toHaveLength(1) // no reply
  })

  it('drops a posted-message payload with one non-string field at a time', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    const msgId = uuidv7()
    await addMessage(db, { id: msgId, chatId, authorId: dru, body: 'hi' })
    const { emitEvent } = await import('@hull/events/bus')
    // Each variant breaks exactly ONE field (the envelope stays consistent
    // with it), so every shape guard is individually load-bearing.
    const good = { chatId, messageId: msgId, authorId: dru }
    const variants: { payload: unknown; topic: string }[] = [
      { payload: { ...good, chatId: 42 }, topic: 'chat:42' },
      { payload: { ...good, messageId: 42 }, topic: chatTopic(chatId) },
      { payload: { ...good, authorId: 42 }, topic: chatTopic(chatId) },
    ]

    const orch = createChatOrchestrator({
      db,
      runtime: speakingRuntime(db, 'x'),
    })
    for (const { payload, topic } of variants) {
      const row = await emitEvent(db, {
        type: CHAT_MESSAGE_POSTED,
        source: 'chat',
        topic,
        audience: 'members',
        payload,
      })
      await orch.handleBusNote({ id: row.id, type: CHAT_MESSAGE_POSTED })
    }

    expect(await listMessages(db, chatId)).toHaveLength(1) // no reply
  })

  it('reconcile keeps going when one chat reply throws', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'boom?' })

    const throwing: ChatAgentRuntime = {
      runTurn: () => Promise.reject(new Error('turn failed')),
    }
    const errSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    const orch = createChatOrchestrator({ db, runtime: throwing })
    // A per-chat failure is caught and logged, not thrown — reconcile resolves.
    await expect(orch.reconcile()).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  /** A fake runtime that records every prompt (and session id) it was driven with. */
  function promptRecordingRuntime(replyText: string): ChatAgentRuntime & {
    prompts: string[]
    sessionIds: string[]
  } {
    const prompts: string[] = []
    const sessionIds: string[] = []
    return {
      prompts,
      sessionIds,
      async runTurn(sessionId, text) {
        prompts.push(text)
        sessionIds.push(sessionId)
        const message = {
          role: 'assistant',
          content: [{ type: 'text', text: replyText }],
        }
        await appendMessage(db, { sessionId, role: 'assistant', message })
        return { queued: false as const, messages: [message as never] }
      },
    }
  }

  it('opens every reply turn by telling the agent how to SPEAK', async () => {
    // The single most dangerous line in this slice. Chat no longer lifts an
    // agent's text into the conversation, so an agent that isn't told to call
    // chat_post says nothing at all — every resident goes mute. This test is the
    // tripwire on that instruction.
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'plan?' })

    const runtime = promptRecordingRuntime('here is the plan')
    const orch = createChatOrchestrator({ db, runtime })
    await orch.respond({ chatId, authorId: dru, body: 'plan?' })

    const [prompt] = runtime.prompts
    expect(prompt).toContain(`chat ${chatId}`)
    expect(prompt).toContain('@tilde')
    // Speaking: named, marked as the ONLY way, and silence explicitly allowed.
    expect(prompt).toContain('chat_post')
    expect(prompt).toMatch(/ONLY way/)
    expect(prompt).toMatch(/nothing to add/)
    // The structured door, so a yes/no becomes a tap rather than a sentence.
    expect(prompt).toContain('chat_widget')
    // Filing work is unchanged, and still carries no --chat flag (issues know
    // nothing about chat).
    expect(prompt).toContain(
      `SKYLARK_ACTOR=${tilde} npm run issue -- new "<title>" --body "<details>"`,
    )
    expect(prompt).not.toContain('--chat')
    // Speaking is a tool now, so the chat CLI is no longer the way to reply
    // from a chat turn — pointing at it would teach the budgeted shell-out path
    // this slice deliberately rejected.
    expect(prompt).not.toContain('npm run chat -- post')
    // The actual conversation still follows the header.
    expect(prompt).toContain('@dru: plan?')
  })

  it("wake runs a briefed turn on the agent's own inbox session, posting nothing to a chat", async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })

    const runtime = promptRecordingRuntime('the build looks good — reviewing')
    const orch = createChatOrchestrator({ db, runtime })
    await orch.wake(tilde, '1 update: @builder moved it: open → done')

    const [prompt] = runtime.prompts
    expect(prompt).toContain('@builder moved it: open → done')
    expect(prompt).toContain('This is your inbox session')
    expect(prompt).toContain('npm run chat -- list')
    expect(prompt).toContain('npm run chat -- show')
    expect(prompt).toContain('npm run chat -- post')

    // The wake turn is routing-ONLY: no issue-filing affordance, no license to
    // investigate — handing the router a do-work tool is what sent inbox
    // sessions rogue (debugging CI, filing issues, polling checks in a loop).
    expect(prompt).toContain('Do not investigate')
    expect(prompt).toMatch(/If no chat fits, do\s+nothing/)
    expect(prompt).not.toContain('To file follow-up work')
    expect(prompt).not.toContain('npm run issue -- new')

    // Nothing lands in the chat — routing an update is the agent's own job,
    // done from its bash tool, not something the orchestrator posts for it.
    expect(await listMessages(db, chatId)).toHaveLength(0)

    // The turn ran on a fresh session recorded under the agent, titled
    // "Inbox" — not bound to the chat above.
    const session = defined(
      await getSession(db, defined(runtime.sessionIds[0])),
    )
    expect(session.title).toBe('Inbox')
    expect(session.agentUserId).toBe(tilde)
    expect(session.model).toBe(TEST_DEFAULT_MODEL)
    expect(session.cwd).toBeNull()
  })

  it('wake reuses the same inbox session across calls', async () => {
    const runtime = promptRecordingRuntime('ok')
    const orch = createChatOrchestrator({ db, runtime })
    await orch.wake(tilde, 'first batch')
    await orch.wake(tilde, 'second batch')

    expect(runtime.sessionIds[0]).toBe(runtime.sessionIds[1])
  })

  it('wake refuses a human — humans read their inbox, they are never woken', async () => {
    const runtime = promptRecordingRuntime('never')
    const orch = createChatOrchestrator({ db, runtime })
    await orch.wake(dru, 'briefing')
    expect(runtime.prompts).toHaveLength(0)
  })

  it('wake refuses an unknown user id', async () => {
    const runtime = promptRecordingRuntime('never')
    const orch = createChatOrchestrator({ db, runtime })
    await orch.wake('no-such-user', 'briefing')
    expect(runtime.prompts).toHaveLength(0)
  })
})
