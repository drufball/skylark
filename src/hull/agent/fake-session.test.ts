import {
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { FAKE_RUNTIME_ENV } from '@hull/lib/env'

import {
  createFakeSession,
  FAKE_WIDGET_MARKER,
  FAKE_WIDGET_QUESTION,
  fakeReply,
  fakeToolCall,
} from './fake-session'
import { resolveSessionFactory } from './server-runtime'
import { createAgentRuntime, createPiSession } from './runtime'
import { createSession, getMessages } from './service'

describe('fakeReply', () => {
  it('echoes the prompt first line, deterministically, with no network', () => {
    expect(fakeReply('hello there')).toBe('[fake agent] hello there')
    // Only the first line; later lines are dropped.
    expect(fakeReply('build this\nand that')).toBe('[fake agent] build this')
    // Trims, and a blank prompt still yields a stable reply.
    expect(fakeReply('   ')).toBe('[fake agent]')
    expect(fakeReply('  spaced  ')).toBe('[fake agent] spaced')
  })
})

describe('resolveSessionFactory', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('returns the live factory by default (flag unset/empty)', () => {
    vi.stubEnv(FAKE_RUNTIME_ENV, '')
    expect(resolveSessionFactory()).toBe(createPiSession)
  })

  it('returns the fake factory when the env flag is set', () => {
    vi.stubEnv(FAKE_RUNTIME_ENV, '1')
    expect(resolveSessionFactory()).toBe(createFakeSession)
  })
})

describe('fakeToolCall', () => {
  it('speaks through chat_post by default', () => {
    // Since chat stopped lifting an agent's text, the fake HAS to call the tool
    // or a fake-runtime chat is silent — a smoke run of a mute ship.
    expect(fakeToolCall('say hi')).toEqual({
      name: 'chat_post',
      args: { body: '[fake agent] say hi' },
    })
  })

  it('raises a widget when the prompt carries the marker', () => {
    // The only way to drive an agent RAISING a widget with no model behind it.
    expect(fakeToolCall(`ship it? ${FAKE_WIDGET_MARKER}`)).toEqual({
      name: 'chat_widget',
      args: {
        action: 'raise',
        kind: 'choice',
        props: { question: FAKE_WIDGET_QUESTION, options: ['Yes', 'No'] },
      },
    })
  })
})

describe('the fake session surface', () => {
  it('emits the turn boundaries on prompt and stays inert elsewhere', async () => {
    const session = await createFakeSession()
    const events: string[] = []
    const unsubscribe = session.subscribe((e) => events.push(e.type))

    await session.prompt('build this\nand more')
    // No chat tools registered (a builder's session, an inbox session): nothing
    // to speak through, so the turn is just the prompt and its assistant text.
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(events).toEqual(['turn_end', 'agent_end'])

    // The lifecycle methods are inert (no network, no throw) — a smoke run can
    // open, drive, and tear down a session without surprises.
    await expect(session.followUp('again')).resolves.toBeUndefined()
    await expect(session.abort()).resolves.toBeUndefined()
    expect(session.isStreaming).toBe(false)
    unsubscribe()
    expect(() => {
      session.dispose()
    }).not.toThrow()
  })
})

describe('the fake session speaking through a chat tool', () => {
  /** A stand-in for chat_post that just records what it was told to say. */
  function recordingPost(said: string[]): ToolDefinition {
    return defineTool({
      name: 'chat_post',
      label: 'post',
      description: 'post',
      parameters: Type.Object({ body: Type.String() }),
      execute: (_id, params) => {
        said.push(params.body)
        return Promise.resolve({
          content: [{ type: 'text' as const, text: 'posted' }],
          details: undefined,
        })
      },
    })
  }

  it('calls the tool and records the call + result in the transcript', async () => {
    const said: string[] = []
    const session = await createFakeSession(undefined, undefined, undefined, [
      recordingPost(said),
    ])
    const tools: string[] = []
    session.subscribe((e) => {
      if (e.type === 'tool_execution_start') tools.push(e.toolName)
    })

    await session.prompt('hello there')

    expect(said).toEqual(['[fake agent] hello there'])
    // The call and its result are in the transcript, so the Agents monitor view
    // shows the same shape a real turn does.
    expect(session.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ])
    // And it streams a tool event, so the chat's progress line moves.
    expect(tools).toEqual(['chat_post'])
  })

  it('carries on when the tool throws, recording the failure', async () => {
    const boom = defineTool({
      name: 'chat_post',
      label: 'post',
      description: 'post',
      parameters: Type.Object({ body: Type.String() }),
      execute: () => Promise.reject(new Error('no such chat')),
    })
    const session = await createFakeSession(undefined, undefined, undefined, [
      boom,
    ])

    await expect(session.prompt('hello')).resolves.toBeUndefined()
    expect(session.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
    ])
  })
})

describe('createFakeSession driven through the runtime', () => {
  let db: Database
  let close: () => Promise<void>
  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })
  afterEach(() => close())

  it('runs a turn end-to-end: canned reply persisted and returned, no network', async () => {
    const runtime = createAgentRuntime({ db, factory: createFakeSession })
    await createSession(db, { id: 's1', model: 'm' })

    const result = await runtime.runTurn('s1', 'hello there')
    if (result.queued) throw new Error('expected a completed turn, got queued')
    const produced = result.messages

    // The fake emits turn_end + agent_end, so the runtime flushes and returns
    // the user prompt + the canned assistant reply — deterministic, no network.
    expect(produced.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(
      (produced[1] as { content: { text: string }[] }).content[0].text,
    ).toBe('[fake agent] hello there')
    // And it's durable.
    const stored = await getMessages(db, 's1')
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})
