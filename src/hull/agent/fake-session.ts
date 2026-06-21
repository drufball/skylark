import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

import type { Database } from '@hull/db/client'

import {
  type AgentRuntime,
  createAgentRuntime,
  createPiSession,
  type PiSession,
  type SessionFactory,
} from './runtime'

// A deterministic stand-in for a pi.dev session: it returns a canned reply and
// emits the same turn_end/agent_end boundary events the real session does, so
// the runtime's persist-and-return chain behaves identically — but it never
// touches the network. This exists so the REAL server can boot and drive chat /
// build flows end to end in a smoke test without pi.dev or Claude.
//
// The env flag is the only switch: `SKYLARK_FAKE_RUNTIME` set → fake; unset →
// the live wiring. `resolveSessionFactory` is the single place the choice is
// made, so every runtime construction site (agent door, chat + issue
// orchestrators) stays in lockstep.

/** Env var that swaps the live session factory for the deterministic fake. */
export const FAKE_RUNTIME_ENV = 'SKYLARK_FAKE_RUNTIME'

function textMessage(role: string, text: string): AgentMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    timestamp: 0,
  } as unknown as AgentMessage
}

/**
 * The canned reply for a prompt — deterministic and recognizable in a
 * transcript (so a smoke test can assert it), with no model call. Echoes the
 * prompt's first line so a reply is traceable to what triggered it.
 */
export function fakeReply(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0]?.trim() ?? ''
  return firstLine ? `[fake agent] ${firstLine}` : '[fake agent]'
}

/** A scriptless PiSession: one prompt → one canned assistant turn, no network. */
class FakeSession implements PiSession {
  isStreaming = false
  agent = { state: { messages: [] as AgentMessage[] } }
  private readonly listeners = new Set<(e: AgentSessionEvent) => void>()

  get messages(): AgentMessage[] {
    return this.agent.state.messages
  }

  subscribe(listener: (e: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  prompt(text: string): Promise<void> {
    const reply = fakeReply(text)
    this.append(textMessage('user', text))
    this.append(textMessage('assistant', reply))
    // Same boundary events the real session emits, so the runtime flushes the
    // new tail and returns it just as it would for a live turn. The fake is
    // synchronous (no model call), so there's nothing to await.
    this.emit({
      type: 'turn_end',
      message: textMessage('assistant', reply),
      toolResults: [],
    })
    this.emit({ type: 'agent_end', messages: this.messages, willRetry: false })
    return Promise.resolve()
  }

  followUp(): Promise<void> {
    return Promise.resolve()
  }

  abort(): Promise<void> {
    this.isStreaming = false
    return Promise.resolve()
  }

  dispose(): void {
    this.listeners.clear()
  }

  private append(message: AgentMessage): void {
    this.agent.state.messages = [...this.agent.state.messages, message]
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/**
 * The fake session factory — ignores profile/cwd/model; every call is hermetic.
 * Typed as a zero-arg function (still assignable to SessionFactory) so tests can
 * construct a session without a ResolvedProfile.
 */
export const createFakeSession = (): Promise<PiSession> =>
  Promise.resolve(new FakeSession())

/**
 * The session factory the server should use: the live pi.dev wiring, or the
 * deterministic fake when `SKYLARK_FAKE_RUNTIME` is set.
 */
export function resolveSessionFactory(): SessionFactory {
  return process.env[FAKE_RUNTIME_ENV] ? createFakeSession : createPiSession
}

/**
 * The runtime every SERVER construction site boots — the agent door and the
 * chat + issue orchestrators. Centralised so the factory choice (live vs fake)
 * has exactly one home and the three sites can't drift. (The CLI builds its own
 * always-live runtime directly; it's interactive and never part of a smoke run.)
 */
export function createServerRuntime(db: Database): AgentRuntime {
  return createAgentRuntime({ db, factory: resolveSessionFactory() })
}
