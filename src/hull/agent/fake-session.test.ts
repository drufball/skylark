import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { FAKE_RUNTIME_ENV } from '@hull/lib/env'

import {
  createFakeSession,
  fakeReply,
  resolveSessionFactory,
} from './fake-session'
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

describe('the fake session surface', () => {
  it('emits the turn boundaries on prompt and stays inert elsewhere', async () => {
    const session = await createFakeSession()
    const events: string[] = []
    const unsubscribe = session.subscribe((e) => events.push(e.type))

    await session.prompt('build this\nand more')
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
