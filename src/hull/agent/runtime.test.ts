import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { defined, freshDb } from '@hull/db/test-db'

import { createProfile, registerExtension } from './profiles'
import { createAgentRuntime, type PiSession } from './runtime'
import type { ResolvedProfile } from './session-config'
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

  /**
   * Simulate pi.dev's auto-compaction: emit compaction_start (while the array
   * still holds the FULL transcript), then rewrite messages in place to
   * `[summary, ...recentSuffix]` and emit compaction_end. This mirrors the real
   * SDK ordering verified in agent-session.js: compaction_start fires before
   * agent.state.messages is reassigned, compaction_end after.
   */
  compact(keepFromIndex: number): void {
    this.emit({ type: 'compaction_start', reason: 'threshold' })
    const suffix = this.messages.slice(keepFromIndex)
    this.agent.state.messages = [msg('user', '[summary of earlier]'), ...suffix]
    this.emit({
      type: 'compaction_end',
      reason: 'threshold',
      result: undefined,
      aborted: false,
      willRetry: false,
    })
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
  let emitted: {
    type: string
    topic?: string
    audience?: string
  }[]
  /** What the factory was last called with — to assert profile resolution. */
  let factoryArgs: { profile: ResolvedProfile; cwd: string; model: string }[]

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    fake = new FakeSession()
    emitted = []
    factoryArgs = []
    runtime = createAgentRuntime({
      db,
      factory: (profile, cwd, model) => {
        factoryArgs.push({ profile, cwd, model })
        return Promise.resolve(fake)
      },
      emit: (e) => {
        emitted.push({
          type: e.type,
          topic: e.topic,
          audience: e.audience,
        })
        return Promise.resolve()
      },
    })
  })
  afterEach(() => close())

  it("resolves a session's profile + cwd and hands them to the factory", async () => {
    const ext = await registerExtension(db, {
      name: 'build-gates',
      description: 'gates',
      path: 'src/hull/agent/extensions/build-gates/index.ts',
    })
    const profile = await createProfile(db, {
      id: 'p1',
      name: 'builder',
      systemPrompt: 'build',
      tools: null,
      readContextFiles: true,
      useRepoSkills: true,
      extensionIds: [ext.id],
      model: 'claude-opus-4-5',
    })
    await createSession(db, {
      id: 's1',
      model: 'm',
      profileId: profile.id,
      cwd: '/tmp/worktree-x',
    })

    await runtime.runTurn('s1', 'hi')

    expect(factoryArgs).toHaveLength(1)
    const [args] = factoryArgs
    expect(args.cwd).toBe('/tmp/worktree-x')
    expect(args.model).toBe('m')
    expect(args.profile.systemPrompt).toBe('build')
    expect(args.profile.tools).toBeNull()
    expect(args.profile.model).toBe('claude-opus-4-5')
    // extensionIds were resolved to the registry path.
    expect(args.profile.extensionPaths).toEqual([
      'src/hull/agent/extensions/build-gates/index.ts',
    ])
  })

  it('falls back to the default profile (full tools) when a session has none', async () => {
    await createSession(db, { id: 's1', model: 'm' }) // no profileId, no cwd
    await runtime.runTurn('s1', 'hi')
    const [args] = factoryArgs
    expect(args.profile.tools).toBeNull() // default = full coding tools
    expect(args.profile.readContextFiles).toBe(true)
    expect(args.profile.useRepoSkills).toBe(true)
    expect(args.profile.extensionPaths).toEqual([])
    expect(args.cwd).toBe(process.cwd()) // null cwd → repo root
  })

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

  it('keeps the FULL history durable across a mid-session compaction', async () => {
    await createSession(db, { id: 's1', model: 'm' })

    // A turn that appends several messages, then compaction kicks in mid-turn,
    // collapsing the early ones into a summary and keeping only a recent tail.
    fake.onPrompt = (text) => {
      fake.append(msg('user', text)) // pi adds the user prompt to the transcript
      fake.append(msg('user', 'm0'))
      fake.append(msg('assistant', 'm1'))
      fake.append(msg('user', 'm2'))
      fake.append(msg('assistant', 'm3'))
      // Compaction: keep only the last two messages, summarize the rest.
      fake.compact(2)
      // Post-compaction the agent continues and produces another message.
      fake.append(msg('assistant', 'm4'))
      fake.emit({
        type: 'turn_end',
        message: msg('assistant', 'm4'),
        toolResults: [],
      })
      fake.emit({
        type: 'agent_end',
        messages: fake.messages,
        willRetry: false,
      })
    }

    await runtime.runTurn('s1', 'go')

    const stored = (await getMessages(db, 's1')).map(
      (r) => (r.message as { content: { text: string }[] }).content[0].text,
    )
    // Every real message ever produced is in the durable log, in order, once.
    expect(stored).toEqual(['go', 'm0', 'm1', 'm2', 'm3', 'm4'])
    // The compaction SUMMARY is never persisted as if it were history.
    expect(stored).not.toContain('[summary of earlier]')
  })

  it('persists post-compaction messages without re-persisting the kept suffix', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    // First turn: two messages, then a standalone compaction shrinks the array.
    fake.onPrompt = (text) => {
      fake.append(msg('user', text)) // pi adds the user prompt to the transcript
      fake.append(msg('user', 'a'))
      fake.append(msg('assistant', 'b'))
      fake.compact(1) // keep the recent suffix, summarize the rest
      fake.append(msg('assistant', 'c'))
      fake.emit({
        type: 'agent_end',
        messages: fake.messages,
        willRetry: false,
      })
    }
    await runtime.runTurn('s1', 'hi')

    const stored = (await getMessages(db, 's1')).map(
      (r) => (r.message as { content: { text: string }[] }).content[0].text,
    )
    // 'hi','a','b' flushed at compaction_start; 'c' flushed at agent_end. No dupes.
    expect(stored).toEqual(['hi', 'a', 'b', 'c'])
  })

  it('emits ship-log events for messages and status with topic and members audience', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    await runtime.runTurn('s1', 'hello')

    // Every emit has topic set to this session and audience=members.
    expect(emitted.every((e) => e.topic === 'session:s1')).toBe(true)
    expect(emitted.every((e) => e.audience === 'members')).toBe(true)
    // A status event marked it running, and message events fired for the turn.
    expect(emitted.map((e) => e.type)).toContain('agent.status')
    expect(emitted.map((e) => e.type)).toContain('agent.message')
    // Two messages this turn (user echo + assistant) → two message events.
    expect(emitted.filter((e) => e.type === 'agent.message')).toHaveLength(2)
  })

  it('never lets a failing emit break a turn', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    const runtimeBadEmit = createAgentRuntime({
      db,
      factory: () => Promise.resolve(fake),
      emit: () => Promise.reject(new Error('log down')),
    })

    // The turn completes and persists despite every emit throwing.
    const produced = await runtimeBadEmit.runTurn('s1', 'hi')
    expect(produced).toEqual(expect.any(Array))
    expect(defined(await getSession(db, 's1')).status).toBe('idle')
    expect((await getMessages(db, 's1')).length).toBeGreaterThan(0)
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

  it('drops a failed session from the registry so the next turn rebuilds it', async () => {
    // A failed turn could leave a permanently-rejected persistChain on the live
    // entry; reusing it would wedge the session forever. After an error the
    // entry must be disposed and the next turn must rebuild from durable history
    // (a fresh factory call), not reuse the poisoned one.
    await createSession(db, { id: 's1', model: 'm' })
    fake.onPrompt = () => {
      throw new Error('boom')
    }
    await expect(runtime.runTurn('s1', 'hi')).rejects.toThrow('boom')
    expect(fake.disposed).toBe(true) // the live entry was released
    expect(factoryArgs).toHaveLength(1)

    // Next turn: the same fake recovers; the runtime must boot it afresh.
    fake.disposed = false
    fake.onPrompt = (text) => {
      fake.append(msg('assistant', `ok:${text}`))
      fake.emit({
        type: 'agent_end',
        messages: fake.messages,
        willRetry: false,
      })
    }
    await runtime.runTurn('s1', 'again')
    expect(factoryArgs).toHaveLength(2) // rebuilt, not reused
    expect(defined(await getSession(db, 's1')).status).toBe('idle')
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

  it('returns the agent messages produced during the turn', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    fake.onPrompt = (text) => {
      fake.append(msg('user', text))
      fake.append(msg('assistant', 'reply one'))
      fake.append(msg('assistant', 'reply two'))
      fake.emit({
        type: 'turn_end',
        message: msg('assistant', 'reply two'),
        toolResults: [],
      })
      fake.emit({
        type: 'agent_end',
        messages: fake.messages,
        willRetry: false,
      })
    }

    const produced = await runtime.runTurn('s1', 'hello')

    // Returns all messages flushed this turn (pi echoes the user message too).
    expect(produced).toHaveLength(3)
    expect(produced[0]?.role).toBe('user')
    expect(produced[1]?.role).toBe('assistant')
    expect(produced[2]?.role).toBe('assistant')
    expect(
      (produced[1] as { content: { text: string }[] }).content[0].text,
    ).toBe('reply one')
    expect(
      (produced[2] as { content: { text: string }[] }).content[0].text,
    ).toBe('reply two')
  })

  it('returns an empty array when a message is queued (followUp path)', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    const gate = deferred()
    fake.onPrompt = async () => {
      await gate.promise
    }

    const first = runtime.runTurn('s1', 'first')
    await until(() => fake.isStreaming)
    const queued = await runtime.runTurn('s1', 'second')

    // The queued message returns [] immediately.
    expect(queued).toEqual([])

    gate.resolve()
    await first
  })

  it('returns messages that survived compaction', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    fake.onPrompt = (text) => {
      fake.append(msg('user', text))
      fake.append(msg('assistant', 'before'))
      fake.compact(0) // compact away everything
      fake.append(msg('assistant', 'after'))
      fake.emit({
        type: 'turn_end',
        message: msg('assistant', 'after'),
        toolResults: [],
      })
      fake.emit({
        type: 'agent_end',
        messages: fake.messages,
        willRetry: false,
      })
    }

    const produced = await runtime.runTurn('s1', 'go')

    // All messages were durably persisted and returned, despite compaction.
    expect(produced).toHaveLength(3)
    expect(
      (produced[0] as { content: { text: string }[] }).content[0].text,
    ).toBe('go')
    expect(
      (produced[1] as { content: { text: string }[] }).content[0].text,
    ).toBe('before')
    expect(
      (produced[2] as { content: { text: string }[] }).content[0].text,
    ).toBe('after')
  })

  it('persists the new tail on a turn_end even when no agent_end follows', async () => {
    await createSession(db, { id: 's1', model: 'm' })
    fake.onPrompt = () => {
      fake.append(msg('user', 'hi'))
      fake.append(msg('assistant', 'ok'))
      // Only a turn_end — no agent_end. Persistence must still flush here, or a
      // multi-turn session would silently lose every turn but its last.
      fake.emit({
        type: 'turn_end',
        message: msg('assistant', 'ok'),
        toolResults: [],
      })
    }

    await runtime.runTurn('s1', 'hi')

    const stored = await getMessages(db, 's1')
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('disposing an unknown session is a harmless no-op', () => {
    // No entry in the registry → must return early, not dereference undefined.
    expect(() => {
      runtime.dispose('never-existed')
    }).not.toThrow()
  })
})
