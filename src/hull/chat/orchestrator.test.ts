import { uuidv7 } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '@hull/db/client'
import { appendMessage, getSession } from '@hull/agent/service'
import { shipLogBus } from '@hull/events/bus'
import { listEventsSince } from '@hull/events/service'
import { defined, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import {
  assistantTextFrom,
  type ChatAgentRuntime,
  createChatOrchestrator,
} from './orchestrator'
import {
  addMessage,
  CHAT_MESSAGE_POSTED,
  chatTopic,
  createChat,
  listMembers,
  listMessages,
} from './service'

// Pin CHAT_MODEL to a sentinel that can't equal DEFAULT_MODEL: in a keyless
// test environment the two constants coincide, so asserting the real value
// couldn't catch a regression back to DEFAULT_MODEL. The sentinel can.
const TEST_CHAT_MODEL = 'test/chat-strong-model'
vi.mock('@hull/agent/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hull/agent/runtime')>()),
  CHAT_MODEL: 'test/chat-strong-model',
}))

/** The id of the chat.message_posted event addMessage emitted for a chat. */
async function postedEventId(db: Database, chatId: string): Promise<string> {
  const events = await listEventsSince(db, {
    topicPatterns: [chatTopic(chatId)],
    audience: 'members',
  })
  return defined(events.find((e) => e.type === CHAT_MESSAGE_POSTED)).id
}

describe('assistantTextFrom', () => {
  it('lifts only assistant text out of a transcript tail', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
      { role: 'toolResult', toolName: 'read', content: 'file contents' },
    ]
    expect(assistantTextFrom(messages)).toBe('hello there')
  })

  it('joins multiple assistant turns with a blank line, dropping tool steps between', () => {
    // Pins the '\n\n' separator and the assistant-only filter: a tool result
    // sandwiched between two assistant texts must not appear, and the two texts
    // must be separated by a blank line (not concatenated).
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      { role: 'toolResult', toolName: 'read', content: 'ignored' },
      { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
    ]
    expect(assistantTextFrom(messages)).toBe('first\n\nsecond')
  })

  it('trims surrounding whitespace off the lifted text', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: '  spaced  ' }] },
    ]
    expect(assistantTextFrom(messages)).toBe('spaced')
  })

  it('is empty when the tail has no assistant text', () => {
    const messages = [
      { role: 'toolResult', toolName: 'read', content: 'only a tool result' },
    ]
    expect(assistantTextFrom(messages)).toBe('')
  })
})

/**
 * A fake runtime that, on a turn, optionally streams one progress event and then
 * returns the assistant messages it produced. No network, no real pi session.
 */
function fakeRuntime(db: Database, replyText: string): ChatAgentRuntime {
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
      await appendMessage(db, {
        sessionId,
        role: 'assistant',
        message,
      })
      return [message as never]
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
      runtime: fakeRuntime(db, 'hi dru'),
    })
    await orch.respond({ chatId, authorId: dru, body: 'hello tilde' })

    const messages = await listMessages(db, chatId)
    expect(messages.map((m) => `${m.authorHandle}:${m.body}`)).toEqual([
      'dru:hello tilde',
      'tilde:hi dru',
    ])

    // A backing session was created and recorded on the membership — and it
    // boots on CHAT_MODEL (pinned to a sentinel above), not the ship default
    // the builders use.
    const members = await listMembers(db, chatId)
    const sessionId = members.find((m) => m.userId === tilde)?.sessionId
    expect(sessionId).not.toBeNull()
    const session = await getSession(db, defined(sessionId ?? undefined))
    expect(session?.model).toBe(TEST_CHAT_MODEL)
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
      runtime: fakeRuntime(db, 'hi dru'),
    })
    await orch.respond({ chatId, authorId: dru, body: 'hello tilde' })

    // Progress events should NOT be in the durable log.
    const events = await listEventsSince(db, {
      topicPatterns: [chatTopic(chatId)],
      audience: 'members',
    })
    expect(events.map((e) => e.type)).not.toContain('chat.agent_progress')
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
        return [message as never]
      },
    }

    const orch = createChatOrchestrator({ db, runtime: streaming })
    try {
      await orch.respond({ chatId, authorId: dru, body: 'go' })
    } finally {
      unsubscribe()
    }

    // The leading "thinking…", then one line per *distinct* step: the repeated
    // 'read' collapses, and the line-less turn boundary adds nothing.
    expect(lines).toEqual(['thinking…', 'using read…', 'using write…'])
  })

  it('reuses the backing session across turns', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })

    const orch = createChatOrchestrator({ db, runtime: fakeRuntime(db, 'ok') })
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

  it('posts nothing when the agent produces no text', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'hi' })

    // A runtime whose turn appends only a tool result — no assistant text.
    const silent: ChatAgentRuntime = {
      runTurn: async (sessionId) => {
        const message = { role: 'toolResult', toolName: 'read', content: 'x' }
        await appendMessage(db, {
          sessionId,
          role: 'toolResult',
          message,
        })
        return [message as never]
      },
    }
    const orch = createChatOrchestrator({ db, runtime: silent })
    await orch.respond({ chatId, authorId: dru, body: 'hi' })

    // Only the human's message — no empty agent message posted.
    expect(await listMessages(db, chatId)).toHaveLength(1)
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
      runtime: fakeRuntime(db, 'my take'),
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

    const orch = createChatOrchestrator({ db, runtime: fakeRuntime(db, 'x') })
    await orch.respond({ chatId, authorId: dru, body: 'hi all' })

    expect(await listMessages(db, chatId)).toHaveLength(1) // only the human's
  })

  it('uses the messages returned by runTurn instead of rereading them', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, {
      id: uuidv7(),
      chatId,
      authorId: dru,
      body: 'hi',
    })

    // A runtime that returns messages directly, demonstrating the orchestrator
    // uses the return value instead of slicing the durable log.
    const directReturn: ChatAgentRuntime = {
      runTurn: () =>
        Promise.resolve([
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'from return value' }],
          },
        ] as never[]),
    }

    const orch = createChatOrchestrator({ db, runtime: directReturn })
    await orch.respond({ chatId, authorId: dru, body: 'hi' })

    const messages = await listMessages(db, chatId)
    expect(messages[1].body).toBe('from return value')
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
      runtime: fakeRuntime(db, 'hi dru'),
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

    const orch = createChatOrchestrator({ db, runtime: fakeRuntime(db, 'x') })
    await orch.handleBusNote({
      id: await postedEventId(db, chatId),
      type: 'issue.status_changed',
    })

    expect(await listMessages(db, chatId)).toHaveLength(1) // no reply
  })

  it('drops a note whose event or message is gone', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })

    const orch = createChatOrchestrator({ db, runtime: fakeRuntime(db, 'x') })
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
      runtime: fakeRuntime(db, 'loop?'),
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
      runtime: fakeRuntime(db, 'here!'),
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
    const orch = createChatOrchestrator({ db, runtime: fakeRuntime(db, 'ok') })
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

    const orch = createChatOrchestrator({ db, runtime: fakeRuntime(db, 'x') })
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

    const orch = createChatOrchestrator({ db, runtime: fakeRuntime(db, 'x') })
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

    const orch = createChatOrchestrator({ db, runtime: fakeRuntime(db, 'x') })
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

    const orch = createChatOrchestrator({ db, runtime: fakeRuntime(db, 'x') })
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

    const orch = createChatOrchestrator({ db, runtime: fakeRuntime(db, 'x') })
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

  /** A fake runtime that records every prompt it was driven with. */
  function promptRecordingRuntime(replyText: string): ChatAgentRuntime & {
    prompts: string[]
  } {
    const prompts: string[] = []
    return {
      prompts,
      async runTurn(sessionId, text) {
        prompts.push(text)
        const message = {
          role: 'assistant',
          content: [{ type: 'text', text: replyText }],
        }
        await appendMessage(db, { sessionId, role: 'assistant', message })
        return [message as never]
      },
    }
  }

  it('opens every reply turn with the situational context (chat id + how to file work)', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, { id: uuidv7(), chatId, authorId: dru, body: 'plan?' })

    const runtime = promptRecordingRuntime('here is the plan')
    const orch = createChatOrchestrator({ db, runtime })
    await orch.respond({ chatId, authorId: dru, body: 'plan?' })

    const [prompt] = runtime.prompts
    expect(prompt).toContain(`chat ${chatId}`)
    expect(prompt).toContain('@tilde')
    expect(prompt).toContain(
      `SKYLARK_ACTOR=${tilde} npm run issue -- new "<title>" --body "<details>" --chat ${chatId}`,
    )
    // The actual conversation still follows the header.
    expect(prompt).toContain('@dru: plan?')
  })

  it('wake runs a briefed turn and posts the reply as the agent', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })

    const runtime = promptRecordingRuntime('the build looks good — reviewing')
    const orch = createChatOrchestrator({ db, runtime })
    await orch.wake(chatId, tilde, '1 update: @builder moved it: open → done')

    const [prompt] = runtime.prompts
    expect(prompt).toContain('@builder moved it: open → done')
    expect(prompt).toContain(`chat ${chatId}`) // wake turns get the header too

    const messages = await listMessages(db, chatId)
    expect(messages.map((m) => `${m.authorHandle}:${m.body}`)).toEqual([
      'tilde:the build looks good — reviewing',
    ])
  })

  it('wake folds unseen chat messages into the briefing turn', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    await addMessage(db, {
      id: uuidv7(),
      chatId,
      authorId: dru,
      body: 'ps: also check the docs',
    })

    const runtime = promptRecordingRuntime('on it')
    const orch = createChatOrchestrator({ db, runtime })
    await orch.wake(chatId, tilde, 'the briefing')

    const [prompt] = runtime.prompts
    expect(prompt).toContain('the briefing')
    expect(prompt).toContain('Meanwhile in this chat:')
    expect(prompt).toContain('@dru: ps: also check the docs')
  })

  it('wake refuses a target that is not an agent member of the chat', async () => {
    const chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })

    const runtime = promptRecordingRuntime('never')
    const orch = createChatOrchestrator({ db, runtime })
    await orch.wake(chatId, dru, 'briefing') // a human
    await orch.wake(chatId, bix, 'briefing') // an agent, but not a member
    expect(runtime.prompts).toHaveLength(0)
    expect(await listMessages(db, chatId)).toHaveLength(0)
  })
})
