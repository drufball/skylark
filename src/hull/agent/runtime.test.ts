import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'

import { createAgentRuntime, type PiSession } from './runtime'
import {
  appendMessage,
  createSession,
  getMessages,
  getSession,
  setStatus,
} from './service'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** Wait until a condition holds, polling across macrotasks. */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) {
    await new Promise((r) => setTimeout(r, 1))
  }
}

/**
 * A minimal AgentMessage for the fake. The runtime treats messages opaquely
 * (it only reads `.role` and stores them), so the full pi.dev message shape
 * isn't needed here — a structural cast keeps the fake readable.
 */
function msg(role: string, text: string): AgentMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    timestamp: 0,
  } as unknown as AgentMessage
}

/** A scriptable stand-in for pi.dev's AgentSession. */
class FakeSession implements PiSession {
  isStreaming = false
  agent = { state: { messages: [] as AgentMessage[] } }
  promptCalls: string[] = []
  followUpCalls: string[] = []
  aborted = false
  disposed = false
  /** History length observed at the start of the most recent prompt. */
  seededLength = -1
  /** Test override for what a prompt does to the transcript. */
  onPrompt: (text: string) => Promise<void> | void = (text) => {
    this.append(msg('user', text))
    this.append(msg('assistant', 'ok'))
    this.emit({
      type: 'turn_end',
      message: msg('assistant', 'ok'),
      toolResults: [],
    })
    this.emit({ type: 'agent_end', messages: this.messages, willRetry: false })
  }

  private listeners = new Set<(e: AgentSessionEvent) => void>()

  get messages(): AgentMessage[] {
    return this.agent.state.messages
  }

  append(message: AgentMessage): void {
    this.agent.state.messages = [...this.agent.state.messages, message]
  }

  emit(event: AgentSessionEvent): void {
    for (const l of this.listeners) l(event)
  }

  subscribe(listener: (e: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async prompt(text: string): Promise<void> {
    this.promptCalls.push(text)
    this.seededLength = this.messages.length
    this.isStreaming = true
    try {
      await this.onPrompt(text)
    } finally {
      this.isStreaming = false
    }
  }

  followUp(text: string): Promise<void> {
    this.followUpCalls.push(text)
    return Promise.resolve()
  }

  abort(): Promise<void> {
    this.aborted = true
    this.isStreaming = false
    return Promise.resolve()
  }

  dispose(): void {
    this.disposed = true
  }
}

describe('agent runtime', () => {
  let db: Database
  let close: () => Promise<void>
  let fake: FakeSession
  let runtime: ReturnType<typeof createAgentRuntime>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    fake = new FakeSession()
    runtime = createAgentRuntime({ db, factory: () => Promise.resolve(fake) })
  })
  afterEach(() => close())

  it('boots from stored history, seeds it into the session, and persists the new tail', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    await appendMessage(db, {
      sessionId: 's1',
      role: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'earlier' }] },
    })

    await runtime.runTurn('s1', 'hello')

    // The one prior message was seeded into the live session before prompting.
    expect(fake.seededLength).toBe(1)
    // The two new messages from this turn were persisted; the prior one isn't duplicated.
    const stored = await getMessages(db, 's1')
    expect(stored.map((m) => m.role)).toEqual(['user', 'user', 'assistant'])
    expect(defined(await getSession(db, 's1')).status).toBe('idle')
  })

  it('streams live events to an onEvent listener and unsubscribes after', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    const seen: string[] = []

    await runtime.runTurn('s1', 'hi', (event) => seen.push(event.type))
    expect(seen).toContain('turn_end')
    expect(seen).toContain('agent_end')

    // After the turn the listener is detached: a later emit isn't observed.
    const before = seen.length
    fake.emit({
      type: 'turn_end',
      message: msg('assistant', 'x'),
      toolResults: [],
    })
    expect(seen.length).toBe(before)
  })

  it('disposeAll releases every live session', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    await runtime.runTurn('s1', 'hi')

    runtime.disposeAll()
    expect(fake.disposed).toBe(true)
  })

  it('stringifies a non-Error thrown by a turn', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    fake.onPrompt = () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'kraken'
    }

    await expect(runtime.runTurn('s1', 'hi')).rejects.toBeDefined()
    expect(defined(await getSession(db, 's1')).error).toBe('kraken')
  })

  it('marks the session running during a turn and idle after', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    const gate = deferred()
    let statusDuringTurn: string | undefined
    fake.onPrompt = async () => {
      statusDuringTurn = (await getSession(db, 's1'))?.status
      await gate.promise
      fake.emit({
        type: 'agent_end',
        messages: fake.messages,
        willRetry: false,
      })
    }

    const turn = runtime.runTurn('s1', 'hi')
    await until(() => fake.isStreaming)
    gate.resolve()
    await turn

    expect(statusDuringTurn).toBe('running')
    expect(defined(await getSession(db, 's1')).status).toBe('idle')
  })

  it('queues a message when a turn is already in flight', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    const gate = deferred()
    fake.onPrompt = async () => {
      await gate.promise
    }

    const first = runtime.runTurn('s1', 'first')
    await until(() => fake.isStreaming) // first turn is now in flight
    await runtime.runTurn('s1', 'second') // should queue, not prompt again

    expect(fake.promptCalls).toEqual(['first'])
    expect(fake.followUpCalls).toEqual(['second'])

    gate.resolve()
    await first
  })

  it('records an error status when a turn throws', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    fake.onPrompt = () => {
      throw new Error('overloaded')
    }

    await expect(runtime.runTurn('s1', 'hi')).rejects.toThrow('overloaded')
    const row = defined(await getSession(db, 's1'))
    expect(row.status).toBe('error')
    expect(row.error).toBe('overloaded')
  })

  it('cancels a live turn: aborts the session and forces status idle', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    const gate = deferred()
    fake.onPrompt = async () => {
      await gate.promise
    }

    const turn = runtime.runTurn('s1', 'hi')
    await until(() => fake.isStreaming)
    await runtime.cancel('s1')

    expect(fake.aborted).toBe(true)
    expect(defined(await getSession(db, 's1')).status).toBe('idle')

    gate.resolve()
    await turn
  })

  it('cancels a non-live session by just forcing status idle', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    await runtime.runTurn('s1', 'hi') // completes, session stays in registry but idle
    // Simulate a stale "running" left by a crashed process elsewhere.
    await setStatus(db, 's1', 'running')
    runtime.dispose('s1')

    await runtime.cancel('s1')
    expect(defined(await getSession(db, 's1')).status).toBe('idle')
  })

  it('throws when sending to a session that does not exist', async () => {
    await expect(runtime.runTurn('ghost', 'hi')).rejects.toThrow(
      'No such session',
    )
  })
})
