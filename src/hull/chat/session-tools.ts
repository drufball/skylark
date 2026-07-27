import { uuidv7 } from '@earendil-works/pi-agent-core'
import {
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { type Static, Type } from 'typebox'

import type { SessionToolsProvider } from '@hull/agent/runtime'
import type { Database } from '@hull/db/client'

import {
  addMessage,
  addWidget,
  dismissWidget,
  findChatForSession,
  reorderWidget,
} from './service'

// The agent-facing door onto a chat: the tools an agent's own turn uses to SPEAK
// and to put a widget in front of the crew.
//
// This is the inversion. Chat used to lift the assistant's text out of a
// finished turn and post it on the agent's behalf — a codec between an agent and
// its own words, which rotted with every SDK bump and made "the agent chose to
// say nothing" indistinguishable from "the transcript shape changed". Now the
// agent speaks through the same door any actor uses: `addMessage`, as itself,
// under its own RLS context. It decides what is worth saying, it can say it
// mid-turn, and the tool call lands in the session transcript where the chat
// zine's "two surfaces over one conversation" says it belongs.
//
// WHY A SESSION TOOL AND NOT `npm run chat -- post` (the CLI is right there):
// the CLI would run inside the bash tool, and every foreground tool call is
// wrapped by the wall-clock tool budget (agent/tool-budget.ts). Speaking would
// then be budgeted like a build — and an agent whose post lost that race goes
// MUTE, with nothing in the chat to say why. On top of that a shell-out costs a
// child process, npm's startup, a fresh database connection and an actor
// re-resolve per reply. A registered tool is one insert on the connection we
// already have. The CLI stays as the human/debug door (and remains the ONLY door
// on an inbox session, which has no chat to speak into).
//
// Registered per session, so the closure carries the chat and the agent it
// speaks as — resolved once, at boot, from the membership row that points at
// this session. A session that backs no chat membership (an inbox session, a
// builder's) gets no tools at all, so a tool never exists where it has no chat.

const POST_PARAMS = Type.Object({
  body: Type.String({
    description:
      'What to say, as the crew will read it. Plain prose or markdown; no need to name yourself.',
  }),
})

const WIDGET_PARAMS = Type.Object({
  action: Type.Union(
    [Type.Literal('raise'), Type.Literal('reorder'), Type.Literal('dismiss')],
    {
      description:
        '"raise" a new question, "reorder" one already up, or "dismiss" one that no longer matters.',
    },
  ),
  question: Type.Optional(
    Type.String({
      description: 'raise: the question to put in front of the crew.',
    }),
  ),
  options: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'raise: the answers to offer, as tappable buttons (["Yes","No"] for a yes/no).',
    }),
  ),
  widgetId: Type.Optional(
    Type.String({ description: 'reorder/dismiss: which widget.' }),
  ),
  stackOrder: Type.Optional(
    Type.Number({
      description:
        'Where it sits in the stack, low first. Defaults to 0 on raise.',
    }),
  ),
})

/**
 * What a tool call reports back to the model: one line of text, plus the id of
 * whatever it created (null when it created nothing). `details` is always
 * present because pi's result type requires it.
 */
function said(text: string, id: string | null = null) {
  return { content: [{ type: 'text' as const, text }], details: { id } }
}

/**
 * Straighten out the one mistake a real model made on its first try: passing
 * `options` as a JSON-encoded STRING (`'["Yes","No"]'`) instead of an array.
 * pi's `prepareArguments` hook exists for exactly this — a compatibility shim
 * ahead of schema validation — and it's worth using here because the failure it
 * prevents is a question that never reaches a human's thumb. Anything else is
 * left alone for the schema to refuse, which the model then sees and can fix.
 */
export function prepareWidgetArgs(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) return args
  const record = args as Record<string, unknown>
  if (typeof record.options !== 'string') return args
  try {
    const parsed: unknown = JSON.parse(record.options)
    return Array.isArray(parsed) ? { ...record, options: parsed } : args
  } catch {
    // Not JSON — maybe a comma list, which is how the CLI spells it.
    const list = record.options.split(',').map((o) => o.trim())
    return { ...record, options: list }
  }
}

/**
 * `chat_post` — say something in this chat. The agent's only way to be heard:
 * nothing it thinks or writes in a turn reaches the crew otherwise (which is
 * exactly what `turnContext` tells it up front).
 *
 * Runs `addMessage` as the agent itself, so the post is an ORDINARY chat message
 * — same row, same `chat.message_posted` event, same SSE delivery, same
 * unseen-diffing as a human's. Including the rule that agents never trigger
 * agents: an @mention inside an agent's own post draws no reply, because
 * `targetsForMessage` looks at the AUTHOR, not the text.
 */
function chatPostTool(
  chat: { chatId: string; handle: string },
  agentUserId: string,
  asActor: AsActor,
): ToolDefinition {
  return defineTool({
    name: 'chat_post',
    label: 'Say something in the chat',
    description:
      'Say something in this chat, as yourself. This is the ONLY way your words reach the crew — nothing you think or write outside this tool is shown to them. Call it as soon as you have something useful to say (you may call it several times in one turn), and end your turn without calling it at all if you genuinely have nothing to add.',
    promptSnippet:
      'chat_post(body) — say something in this chat; the only thing the crew sees.',
    promptGuidelines: [
      'To speak in the chat, call `chat_post`. Text you write outside a tool call is never shown to the crew — it stays in your session transcript.',
      'Post the useful part as soon as you have it rather than saving everything for the end of a long turn; you can post again later in the same turn.',
    ],
    parameters: POST_PARAMS,
    execute: async (_toolCallId, params) => {
      const body = params.body.trim()
      if (!body) throw new Error('chat_post needs something to say')
      const id = uuidv7()
      await asActor(agentUserId, (tx) =>
        addMessage(tx, {
          id,
          chatId: chat.chatId,
          authorId: agentUserId,
          body,
        }),
      )
      return said(
        `Posted to the chat as @${chat.handle}. The crew can see it.`,
        id,
      )
    },
  })
}

/**
 * `chat_widget` — put a live little view in the chat's stack, above the composer.
 * The agent-facing door slice #cse1 deliberately left out: raising was CLI-only,
 * so the one actor with judgment about when to interrupt a human couldn't do it
 * from its own turn.
 *
 * This is what makes structured interaction real: an agent that needs a decision
 * raises a `choice` and the crew taps an option, instead of typing "yes or no?"
 * and hoping the reply parses. The answer comes back as an ordinary chat message
 * (see `answerWidget`), so nothing new carries it.
 *
 * Only `choice` — the one kind this ship knows (`widgets.ts`). The tool's own
 * schema is what keeps an agent from writing a blob that can't render: the CLI
 * can still store a bad one on purpose, because seeing the honest tile is how
 * you learn what you got wrong.
 */
function chatWidgetTool(
  chat: { chatId: string },
  agentUserId: string,
  asActor: AsActor,
): ToolDefinition {
  return defineTool({
    name: 'chat_widget',
    label: 'Raise a widget in the chat',
    description:
      'Ask the crew a question with a fixed set of answers: "raise" puts it above the composer as tappable buttons, and their answer arrives as an ordinary chat message. Prefer this over typing a question when the answers are known — it is one tap on a phone instead of a sentence. Also "reorder" (move one in the stack) and "dismiss" (take one down that no longer matters).',
    promptSnippet:
      'chat_widget(action, …) — raise a tappable question above the composer, or reorder/dismiss one.',
    promptGuidelines: [
      'When you need a decision from the crew and you know the possible answers, raise a `chat_widget` instead of asking in prose — they tap, and the answer comes back as a message.',
    ],
    parameters: WIDGET_PARAMS,
    prepareArguments: (args) =>
      prepareWidgetArgs(args) as Static<typeof WIDGET_PARAMS>,
    execute: async (_toolCallId, params) => {
      if (params.action === 'raise') {
        const question = params.question?.trim()
        const options = (params.options ?? [])
          .map((o) => o.trim())
          .filter(Boolean)
        if (!question)
          throw new Error('raising a widget needs a question to ask')
        if (options.length === 0)
          throw new Error('raising a widget needs at least one answer option')
        const id = uuidv7()
        await asActor(agentUserId, (tx) =>
          addWidget(tx, {
            id,
            chatId: chat.chatId,
            kind: 'choice',
            props: { question, options },
            stackOrder: params.stackOrder,
            createdById: agentUserId,
          }),
        )
        return said(
          `Raised widget ${id}. The crew sees "${question}" above the composer; their answer will arrive as a chat message.`,
          id,
        )
      }

      const widgetId = params.widgetId?.trim()
      if (!widgetId)
        throw new Error(`${params.action} needs the widgetId to act on`)
      if (params.action === 'dismiss') {
        await asActor(agentUserId, (tx) =>
          dismissWidget(tx, { widgetId, actorId: agentUserId }),
        )
        return said(`Dismissed widget ${widgetId}.`)
      }
      if (params.stackOrder === undefined)
        throw new Error('reorder needs a stackOrder to move the widget to')
      const stackOrder = params.stackOrder
      await asActor(agentUserId, (tx) =>
        reorderWidget(tx, { widgetId, actorId: agentUserId, stackOrder }),
      )
      return said(`Moved widget ${widgetId} to #${String(stackOrder)}.`)
    },
  })
}

/**
 * Runs a unit of work as a crew member, RLS-scoped — `withActor` from
 * db/client in the live shell, `asActor` from db/test-db in a test. Injected so
 * this module stays database-agnostic like every other service file, and so the
 * tools can be driven against PGlite with no pi session and no network.
 */
export type AsActor = <T>(
  actorId: string,
  fn: (db: Database) => Promise<T>,
) => Promise<T>

/**
 * Chat's contribution to a session's tools: `chat_post` and `chat_widget`, but
 * ONLY on a session that actually backs a chat membership.
 *
 * Every read and write here runs under the AGENT's own actor, never the
 * orchestrator's `systemDb` — including the "which chat is this?" lookup. So the
 * agent's door is gated by exactly the policy a human's tap is gated by
 * (membership is visibility, migration 0007), rather than by this code
 * remembering to check. An agent that was removed from a chat mid-session finds
 * no row and gets no tools on the next boot; if it still holds a live session,
 * the RLS `WITH CHECK` refuses the write.
 */
export function createChatSessionTools(deps: {
  asActor: AsActor
}): SessionToolsProvider {
  const { asActor } = deps
  return async ({ sessionId, agentUserId }) => {
    // An unattributed session has no identity to speak as, so there is nobody
    // to run the lookup — let alone post — as.
    if (!agentUserId) return []
    const chat = await asActor(agentUserId, (tx) =>
      findChatForSession(tx, { sessionId, agentUserId }),
    )
    if (!chat) return []
    return [
      chatPostTool(chat, agentUserId, asActor),
      chatWidgetTool(chat, agentUserId, asActor),
    ]
  }
}
