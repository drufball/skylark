import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type {
  AgentSessionEvent,
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'

import type { PiSession } from './runtime'

// A deterministic stand-in for a pi.dev session: it returns a canned reply and
// emits the same turn_end/agent_end boundary events the real session does, so
// the runtime's persist-and-return chain behaves identically — but it never
// touches the network. This exists so the REAL server can boot and drive chat /
// build flows end to end in a smoke test without pi.dev or Claude.
//
// It also CALLS TOOLS, and it has to. Since chat stopped lifting an agent's text
// into the conversation, an agent that doesn't call `chat_post` says nothing —
// so a fake that only appended assistant text would leave every fake-runtime
// chat silent, and a smoke run would be testing a mute ship. The fake therefore
// speaks the way a real agent does: through whatever `chat_post` tool the host
// registered on its session. Same reasoning for widgets, which is why the marker
// below exists — it's the only way a runtime-less run can exercise the
// raise → tap → answer loop.
//
// The production wiring that switches between fake and live sessions lives in
// server-runtime.ts; this file contains only the fake implementation.

function textMessage(role: string, text: string): AgentMessage {
  return {
    role,
    content: [{ type: 'text', text }],
    timestamp: 0,
  } as unknown as AgentMessage
}

/** An assistant message carrying one tool call — how pi records a call. */
function toolCallMessage(name: string, args: unknown): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'fake-call', name, arguments: args }],
    timestamp: 0,
  } as unknown as AgentMessage
}

function toolResultMessage(name: string, text: string): AgentMessage {
  return {
    role: 'toolResult',
    toolCallId: 'fake-call',
    toolName: name,
    content: [{ type: 'text', text }],
    isError: false,
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

/**
 * The marker that makes the fake raise a widget instead of posting. Say it
 * anywhere in a message on a fake-runtime ship and the "agent" answers with a
 * yes/no widget — the only way to drive an agent RAISING a widget without a
 * model. Deliberately ugly so nobody mistakes it for a product feature.
 */
export const FAKE_WIDGET_MARKER = '[widget]'

/** The choice the marker raises — fixed, so a smoke test can assert on it. */
export const FAKE_WIDGET_QUESTION = 'Shall I go ahead?'

/**
 * What the fake does with the tools it was handed: raise a widget when the
 * prompt carries the marker, otherwise say its canned reply. Pure and exported
 * so the decision is unit-tested without a session.
 */
export function fakeToolCall(
  prompt: string,
): { name: string; args: Record<string, unknown> } | null {
  if (prompt.includes(FAKE_WIDGET_MARKER)) {
    return {
      name: 'chat_widget',
      args: {
        action: 'raise',
        question: FAKE_WIDGET_QUESTION,
        options: ['Yes', 'No'],
      },
    }
  }
  return { name: 'chat_post', args: { body: fakeReply(prompt) } }
}

/** A scriptless PiSession: one prompt → one canned turn, no network. */
class FakeSession implements PiSession {
  isStreaming = false
  agent = { state: { messages: [] as AgentMessage[] } }
  private readonly listeners = new Set<(e: AgentSessionEvent) => void>()

  constructor(private readonly tools: ToolDefinition[]) {}

  get messages(): AgentMessage[] {
    return this.agent.state.messages
  }

  subscribe(listener: (e: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async prompt(text: string): Promise<void> {
    const reply = fakeReply(text)
    this.append(textMessage('user', text))
    await this.speak(text)
    this.append(textMessage('assistant', reply))
    // Same boundary events the real session emits, so the runtime flushes the
    // new tail and returns it just as it would for a live turn.
    this.emit({
      type: 'turn_end',
      message: textMessage('assistant', reply),
      toolResults: [],
    })
    this.emit({ type: 'agent_end', messages: this.messages, willRetry: false })
  }

  followUp(): Promise<void> {
    return Promise.resolve()
  }

  // isStreaming is never set true (prompt does no model call), so there is
  // nothing for abort to clear.
  abort(): Promise<void> {
    return Promise.resolve()
  }

  dispose(): void {
    this.listeners.clear()
  }

  /**
   * Call the host's chat tool, if it registered one. A session with no chat
   * tools (a builder's, an inbox session) just skips this and appends its
   * assistant text as before — the whole point is that the fake speaks only
   * where a real agent could.
   *
   * A failing tool is recorded and swallowed: this is a stand-in for a model,
   * and a model that got a tool call wrong keeps going too.
   */
  private async speak(prompt: string): Promise<void> {
    const wanted = fakeToolCall(prompt)
    const tool = this.tools.find((t) => t.name === wanted?.name)
    if (!wanted || !tool) return
    this.append(toolCallMessage(tool.name, wanted.args))
    this.emit({
      type: 'tool_execution_start',
      toolName: tool.name,
      args: wanted.args,
    } as unknown as AgentSessionEvent)
    try {
      // pi's loop threads an ExtensionContext through; the chat tools don't read
      // it, and a fake has none to give.
      const result = await tool.execute(
        'fake-call',
        wanted.args,
        undefined,
        undefined,
        undefined as unknown as ExtensionContext,
      )
      const said = result.content
        .map((block) => ('text' in block ? block.text : ''))
        .join('')
      this.append(toolResultMessage(tool.name, said))
      /* v8 ignore next 4 -- a tool that throws is the model's problem, not the
         fake's; recorded and carried on, like pi's own loop does */
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.append(toolResultMessage(tool.name, `failed: ${message}`))
    }
  }

  private append(message: AgentMessage): void {
    this.agent.state.messages = [...this.agent.state.messages, message]
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

/**
 * The fake session factory — ignores config/cwd/model, but DOES take the host's
 * custom tools, because speaking is a tool call now. Every argument is optional
 * (still assignable to SessionFactory) so a test can construct a session with
 * nothing at all.
 */
export const createFakeSession = (
  _config?: unknown,
  _cwd?: string,
  _model?: string,
  customTools?: ToolDefinition[],
): Promise<PiSession> => Promise.resolve(new FakeSession(customTools ?? []))
