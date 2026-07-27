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
  listMessages,
  listOpenWidgets,
  listWidgets,
  setMemberSession,
} from './service'
import { chatTopic } from './topic'
import { parseProps } from './widgets'

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

/** The text a tool result said, joined — what the model reads back. */
function resultText(result: ToolResult): string {
  return result.content
    .map((block) => ('text' in block ? block.text : ''))
    .join('')
}

describe('prepareWidgetArgs', () => {
  it('accepts options as a JSON string — the mistake a real model made first try', () => {
    expect(
      prepareWidgetArgs({ action: 'raise', options: '["Yes", "No"]' }),
    ).toEqual({ action: 'raise', options: ['Yes', 'No'] })
  })

  it('accepts a comma list, the way the CLI spells it', () => {
    expect(prepareWidgetArgs({ options: 'Tonight, Tomorrow morning' })).toEqual(
      {
        options: ['Tonight', 'Tomorrow morning'],
      },
    )
  })

  it('leaves a proper array, and anything else, for the schema to judge', () => {
    const good = { action: 'raise', options: ['Yes'] }
    expect(prepareWidgetArgs(good)).toBe(good)
    // A JSON string that isn't an array falls through untouched.
    const notAList = { options: '{"a":1}' }
    expect(prepareWidgetArgs(notAList)).toBe(notAList)
    expect(prepareWidgetArgs(null)).toBeNull()
    expect(prepareWidgetArgs('nope')).toBe('nope')
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
      question: 'Ship it?',
      options: ['Yes', 'Not yet'],
    })

    const [row] = await listOpenWidgets(db, chatId)
    expect(row.createdByHandle).toBe('tilde')
    const parsed = parseProps(row.kind, row.props)
    expect(parsed.ok && parsed.props).toEqual({
      question: 'Ship it?',
      options: ['Yes', 'Not yet'],
    })
    expect(resultText(result)).toContain('Ship it?')
  })

  it('honours a stack slot on raise, and 0 by default', async () => {
    const widget = await toolNamed('chat_widget')
    await call(widget, {
      action: 'raise',
      question: 'second',
      options: ['ok'],
      stackOrder: 5,
    })
    await call(widget, { action: 'raise', question: 'first', options: ['ok'] })

    const parsedQuestions = (await listOpenWidgets(db, chatId)).map((w) => {
      const parsed = parseProps(w.kind, w.props)
      return parsed.ok ? parsed.props.question : '?'
    })
    expect(parsedQuestions).toEqual(['first', 'second'])
  })

  it('trims and drops blank options, and refuses a question with none left', async () => {
    const widget = await toolNamed('chat_widget')
    await call(widget, {
      action: 'raise',
      question: 'pick',
      options: [' Yes ', '  ', 'No'],
    })
    const [row] = await listOpenWidgets(db, chatId)
    const parsed = parseProps(row.kind, row.props)
    expect(parsed.ok && parsed.props.options).toEqual(['Yes', 'No'])

    await expect(
      call(widget, { action: 'raise', question: 'pick', options: ['  '] }),
    ).rejects.toThrow('answer option')
    await expect(
      call(widget, { action: 'raise', options: ['Yes'] }),
    ).rejects.toThrow('question')
  })

  it('reorders and dismisses a widget it already raised', async () => {
    const widget = await toolNamed('chat_widget')
    await call(widget, { action: 'raise', question: 'q', options: ['a'] })
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
      question: 'theirs',
      options: ['x'],
    })
    const widgetId = defined((await listOpenWidgets(db, elsewhere)).at(0)).id

    const mine = await toolNamed('chat_widget')
    await expect(call(mine, { action: 'dismiss', widgetId })).rejects.toThrow(
      'no such widget',
    )
  })
})
