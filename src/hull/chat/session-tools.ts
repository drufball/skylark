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
  createCanvasPage,
  dismissWidget,
  findChatForSession,
  listCanvasPages,
  placeWidget,
  renameCanvasPage,
  reorderWidget,
  stackWidget,
} from './service'
import {
  describeWidgetKinds,
  knownWidgetKinds,
  validateWidgetProps,
} from './widget-catalog'
import {
  CANVAS_COLUMNS,
  offeredAnswer,
  type CanvasBox,
  type JsonValue,
} from './widgets'

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
    [
      Type.Literal('raise'),
      Type.Literal('reorder'),
      Type.Literal('dismiss'),
      Type.Literal('place'),
      Type.Literal('stack'),
      Type.Literal('new_page'),
      Type.Literal('rename_page'),
    ],
    {
      description:
        '"raise" a new widget, "reorder" one already up, "dismiss" one that no longer matters, "place" one onto a canvas page, "stack" one back above the composer, "new_page"/"rename_page" for the canvas pages themselves.',
    },
  ),
  kind: Type.Optional(
    Type.String({
      description:
        'raise: which kind of widget — one of the kinds listed in this tool’s description.',
    }),
  ),
  page: Type.Optional(
    Type.String({
      description:
        'raise/place/rename_page: which canvas page, by its name (or its id). Omit on place to use the chat’s first page.',
    }),
  ),
  title: Type.Optional(
    Type.String({ description: 'new_page/rename_page: the page’s name.' }),
  ),
  gridX: Type.Optional(
    Type.Number({
      description: `raise/place: column, 0…${String(CANVAS_COLUMNS - 1)}. Omit both gridX and gridY to be given the first free slot.`,
    }),
  ),
  gridY: Type.Optional(
    Type.Number({ description: 'raise/place: row, 0 is top.' }),
  ),
  gridW: Type.Optional(
    Type.Number({
      description: `raise/place: width in columns, 1…${String(CANVAS_COLUMNS)}.`,
    }),
  ),
  gridH: Type.Optional(
    Type.Number({ description: 'raise/place: height in rows.' }),
  ),
  props: Type.Optional(
    // A free-form object, because the shape depends on the kind. The kinds and
    // their shapes are spelled out in the tool's description, which is generated
    // from the catalog — so this schema stays honest as kinds come and go
    // instead of freezing one kind's fields into the signature (which is what
    // slice #cse2's `question`/`options` did).
    Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          'raise: the kind’s own props, exactly as its shape in this tool’s description says.',
      },
    ),
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
 * The grid cells a call asked for, with anything it left out left out — so
 * `placeWidget` can tell "put it at column 2" from "find it a slot", which is
 * the difference between honouring an agent's layout and inventing one.
 */
function boxFrom(params: {
  gridX?: number
  gridY?: number
  gridW?: number
  gridH?: number
}): Partial<CanvasBox> {
  return {
    ...(params.gridX === undefined ? {} : { gridX: params.gridX }),
    ...(params.gridY === undefined ? {} : { gridY: params.gridY }),
    ...(params.gridW === undefined ? {} : { gridW: params.gridW }),
    ...(params.gridH === undefined ? {} : { gridH: params.gridH }),
  }
}

/** A JSON-encoded list, or a comma list, read back into an array of strings. */
function asList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.map((o) => String(o))
  } catch {
    // Not JSON — maybe a comma list, which is how the CLI spells it.
  }
  return value.split(',').map((o) => o.trim())
}

/**
 * Straighten out the mistakes real models actually make on the way in, before the
 * schema sees them. pi's `prepareArguments` hook exists for exactly this — a
 * compatibility shim ahead of validation — and it's worth using because the
 * failure it prevents is a question that never reaches a human's thumb. Three
 * shims, each for a mistake that's been observed or is one keystroke away:
 *
 * - `props` arriving as a JSON STRING rather than an object;
 * - a nested `options` arriving as a JSON string or a comma list;
 * - the whole blob FLATTENED onto the top level (`question`/`options`/`text`
 *   beside `action`) instead of nested under `props`. Nesting is the one thing
 *   this tool's shape asks for that the old one didn't, so it's the mistake most
 *   worth absorbing.
 *
 * Anything else is left alone for the schema — and then the catalog's own
 * validator — to refuse, which the model sees in the tool result and can fix.
 */
export function prepareWidgetArgs(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) return args
  // EVERY named parameter is destructured out here, not just the ones the shims
  // touch: whatever is left over is treated as a flattened props blob below, so
  // a `page` left in `rest` would be swept into `props` and the call would lose
  // the page it was meant to land on.
  const {
    action,
    kind,
    props,
    widgetId,
    stackOrder,
    page,
    title,
    gridX,
    gridY,
    gridW,
    gridH,
    ...rest
  } = args as Record<string, unknown>
  const named = {
    widgetId,
    stackOrder,
    page,
    title,
    gridX,
    gridY,
    gridW,
    gridH,
  }

  let blob: Record<string, unknown> | undefined
  if (typeof props === 'string') {
    try {
      const parsed: unknown = JSON.parse(props)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      )
        blob = parsed as Record<string, unknown>
    } catch {
      // Not JSON at all — leave it for the schema to refuse.
    }
  } else if (typeof props === 'object' && props !== null) {
    blob = props as Record<string, unknown>
  } else if (Object.keys(rest).length > 0) {
    // Flattened: the props were written beside `action` instead of under it.
    blob = rest
  }
  if (!blob) return args

  if (typeof blob.options === 'string')
    blob = { ...blob, options: asList(blob.options) }

  // A flat `question`/`options` pair is unambiguously a `choice`, so an omitted
  // kind is inferable rather than an error the crew never sees an answer for.
  const resolvedKind =
    kind ??
    (blob.question !== undefined && blob.options !== undefined
      ? 'choice'
      : undefined)

  return {
    action,
    ...(resolvedKind === undefined ? {} : { kind: resolvedKind }),
    props: blob,
    ...Object.fromEntries(
      Object.entries(named).filter(([, value]) => value !== undefined),
    ),
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
 * raises a `choice` and the crew taps an option instead of typing "yes or no?"
 * and hoping the reply parses; an agent that wants a slice of the board in view
 * raises an `issue-list`. The answer to an answerable one comes back as an
 * ordinary chat message (see `answerWidget`), so nothing new carries it.
 *
 * **The kinds are not written here.** They're generated from the rigging catalog,
 * handed to the hull by the composition root (`widget-catalog.ts`), so a kind
 * added in one place is described in one place. That's also why the parameters are
 * `kind` + a free-form `props` rather than one kind's fields: freezing
 * `question`/`options` into the signature is what made slice #cse2's version a
 * choice-only tool.
 *
 * The catalog's own validator refuses a blob that can't render, with the reason —
 * an agent can fix that mid-turn, which is worth far more than a dud tile in a
 * human's face. The CLI still stores a bad blob on purpose, because seeing the
 * honest tile is how a human learns what the ship does with one.
 *
 * The CANVAS actions live on this same tool rather than a second one, because
 * they are the same act with a different half-life: `raise` puts something in
 * front of you now (the stack, turn-shaped), `place` puts something where you'll
 * keep looking at it (a canvas page, state-shaped). `stack` moves a canvas widget
 * back above the composer, which is how an agent raises a readout for attention —
 * an ordinary update, no separate "alert" mechanism. What is deliberately absent
 * is any way to move a PERSON's view: which page somebody is looking at is theirs
 * (see `chat_view_state`), and the turn context says so out loud.
 */
function chatWidgetTool(
  chat: { chatId: string },
  agentUserId: string,
  asActor: AsActor,
): ToolDefinition {
  const vocabulary = describeWidgetKinds(knownWidgetKinds())

  /**
   * The page an action means, by NAME or by id — an agent reads page names in
   * its turn context and has no reason to know an id. Omitted means the chat's
   * first page, so the common "put it on the canvas" needs no lookup at all.
   * A miss lists the real pages, because that's a mistake the agent can fix on
   * the spot.
   */
  async function resolvePage(name: string | undefined): Promise<string> {
    const pages = await asActor(agentUserId, (tx) =>
      listCanvasPages(tx, chat.chatId),
    )
    if (pages.length === 0)
      throw new Error(
        'this chat has no canvas pages yet — make one with action "new_page" first',
      )
    const wanted = name?.trim()
    if (!wanted) return pages[0].id
    const found = pages.find(
      (p) => p.id === wanted || p.title.toLowerCase() === wanted.toLowerCase(),
    )
    if (!found)
      throw new Error(
        `no canvas page called “${wanted}” — this chat's pages are: ${pages
          .map((p) => p.title)
          .join(', ')}`,
      )
    return found.id
  }

  return defineTool({
    name: 'chat_widget',
    label: 'Raise a widget in the chat',
    description:
      'Put a live little view in front of the crew. Two surfaces: the STACK above the composer is turn-shaped — "raise" something you need an answer or a glance at right now, "reorder" it, "dismiss" it when it stops mattering. The CANVAS is state-shaped — pages of tiles the crew arranged and keep coming back to; "place" a widget on a page (or "raise" with a page), "stack" it back above the composer when it needs attention now, and "new_page"/"rename_page" to manage the pages. A widget the crew can answer (a question with known answers) comes back as an ordinary chat message — prefer that over typing the question, it is one tap on a phone instead of a sentence. Each person chooses their own canvas page; you cannot move anyone’s view, so say where you put something.\n\n' +
      vocabulary,
    promptSnippet:
      'chat_widget(action, kind, props) — raise a live view above the composer, place one on a canvas page, or reorder/dismiss/move one.',
    promptGuidelines: [
      'When you need a decision from the crew and you know the possible answers, raise a `chat_widget` of kind `choice` instead of asking in prose — they tap, and the answer comes back as a message.',
      'The kinds this ship can render, and the props each one takes, are listed in `chat_widget`’s own description. Read it before raising one.',
      'Something the crew will want to keep an eye on belongs on the canvas (`place`), not the stack — the stack is for what needs answering now, and it clears.',
    ],
    parameters: WIDGET_PARAMS,
    prepareArguments: (args) =>
      prepareWidgetArgs(args) as Static<typeof WIDGET_PARAMS>,
    execute: async (_toolCallId, params) => {
      if (params.action === 'new_page') {
        const title = params.title?.trim()
        if (!title) throw new Error('new_page needs a title')
        const id = uuidv7()
        await asActor(agentUserId, (tx) =>
          createCanvasPage(tx, {
            id,
            chatId: chat.chatId,
            title,
            actorId: agentUserId,
          }),
        )
        return said(`Added the canvas page “${title}” to this chat.`, id)
      }
      if (params.action === 'rename_page') {
        const title = params.title?.trim()
        if (!title) throw new Error('rename_page needs a title')
        const pageId = await resolvePage(params.page)
        await asActor(agentUserId, (tx) =>
          renameCanvasPage(tx, { pageId, title, actorId: agentUserId }),
        )
        return said(`Renamed the canvas page to “${title}”.`, pageId)
      }

      if (params.action === 'raise') {
        const kind = params.kind?.trim()
        if (!kind)
          throw new Error(
            `raising a widget needs a kind. ${describeWidgetKinds(knownWidgetKinds())}`,
          )
        const props = (params.props ?? {}) as JsonValue
        // Read at CALL time, not at tool-definition time: the catalog is
        // registered at boot, and a session that outlives a re-registration
        // should see the current one rather than the one it booted with.
        const fault = validateWidgetProps(knownWidgetKinds(), kind, props)
        if (fault) throw new Error(fault)
        // A named page means "this belongs on the canvas" — resolved BEFORE the
        // row is written, so a bad page name doesn't leave a widget stranded in
        // the stack the agent then has to find and move.
        const pageId =
          params.page === undefined ? null : await resolvePage(params.page)
        const id = uuidv7()
        await asActor(agentUserId, async (tx) => {
          await addWidget(tx, {
            id,
            chatId: chat.chatId,
            kind,
            props,
            stackOrder: params.stackOrder,
            createdById: agentUserId,
          })
          if (pageId !== null) {
            await placeWidget(tx, {
              widgetId: id,
              actorId: agentUserId,
              pageId,
              ...boxFrom(params),
            })
          }
        })
        if (pageId !== null)
          return said(
            `Put a ${kind} widget (${id}) on the canvas page “${params.page ?? ''}”. It stays there until somebody moves it.`,
            id,
          )
        return said(
          `Raised a ${kind} widget (${id}) above the composer. The crew can see it${
            offeredAnswer(props)
              ? '; their answer will arrive as a chat message'
              : ''
          }.`,
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
      if (params.action === 'place') {
        const pageId = await resolvePage(params.page)
        await asActor(agentUserId, (tx) =>
          placeWidget(tx, {
            widgetId,
            actorId: agentUserId,
            pageId,
            ...boxFrom(params),
          }),
        )
        return said(`Placed widget ${widgetId} on the canvas.`, widgetId)
      }
      if (params.action === 'stack') {
        await asActor(agentUserId, (tx) =>
          stackWidget(tx, {
            widgetId,
            actorId: agentUserId,
            stackOrder: params.stackOrder,
          }),
        )
        return said(
          `Moved widget ${widgetId} off the canvas and back above the composer, where the crew will see it next.`,
          widgetId,
        )
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
