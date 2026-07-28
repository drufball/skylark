import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { listEventsSince } from '@hull/events/service'
import { defined, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import { eq } from 'drizzle-orm'

import { createChat, listMessages } from './messages'
import { chats } from './schema'
import { CHAT_WIDGET_CHANGED, chatTopic } from './topic'
import { answerMessageBody, STACK_PLACEMENT, type JsonValue } from './widgets'
import {
  addWidget,
  answerWidget,
  dismissWidget,
  getWidget,
  listOpenWidgets,
  listWidgets,
  reorderWidget,
} from './widgets-store'

describe('widget persistence + answering', () => {
  let db: Database
  let close: () => Promise<void>
  let dru: string
  let tilde: string
  let chatId: string

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    dru = uuidv7()
    tilde = uuidv7()
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
    chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, tilde] })
  })
  afterEach(() => close())

  /** A choice widget raised by @tilde — the shape an agent puts up. */
  async function raise(
    props: JsonValue = { question: 'Ship it?', options: ['Yes', 'No'] },
    over: { kind?: string; stackOrder?: number } = {},
  ): Promise<string> {
    const id = uuidv7()
    await addWidget(db, {
      id,
      chatId,
      kind: over.kind ?? 'choice',
      props,
      stackOrder: over.stackOrder,
      createdById: tilde,
    })
    return id
  }

  it('lists an open widget with who raised it, defaulting to the stack', async () => {
    const id = await raise()
    const rows = await listOpenWidgets(db, chatId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      kind: 'choice',
      placement: STACK_PLACEMENT,
      stackOrder: 0,
      createdByHandle: 'tilde',
      dismissedAt: null,
    })
    expect(rows[0].props).toEqual({
      question: 'Ship it?',
      options: ['Yes', 'No'],
    })
  })

  it('orders the stack by stackOrder, low first', async () => {
    const second = await raise(
      { question: 'Second?', options: ['Ok'] },
      { stackOrder: 5 },
    )
    const first = await raise(
      { question: 'First?', options: ['Ok'] },
      { stackOrder: 1 },
    )
    expect((await listOpenWidgets(db, chatId)).map((w) => w.id)).toEqual([
      first,
      second,
    ])
  })

  it('reorders a widget so it takes the top of the stack', async () => {
    const a = await raise(
      { question: 'A?', options: ['Ok'] },
      { stackOrder: 1 },
    )
    const b = await raise(
      { question: 'B?', options: ['Ok'] },
      { stackOrder: 2 },
    )
    await reorderWidget(db, { widgetId: b, actorId: dru, stackOrder: 0 })
    expect((await listOpenWidgets(db, chatId)).map((w) => w.id)).toEqual([b, a])
  })

  it('answers by posting an ordinary chat message and dismissing the widget', async () => {
    const id = await raise()
    const message = await answerWidget(db, {
      widgetId: id,
      actorId: dru,
      value: 'Yes',
    })

    // An ORDINARY message: same table, same author, same recency bump — so the
    // unseen-message diffing, reply targeting, RLS and SSE all just work.
    const messages = await listMessages(db, chatId)
    expect(messages.map((m) => m.id)).toEqual([message.id])
    expect(messages[0].authorHandle).toBe('dru')
    expect(messages[0].body).toBe(answerMessageBody('Ship it?', 'Yes'))

    // …and it announces itself on the ship's log like any other post.
    const events = await listEventsSince(db, {
      topicPatterns: [chatTopic(chatId)],
      audience: 'members',
    })
    expect(events.map((e) => e.type)).toContain('chat.message_posted')

    // Out of the stack, but the row survives as history.
    expect(await listOpenWidgets(db, chatId)).toEqual([])
    expect(defined(await getWidget(db, id)).dismissedAt).toBeInstanceOf(Date)
  })

  it('answers as the ANSWERING actor, not whoever raised the widget', async () => {
    // @tilde raised it; @dru answered → the message is @dru's, so the reply
    // rules see a human's message and the agent's turn is triggered normally.
    const id = await raise()
    const message = await answerWidget(db, {
      widgetId: id,
      actorId: dru,
      value: 'No',
    })
    expect(message.authorId).toBe(dru)
  })

  it('refuses a second answer, and posts no second message', async () => {
    // The double-submit case: a double tap, or two tabs open on the same chat.
    const id = await raise()
    await answerWidget(db, { widgetId: id, actorId: dru, value: 'Yes' })
    await expect(
      answerWidget(db, { widgetId: id, actorId: dru, value: 'No' }),
    ).rejects.toThrow(/already been answered/)
    expect(await listMessages(db, chatId)).toHaveLength(1)
  })

  it('refuses to answer a widget that was dismissed unanswered', async () => {
    const id = await raise()
    await dismissWidget(db, { widgetId: id, actorId: dru })
    await expect(
      answerWidget(db, { widgetId: id, actorId: dru, value: 'Yes' }),
    ).rejects.toThrow(/already been answered/)
    expect(await listMessages(db, chatId)).toEqual([])
  })

  it('refuses a value the widget never offered, leaving it open', async () => {
    const id = await raise()
    await expect(
      answerWidget(db, { widgetId: id, actorId: dru, value: 'Maybe' }),
    ).rejects.toThrow(/not one of this widget’s options/)
    expect(await listMessages(db, chatId)).toEqual([])
    // Still answerable: a bad submit must not consume the widget.
    expect(await listOpenWidgets(db, chatId)).toHaveLength(1)
  })

  it('refuses to answer a widget whose props offer nothing', async () => {
    // An agent wrote nonsense props. The tile says so; answering can't invent
    // an option list out of a blob nobody can read.
    const id = await raise({ question: 'Ship it?' })
    await expect(
      answerWidget(db, { widgetId: id, actorId: dru, value: 'Yes' }),
    ).rejects.toThrow(/offers nothing to answer/)
    expect(await listMessages(db, chatId)).toEqual([])
  })

  it('refuses to answer a kind that carries no answers at all', async () => {
    // A `note` is read, not answered — and so is a kind this ship has never
    // heard of. The hull needs no kind names to say so: no options, no answer.
    const id = await raise({ text: 'Standup at 09:30' }, { kind: 'note' })
    await expect(
      answerWidget(db, { widgetId: id, actorId: dru, value: 'Yes' }),
    ).rejects.toThrow(/offers nothing to answer/)
    const alien = await raise({ anything: true }, { kind: 'orrery' })
    await expect(
      answerWidget(db, { widgetId: alien, actorId: dru, value: 'Yes' }),
    ).rejects.toThrow(/offers nothing to answer/)
  })

  it('refuses to answer a widget whose chat was deleted — the row is gone', async () => {
    // The never-orphaned invariant: the FK cascade takes the widget with the
    // chat, so a stale button in an open tab answers into nothing, cleanly.
    const id = await raise()
    await db.delete(chats).where(eq(chats.id, chatId))
    expect(await getWidget(db, id)).toBeUndefined()
    await expect(
      answerWidget(db, { widgetId: id, actorId: dru, value: 'Yes' }),
    ).rejects.toThrow(/no such widget/)
  })

  it('lists dismissed widgets in the history, marked, while the stack excludes them', async () => {
    const open = await raise({ question: 'Open?', options: ['Ok'] })
    const gone = await raise({ question: 'Gone?', options: ['Ok'] })
    await dismissWidget(db, { widgetId: gone, actorId: dru })
    expect((await listWidgets(db, chatId)).map((w) => w.id).sort()).toEqual(
      [open, gone].sort(),
    )
    expect((await listOpenWidgets(db, chatId)).map((w) => w.id)).toEqual([open])
  })

  it('dismissing an already-dismissed widget keeps the first dismissal, silently', async () => {
    const id = await raise()
    await dismissWidget(db, { widgetId: id, actorId: dru })
    const first = defined(await getWidget(db, id)).dismissedAt
    await dismissWidget(db, { widgetId: id, actorId: dru })
    expect(defined(await getWidget(db, id)).dismissedAt).toEqual(first)

    // And exactly ONE dismissal was announced: a no-op must not send every
    // member's browser off to refetch a stack that didn't move.
    const events = await listEventsSince(db, {
      topicPatterns: [chatTopic(chatId)],
      audience: 'members',
    })
    expect(
      events.filter(
        (e) =>
          e.type === 'chat.widget_changed' &&
          (e.payload as { change: string }).change === 'dismissed',
      ),
    ).toHaveLength(1)
  })

  it.each([
    [
      'dismiss',
      (id: string) => dismissWidget(db, { widgetId: id, actorId: dru }),
    ],
    [
      'reorder',
      (id: string) =>
        reorderWidget(db, { widgetId: id, actorId: dru, stackOrder: 1 }),
    ],
  ])('refuses to %s a widget that does not exist', async (_verb, act) => {
    await expect(act(uuidv7())).rejects.toThrow(/no such widget/)
  })

  it('announces every change on the chat’s own topic — no new transport', async () => {
    // The browser is already subscribed to chat:<id> for messages, so the stack
    // refreshes off the same stream. Each verb names what it did.
    const id = await raise()
    await reorderWidget(db, { widgetId: id, actorId: dru, stackOrder: 2 })
    await answerWidget(db, { widgetId: id, actorId: dru, value: 'Yes' })
    const waved = await raise({ question: 'Later?', options: ['Ok'] })
    await dismissWidget(db, { widgetId: waved, actorId: dru })

    const events = await listEventsSince(db, {
      topicPatterns: [chatTopic(chatId)],
      audience: 'members',
    })
    // The literal, not the constant: it's a wire format the browser dispatches
    // on (routes/index.tsx), so renaming it silently would break the live stack.
    expect(CHAT_WIDGET_CHANGED).toBe('chat.widget_changed')
    expect(
      events
        .filter((e) => e.type === 'chat.widget_changed')
        .map((e) => (e.payload as { change: string }).change),
    ).toEqual(['raised', 'reordered', 'answered', 'raised', 'dismissed'])
    // Private, like every chat event: nothing on the public audience.
    const pub = await listEventsSince(db, {
      topicPatterns: ['*'],
      audience: 'public',
    })
    expect(pub.filter((e) => e.topic === chatTopic(chatId))).toHaveLength(0)
  })
})
