import { uuidv7 } from '@earendil-works/pi-agent-core'
import type {
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSession } from '@hull/agent/service'
import type { Database } from '@hull/db/client'
import { asActor, defined, freshDb } from '@hull/db/test-db'
import { listEventsSince } from '@hull/events/service'
import { createUser } from '@hull/users/service'

import { createChatSessionTools, prepareWidgetArgs } from './session-tools'
import {
  addMessage,
  createChat,
  listCanvasPages,
  listCanvasWidgets,
  listMessages,
  listOpenWidgets,
  listWidgets,
  setMemberSession,
} from './service'
import { chatTopic } from './topic'
import { registerWidgetKinds, type WidgetKindSpec } from './widget-catalog'
import { offeredAnswer } from './widgets'

/**
 * The catalog the hull is HANDED at boot. A hull test can't import the rigging
 * registry (the deck direction forbids it — which is the whole reason the seam
 * exists), so it registers its own two kinds: one answerable, one not.
 */
const TEST_KINDS: WidgetKindSpec[] = [
  {
    kind: 'choice',
    summary: 'A question with a fixed set of answers.',
    propsDoc: '{ question: string, options: string[] }',
    example: { question: 'Ship it?', options: ['Yes', 'No'] },
    validate: (props) =>
      offeredAnswer(props) ? null : 'needs a question and options',
  },
  {
    kind: 'note',
    summary: 'A small markdown card.',
    propsDoc: '{ text: string }',
    example: { text: 'Standup 09:30' },
    validate: (props) =>
      typeof (props as { text?: unknown }).text === 'string'
        ? null
        : 'text must be a non-empty string',
  },
]

/**
 * Call a tool the way pi's agent loop does. `ctx` is the extension context the
 * loop threads through; neither chat tool touches it, so a test can hand over
 * nothing — the cast keeps that explicit rather than inventing a whole fake.
 */
type ToolResult = Awaited<ReturnType<ToolDefinition['execute']>>

function call(tool: ToolDefinition, params: unknown): Promise<ToolResult> {
  return tool.execute(
    'call-1',
    params,
    undefined,
    undefined,
    undefined as unknown as ExtensionContext,
  )
}

/** The id a tool result reported creating — how the next call names it. */
function createdId(result: ToolResult): string {
  return defined((result.details as { id?: string | null }).id)
}

/** The text a tool result said, joined — what the model reads back. */
function resultText(result: ToolResult): string {
  return result.content
    .map((block) => ('text' in block ? block.text : ''))
    .join('')
}

describe('prepareWidgetArgs', () => {
  it('reads props sent as a JSON string', () => {
    expect(
      prepareWidgetArgs({
        action: 'raise',
        kind: 'note',
        props: '{"text":"Standup"}',
      }),
    ).toStrictEqual({
      action: 'raise',
      kind: 'note',
      props: { text: 'Standup' },
    })
  })

  it('reads nested options sent as a JSON string — the mistake a real model made', () => {
    expect(
      prepareWidgetArgs({
        action: 'raise',
        kind: 'choice',
        props: { question: 'Ship it?', options: '["Yes", "No"]' },
      }),
    ).toStrictEqual({
      action: 'raise',
      kind: 'choice',
      props: { question: 'Ship it?', options: ['Yes', 'No'] },
    })
  })

  it('reads nested options sent as a comma list, the way the CLI spells it', () => {
    expect(
      prepareWidgetArgs({
        action: 'raise',
        kind: 'choice',
        props: { question: 'When?', options: 'Tonight, Tomorrow morning' },
      }),
    ).toMatchObject({ props: { options: ['Tonight', 'Tomorrow morning'] } })
  })

  it('falls back to a comma list when nested options are JSON but not a list', () => {
    expect(
      prepareWidgetArgs({
        action: 'raise',
        kind: 'choice',
        props: { question: 'q', options: '{"a":1}' },
      }),
    ).toMatchObject({ props: { options: ['{"a":1}'] } })
  })

  it('nests a blob written flat beside `action`, and infers the choice kind', () => {
    // Nesting under `props` is the one thing this tool's shape asks for that the
    // old choice-only one didn't, so it's the mistake most worth absorbing — a
    // flat question/options pair is unambiguously a choice.
    expect(
      prepareWidgetArgs({
        action: 'raise',
        question: 'Ship it?',
        options: ['Yes', 'No'],
      }),
    ).toStrictEqual({
      action: 'raise',
      kind: 'choice',
      props: { question: 'Ship it?', options: ['Yes', 'No'] },
    })
  })

  it('keeps an explicit kind over the inferred one', () => {
    expect(
      prepareWidgetArgs({
        action: 'raise',
        kind: 'poll',
        question: 'q',
        options: ['a'],
      }),
    ).toMatchObject({ kind: 'poll' })
  })

  it.each([
    ['only a question', { question: 'q' }],
    ['only options', { options: ['a'] }],
    ['neither', { text: 'a note' }],
  ])('infers no kind from a flat blob with %s', (_label, flat) => {
    // Guessing would raise a DIFFERENT widget than the agent meant. Leaving the
    // kind off means the agent sees "needs a kind" and the list of real kinds.
    const prepared = prepareWidgetArgs({ action: 'raise', ...flat })
    expect(Object.keys(prepared as object)).toEqual(['action', 'props'])
  })

  it('keeps a stack slot alongside the props it nested', () => {
    expect(
      prepareWidgetArgs({
        action: 'raise',
        kind: 'note',
        props: { text: 'hi' },
        stackOrder: 5,
      }),
    ).toStrictEqual({
      action: 'raise',
      kind: 'note',
      props: { text: 'hi' },
      stackOrder: 5,
    })
  })

  it('keeps a widgetId that arrived beside props rather than dropping it', () => {
    expect(
      prepareWidgetArgs({
        action: 'dismiss',
        props: { text: 'hi' },
        widgetId: 'w1',
      }),
    ).toStrictEqual({
      action: 'dismiss',
      props: { text: 'hi' },
      widgetId: 'w1',
    })
  })

  it('leaves reorder and dismiss alone — they carry no props', () => {
    expect(prepareWidgetArgs({ action: 'dismiss', widgetId: 'w1' })).toEqual({
      action: 'dismiss',
      widgetId: 'w1',
    })
    expect(
      prepareWidgetArgs({ action: 'reorder', widgetId: 'w1', stackOrder: 2 }),
    ).toEqual({ action: 'reorder', widgetId: 'w1', stackOrder: 2 })
  })

  it.each([
    ['null', 'null'],
    ['a list', '[1,2]'],
    ['a bare string', '"x"'],
    ['not JSON at all', 'Standup'],
  ])(
    'leaves props that are %s as a string for the schema to refuse',
    (_l, props) => {
      // Only a JSON OBJECT is a props blob; anything else must reach the schema
      // untouched rather than being coerced into something that looks valid.
      const args = { action: 'raise', kind: 'note', props }
      expect(prepareWidgetArgs(args)).toBe(args)
    },
  )

  it('leaves anything that isn’t an object for the schema to judge', () => {
    expect(prepareWidgetArgs(null)).toBeNull()
    expect(prepareWidgetArgs('nope')).toBe('nope')
    // An explicitly null `props` with nothing else is nothing to nest.
    const empty = { action: 'raise', props: null }
    expect(prepareWidgetArgs(empty)).toBe(empty)
  })
})

describe('chat session tools', () => {
  let db: Database
  let close: () => Promise<void>
  let dru: string
  let tilde: string
  let bix: string
  let chatId: string
  let sessionId: string
  /** The provider under test, wired to run as the acting agent under RLS. */
  let tools: ReturnType<typeof createChatSessionTools>

  beforeEach(async () => {
    registerWidgetKinds(TEST_KINDS)
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
    chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
    sessionId = uuidv7()
    await createSession(db, { id: sessionId, model: 'm', agentUserId: tilde })
    await setMemberSession(db, chatId, tilde, sessionId)
    tools = createChatSessionTools({
      asActor: (actorId, fn) => asActor(db, actorId, fn),
    })
  })
  afterEach(() => close())

  /** The tools a session boots with, by name. */
  async function toolsFor(
    session: { sessionId: string; agentUserId: string | null } = {
      sessionId,
      agentUserId: tilde,
    },
  ): Promise<ToolDefinition[]> {
    return tools({ ...session, cwd: '/repo' })
  }

  async function toolNamed(name: string): Promise<ToolDefinition> {
    return defined((await toolsFor()).find((t) => t.name === name))
  }

  it('offers both doors on a session that backs a chat membership', async () => {
    expect((await toolsFor()).map((t) => t.name)).toEqual([
      'chat_post',
      'chat_widget',
    ])
  })

  it('offers nothing on a session that speaks for no chat', async () => {
    // An inbox session or a builder's: there is no chat to post into, so the
    // tool must not exist at all rather than exist and fail when called. (The
    // chat CLI is still the inbox session's door — it has to FIND a chat first.)
    const bare = uuidv7()
    await createSession(db, { id: bare, model: 'm', agentUserId: tilde })
    expect(await toolsFor({ sessionId: bare, agentUserId: tilde })).toEqual([])
  })

  it('offers nothing on an unattributed session', async () => {
    // No agentUserId → no identity to speak as, so there is nobody to post as.
    expect(await toolsFor({ sessionId, agentUserId: null })).toEqual([])
  })

  it("offers nothing to an agent that isn't the session's own member", async () => {
    // The membership row must be BOTH this session's and this agent's, so a
    // session id can never be borrowed to speak as somebody else.
    expect(await toolsFor({ sessionId, agentUserId: bix })).toEqual([])
  })

  // --- The canvas doors ----------------------------------------------------
  //
  // Same tool, because they are the same act: deciding what the crew should have
  // in front of them. `place` is the state-shaped half of `raise`.

  it('creates a canvas page and names it', async () => {
    const widget = await toolNamed('chat_widget')
    const result = await call(widget, { action: 'new_page', title: 'Ops' })
    expect(await listCanvasPages(db, chatId)).toMatchObject([{ title: 'Ops' }])
    expect(resultText(result)).toContain('Ops')
  })

  it('renames a page it can name rather than needing its id', async () => {
    const widget = await toolNamed('chat_widget')
    await call(widget, { action: 'new_page', title: 'Untitled' })
    await call(widget, {
      action: 'rename_page',
      page: 'Untitled',
      title: 'Standup',
    })
    expect(await listCanvasPages(db, chatId)).toMatchObject([
      { title: 'Standup' },
    ])
  })

  it('raises a widget straight onto a canvas page', async () => {
    const widget = await toolNamed('chat_widget')
    await call(widget, { action: 'new_page', title: 'Ops' })
    const result = await call(widget, {
      action: 'raise',
      kind: 'note',
      props: { text: 'deploys today: 4' },
      page: 'Ops',
    })
    expect(await listOpenWidgets(db, chatId)).toEqual([])
    expect(await listCanvasWidgets(db, chatId)).toMatchObject([
      { kind: 'note', placement: 'canvas' },
    ])
    expect(resultText(result)).toContain('Ops')
  })

  it('moves a widget from the stack to the canvas, and back again', async () => {
    const widget = await toolNamed('chat_widget')
    await call(widget, { action: 'new_page', title: 'Ops' })
    const raised = await call(widget, {
      action: 'raise',
      kind: 'note',
      props: { text: 'a readout' },
    })
    const widgetId = createdId(raised)

    await call(widget, { action: 'place', widgetId, page: 'Ops' })
    expect(await listCanvasWidgets(db, chatId)).toHaveLength(1)

    // The move back is how an agent RAISES a canvas widget for attention: an
    // ordinary update, no special mechanism.
    await call(widget, { action: 'stack', widgetId })
    expect(await listCanvasWidgets(db, chatId)).toEqual([])
    expect(await listOpenWidgets(db, chatId)).toHaveLength(1)
  })

  it('places at the cells it was given, clamped into the grid', async () => {
    const widget = await toolNamed('chat_widget')
    await call(widget, { action: 'new_page', title: 'Ops' })
    const raised = await call(widget, {
      action: 'raise',
      kind: 'note',
      props: { text: 'wide' },
    })
    await call(widget, {
      action: 'place',
      widgetId: createdId(raised),
      page: 'Ops',
      gridX: 0,
      gridY: 1,
      gridW: 99,
      gridH: 2,
    })
    expect(await listCanvasWidgets(db, chatId)).toMatchObject([
      { gridX: 0, gridY: 1, gridW: 4, gridH: 2 },
    ])
  })

  it('lands on the only page when the agent named none', async () => {
    const widget = await toolNamed('chat_widget')
    await call(widget, { action: 'new_page', title: 'Ops' })
    const raised = await call(widget, {
      action: 'raise',
      kind: 'note',
      props: { text: 'a readout' },
    })
    await call(widget, {
      action: 'place',
      widgetId: createdId(raised),
    })
    expect(await listCanvasWidgets(db, chatId)).toHaveLength(1)
  })

  it('says which pages exist when it is asked for one that does not', async () => {
    // The agent can fix this mid-turn, which is the whole reason the refusal
    // carries the list rather than just saying no.
    const widget = await toolNamed('chat_widget')
    await call(widget, { action: 'new_page', title: 'Ops' })
    const raised = await call(widget, {
      action: 'raise',
      kind: 'note',
      props: { text: 'a readout' },
    })
    await expect(
      call(widget, {
        action: 'place',
        widgetId: createdId(raised),
        page: 'Numbers',
      }),
    ).rejects.toThrow(/Ops/)
  })

  it('tells the agent to make a page when the chat has no canvas yet', async () => {
    const widget = await toolNamed('chat_widget')
    const raised = await call(widget, {
      action: 'raise',
      kind: 'note',
      props: { text: 'a readout' },
    })
    await expect(
      call(widget, {
        action: 'place',
        widgetId: createdId(raised),
      }),
    ).rejects.toThrow(/new_page/)
  })

  it('describes the canvas in its own description, so an agent knows it exists', async () => {
    const widget = await toolNamed('chat_widget')
    expect(widget.description).toContain('canvas')
    // The kinds are still GENERATED from the catalog, not written twice.
    expect(widget.description).toContain('note — A small markdown card.')
  })

  it('has no door for moving somebody else’s view — that is deliberate', async () => {
    // Agent-driven focus is a later, carefully-designed thing. Until then the
    // tool must not even suggest it: an agent that believes it can move a
    // person's page will try, and waste a turn discovering it can't.
    const widget = await toolNamed('chat_widget')
    const actions = JSON.stringify(widget.parameters)
    expect(actions).not.toContain('focus')
    expect(actions).not.toContain('view')
  })

  it('posts an ordinary chat message authored by the agent itself', async () => {
    const post = await toolNamed('chat_post')
    const result = await call(post, { body: '  the build is green  ' })

    const messages = await listMessages(db, chatId)
    expect(messages.map((m) => `${m.authorHandle}:${m.body}`)).toEqual([
      'tilde:the build is green',
    ])
    // And the model is told plainly that the words landed.
    expect(resultText(result)).toContain('@tilde')

    // It is an ORDINARY post: the same event every other message emits, so SSE
    // delivery, unseen diffing and reply targeting need nothing new.
    const events = await listEventsSince(db, {
      topicPatterns: [chatTopic(chatId)],
      audience: 'members',
    })
    expect(events.map((e) => e.type)).toContain('chat.message_posted')
  })

  it('posts more than once in a turn — speaking is not once-per-turn', async () => {
    const post = await toolNamed('chat_post')
    await call(post, { body: 'looking now' })
    await call(post, { body: 'found it: the migration was missing' })

    expect((await listMessages(db, chatId)).map((m) => m.body)).toEqual([
      'looking now',
      'found it: the migration was missing',
    ])
  })

  it('refuses an empty post rather than posting a blank message', async () => {
    const post = await toolNamed('chat_post')
    await expect(call(post, { body: '   ' })).rejects.toThrow(
      'something to say',
    )
    expect(await listMessages(db, chatId)).toHaveLength(0)
  })

  it('raises a choice widget into the stack, in the agent’s own name', async () => {
    const widget = await toolNamed('chat_widget')
    const result = await call(widget, {
      action: 'raise',
      kind: 'choice',
      props: { question: 'Ship it?', options: ['Yes', 'Not yet'] },
    })

    const [row] = await listOpenWidgets(db, chatId)
    expect(row.createdByHandle).toBe('tilde')
    expect(row.kind).toBe('choice')
    expect(row.props).toEqual({
      question: 'Ship it?',
      options: ['Yes', 'Not yet'],
    })
    // The model is told the answer is coming back as a message, because for an
    // answerable kind that's the next thing that happens to it.
    expect(resultText(result)).toContain('chat message')
  })

  it('raises any kind the catalog knows, props passed through untouched', async () => {
    // The tool learned `note` without a line of code here: the catalog is
    // injected, so a kind added in the rigging registry is raisable at once.
    const widget = await toolNamed('chat_widget')
    const result = await call(widget, {
      action: 'raise',
      kind: 'note',
      props: { text: '**Standup** 09:30' },
    })
    const [row] = await listOpenWidgets(db, chatId)
    expect(row.kind).toBe('note')
    expect(row.props).toEqual({ text: '**Standup** 09:30' })
    // Nothing to answer, so it doesn't promise a reply that will never come.
    expect(resultText(result)).not.toContain('chat message')
  })

  it('tells the agent which kinds exist, generated from the catalog', async () => {
    const widget = await toolNamed('chat_widget')
    for (const spec of TEST_KINDS) {
      expect(widget.description).toContain(spec.kind)
      expect(widget.description).toContain(spec.propsDoc)
    }
  })

  it('refuses a kind the ship can’t render, and says what it can', async () => {
    // An agent can fix this mid-turn, which is worth far more than storing a
    // row that renders as a dud tile in a human's face. (The CLI still stores
    // one deliberately — that's how you SEE the dud.)
    const widget = await toolNamed('chat_widget')
    await expect(
      call(widget, { action: 'raise', kind: 'orrery', props: {} }),
    ).rejects.toThrow(/orrery.*choice, note/s)
    expect(await listOpenWidgets(db, chatId)).toHaveLength(0)
  })

  it('refuses props that don’t fit the kind, quoting the reason', async () => {
    const widget = await toolNamed('chat_widget')
    await expect(
      call(widget, {
        action: 'raise',
        kind: 'choice',
        props: { question: 'q' },
      }),
    ).rejects.toThrow(/choice.*question and options/s)
    expect(await listOpenWidgets(db, chatId)).toHaveLength(0)
  })

  it('trims the kind and the widgetId a model padded with spaces', async () => {
    // A padded kind would otherwise be an "unknown kind" refusal, and a padded
    // widgetId a "no such widget" — both baffling to read.
    const widget = await toolNamed('chat_widget')
    await call(widget, {
      action: 'raise',
      kind: ' note ',
      props: { text: 'hi' },
    })
    const row = defined((await listOpenWidgets(db, chatId)).at(0))
    expect(row.kind).toBe('note')
    await call(widget, { action: 'dismiss', widgetId: `  ${row.id}  ` })
    expect(await listOpenWidgets(db, chatId)).toHaveLength(0)
  })

  it('refuses a raise with no kind at all, listing the ones there are', async () => {
    const widget = await toolNamed('chat_widget')
    await expect(
      call(widget, { action: 'raise', props: { text: 'hi' } }),
    ).rejects.toThrow(/needs a kind/)
  })

  it('refuses everything when the catalog was never registered', async () => {
    // Loud, not silent: an unregistered catalog is a boot fault (src/boot.ts),
    // and an agent quietly storing unrenderable rows would be far harder to see.
    registerWidgetKinds([])
    const widget = await toolNamed('chat_widget')
    await expect(
      call(widget, { action: 'raise', kind: 'note', props: { text: 'hi' } }),
    ).rejects.toThrow(/no widget kinds/)
  })

  it('honours a stack slot on raise, and 0 by default', async () => {
    const widget = await toolNamed('chat_widget')
    await call(widget, {
      action: 'raise',
      kind: 'choice',
      props: { question: 'second', options: ['ok'] },
      stackOrder: 5,
    })
    await call(widget, {
      action: 'raise',
      kind: 'choice',
      props: { question: 'first', options: ['ok'] },
    })

    expect(
      (await listOpenWidgets(db, chatId)).map(
        (w) => offeredAnswer(w.props)?.question,
      ),
    ).toEqual(['first', 'second'])
  })

  it('reorders and dismisses a widget it already raised', async () => {
    const widget = await toolNamed('chat_widget')
    await call(widget, {
      action: 'raise',
      kind: 'choice',
      props: { question: 'q', options: ['a'] },
    })
    const widgetId = defined((await listOpenWidgets(db, chatId)).at(0)).id

    await call(widget, { action: 'reorder', widgetId, stackOrder: 3 })
    expect(defined((await listOpenWidgets(db, chatId)).at(0)).stackOrder).toBe(
      3,
    )

    await call(widget, { action: 'dismiss', widgetId })
    expect(await listOpenWidgets(db, chatId)).toHaveLength(0)
    // The row survives as history — what was asked, and when it left the stack.
    expect(
      defined((await listWidgets(db, chatId)).at(0)).dismissedAt,
    ).not.toBeNull()
  })

  it('refuses reorder/dismiss without the pieces they need', async () => {
    const widget = await toolNamed('chat_widget')
    await expect(call(widget, { action: 'dismiss' })).rejects.toThrow(
      'widgetId',
    )
    await expect(
      call(widget, { action: 'reorder', widgetId: 'w1' }),
    ).rejects.toThrow('stackOrder')
  })

  it('cannot reach a widget in a chat the agent is not in — RLS is the gate', async () => {
    // The tools run as the agent, so the membership policy filters them exactly
    // as it filters a human's tap; there is no in-code chat check to forget.
    const elsewhere = uuidv7()
    await createChat(db, { id: elsewhere, memberIds: [dru, bix] })
    await addMessage(db, {
      id: uuidv7(),
      chatId: elsewhere,
      authorId: dru,
      body: 'private',
    })
    const theirs = uuidv7()
    await createSession(db, { id: theirs, model: 'm', agentUserId: bix })
    await setMemberSession(db, elsewhere, bix, theirs)
    const bixWidgets = defined(
      (await toolsFor({ sessionId: theirs, agentUserId: bix })).find(
        (t) => t.name === 'chat_widget',
      ),
    )
    await call(bixWidgets, {
      action: 'raise',
      kind: 'choice',
      props: { question: 'theirs', options: ['x'] },
    })
    const widgetId = defined((await listOpenWidgets(db, elsewhere)).at(0)).id

    const mine = await toolNamed('chat_widget')
    await expect(call(mine, { action: 'dismiss', widgetId })).rejects.toThrow(
      'no such widget',
    )
  })
})
