import { uuidv7 } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { appendMessage } from '@hull/agent/service'
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
  chatScope,
  createChat,
  listMembers,
  listMessages,
} from './service'

describe('assistantTextFrom', () => {
  it('lifts only assistant text out of a transcript tail', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
      { role: 'toolResult', toolName: 'read', content: 'file contents' },
    ]
    expect(assistantTextFrom(messages)).toBe('hello there')
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

    // A backing session was created and recorded on the membership.
    const members = await listMembers(db, chatId)
    expect(members.find((m) => m.userId === tilde)?.sessionId).not.toBeNull()
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
      topicPatterns: [chatScope(chatId)],
      audience: 'members',
    })
    expect(events.map((e) => e.type)).not.toContain('chat.agent_progress')
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
})
