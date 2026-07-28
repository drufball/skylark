import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { listEventsSince } from '@hull/events/service'
import { defined, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import { eq } from 'drizzle-orm'

import {
  createCanvasPage,
  getCanvasPage,
  getViewPage,
  listCanvasPages,
  listCanvasWidgets,
  listChatViewers,
  placeWidget,
  removeCanvasPage,
  renameCanvasPage,
  reorderCanvasPage,
  setViewPage,
  stackWidget,
} from './canvas'
import { createChat, listMessages } from './messages'
import { chats } from './schema'
import { CHAT_CANVAS_CHANGED, chatTopic } from './topic'
import {
  answerMessageBody,
  CANVAS_COLUMNS,
  CANVAS_PLACEMENT,
  STACK_PLACEMENT,
} from './widgets'
import {
  addWidget,
  answerWidget,
  dismissWidget,
  getWidget,
  listOpenWidgets,
} from './widgets-store'

describe('the canvas: pages, placement, and who is looking at what', () => {
  let db: Database
  let close: () => Promise<void>
  let dru: string
  let sam: string
  let tilde: string
  let chatId: string

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    dru = uuidv7()
    sam = uuidv7()
    tilde = uuidv7()
    await createUser(db, {
      id: dru,
      handle: 'dru',
      displayName: 'Dru',
      type: 'human',
    })
    await createUser(db, {
      id: sam,
      handle: 'sam',
      displayName: 'Sam',
      type: 'human',
    })
    await createUser(db, {
      id: tilde,
      handle: 'tilde',
      displayName: 'Tilde',
      type: 'agent',
    })
    chatId = uuidv7()
    await createChat(db, { id: chatId, memberIds: [dru, sam, tilde] })
  })
  afterEach(() => close())

  /** A page on this chat's canvas, created by @dru. */
  async function page(title: string): Promise<string> {
    const row = await createCanvasPage(db, {
      id: uuidv7(),
      chatId,
      title,
      actorId: dru,
    })
    return row.id
  }

  /** A note widget in the stack — the thing that then gets moved to a page. */
  async function raise(text = 'a readout'): Promise<string> {
    const id = uuidv7()
    await addWidget(db, {
      id,
      chatId,
      kind: 'note',
      props: { text },
      createdById: tilde,
    })
    return id
  }

  it('creates a named page and lists it', async () => {
    const id = await page('Ops')
    expect(await listCanvasPages(db, chatId)).toMatchObject([
      { id, title: 'Ops', pageOrder: 0 },
    ])
  })

  it('keeps an EMPTY page — that is the reason pages are rows, not occupancy', async () => {
    await page('Nothing here yet')
    const pages = await listCanvasPages(db, chatId)
    expect(pages).toHaveLength(1)
    expect(await listCanvasWidgets(db, chatId)).toEqual([])
  })

  it('appends each new page to the end of the strip', async () => {
    await page('One')
    await page('Two')
    await page('Three')
    expect((await listCanvasPages(db, chatId)).map((p) => p.title)).toEqual([
      'One',
      'Two',
      'Three',
    ])
  })

  it('renames a page', async () => {
    const id = await page('Untitled')
    await renameCanvasPage(db, { pageId: id, title: 'Standup', actorId: dru })
    expect(defined(await getCanvasPage(db, id)).title).toBe('Standup')
  })

  it('refuses to rename a page to nothing', async () => {
    const id = await page('Ops')
    await expect(
      renameCanvasPage(db, { pageId: id, title: '  ', actorId: dru }),
    ).rejects.toThrow(/needs a name/)
  })

  it('reorders the page strip', async () => {
    const first = await page('One')
    const second = await page('Two')
    await reorderCanvasPage(db, { pageId: second, pageOrder: -1, actorId: dru })
    expect((await listCanvasPages(db, chatId)).map((p) => p.id)).toEqual([
      second,
      first,
    ])
  })

  it('removes an empty page', async () => {
    const id = await page('Spare')
    await removeCanvasPage(db, { pageId: id, actorId: dru })
    expect(await listCanvasPages(db, chatId)).toEqual([])
  })

  it('refuses to remove a page that still holds widgets', async () => {
    // Deleting a page must never quietly destroy somebody's arranged widget:
    // move them off first, and the refusal says so.
    const id = await page('Ops')
    await placeWidget(db, {
      widgetId: await raise(),
      actorId: dru,
      pageId: id,
    })
    await expect(
      removeCanvasPage(db, { pageId: id, actorId: dru }),
    ).rejects.toThrow(/still has widgets/)
    expect(await listCanvasPages(db, chatId)).toHaveLength(1)
  })

  it('takes its pages with it when the chat is deleted', async () => {
    await page('Ops')
    await db.delete(chats).where(eq(chats.id, chatId))
    expect(await listCanvasPages(db, chatId)).toEqual([])
  })

  it('moves a stack widget onto a page — an ordinary update, out of the stack', async () => {
    const pageId = await page('Ops')
    const widgetId = await raise()
    expect(await listOpenWidgets(db, chatId)).toHaveLength(1)

    await placeWidget(db, { widgetId, actorId: dru, pageId })

    expect(await listOpenWidgets(db, chatId)).toEqual([])
    expect(await listCanvasWidgets(db, chatId)).toMatchObject([
      { id: widgetId, placement: CANVAS_PLACEMENT, pageId },
    ])
  })

  it('keeps an answered CANVAS widget in place, showing the decision it recorded', async () => {
    // The stack is turn-shaped, so answering clears a tile off it. A canvas
    // page is a layout somebody MADE, and a tile that vanished when you
    // answered it left a hole in their arrangement — so on this surface an
    // answered question stays put and becomes the decision it recorded.
    const pageId = await page('Ops')
    const widgetId = uuidv7()
    await addWidget(db, {
      id: widgetId,
      chatId,
      kind: 'choice',
      props: { question: 'Ship it?', options: ['Yes', 'No'] },
      createdById: tilde,
    })
    await placeWidget(db, { widgetId, actorId: dru, pageId })

    const message = await answerWidget(db, {
      widgetId,
      actorId: dru,
      value: 'Yes',
    })

    // The answer is still an ORDINARY chat message — the same door, unchanged.
    expect(message.body).toBe(answerMessageBody('Ship it?', 'Yes'))
    // …but the tile is still on the page, carrying what was decided.
    expect(await listCanvasWidgets(db, chatId)).toMatchObject([
      { id: widgetId, pageId, answerValue: 'Yes' },
    ])
    expect(defined(await getWidget(db, widgetId)).dismissedAt).toBeNull()
    expect(defined(await getWidget(db, widgetId)).answeredAt).toBeInstanceOf(
      Date,
    )
  })

  it('refuses a second answer on the canvas, and posts no second message', async () => {
    // The tile is still on screen after the first answer, which is exactly why
    // the guard can't be "is it dismissed?" any more.
    const pageId = await page('Ops')
    const widgetId = uuidv7()
    await addWidget(db, {
      id: widgetId,
      chatId,
      kind: 'choice',
      props: { question: 'Ship it?', options: ['Yes', 'No'] },
      createdById: tilde,
    })
    await placeWidget(db, { widgetId, actorId: dru, pageId })
    await answerWidget(db, { widgetId, actorId: dru, value: 'Yes' })

    await expect(
      answerWidget(db, { widgetId, actorId: dru, value: 'No' }),
    ).rejects.toThrow(/already been answered/)
    expect(await listMessages(db, chatId)).toHaveLength(1)
    // And the first decision stands — a refused second tap cannot rewrite it.
    expect(defined(await getWidget(db, widgetId)).answerValue).toBe('Yes')
  })

  it('slots an unplaced widget into the first free cell, never on top of another', async () => {
    const pageId = await page('Ops')
    const a = await raise('a')
    const b = await raise('b')
    await placeWidget(db, { widgetId: a, actorId: dru, pageId })
    await placeWidget(db, { widgetId: b, actorId: dru, pageId })
    expect(await listCanvasWidgets(db, chatId)).toMatchObject([
      { id: a, gridX: 0, gridY: 0, gridW: 2, gridH: 2 },
      { id: b, gridX: 2, gridY: 0, gridW: 2, gridH: 2 },
    ])
  })

  it('clamps a box an agent wrote out of range rather than refusing it', async () => {
    const pageId = await page('Ops')
    const widgetId = await raise()
    await placeWidget(db, {
      widgetId,
      actorId: tilde,
      pageId,
      gridX: 9,
      gridY: 1,
      gridW: 40,
      gridH: 0,
    })
    expect(await listCanvasWidgets(db, chatId)).toMatchObject([
      { id: widgetId, gridX: CANVAS_COLUMNS - 1, gridY: 1, gridW: 1, gridH: 1 },
    ])
  })

  it('never lands a tile on top of one already there', async () => {
    // Dragging one tile onto another used to store an overlapping box, and CSS
    // grid drew them stacked — a rendering bug, not a layout. The tile being
    // MOVED yields to the first free slot instead.
    const pageId = await page('Ops')
    const sitting = await raise('sitting')
    const moving = await raise('moving')
    await placeWidget(db, {
      widgetId: sitting,
      actorId: dru,
      pageId,
      gridX: 0,
      gridY: 0,
      gridW: 2,
      gridH: 2,
    })
    await placeWidget(db, {
      widgetId: moving,
      actorId: dru,
      pageId,
      gridX: 1,
      gridY: 1,
      gridW: 2,
      gridH: 2,
    })
    expect(await listCanvasWidgets(db, chatId)).toMatchObject([
      { id: sitting, gridX: 0, gridY: 0 },
      { id: moving, gridX: 2, gridY: 0 },
    ])
  })

  it('lets a tile resize in place, not colliding with itself', async () => {
    const pageId = await page('Ops')
    const widgetId = await raise()
    await placeWidget(db, {
      widgetId,
      actorId: dru,
      pageId,
      gridX: 0,
      gridY: 0,
      gridW: 2,
      gridH: 2,
    })
    await placeWidget(db, {
      widgetId,
      actorId: dru,
      pageId,
      gridX: 0,
      gridY: 0,
      gridW: 3,
      gridH: 3,
    })
    expect(await listCanvasWidgets(db, chatId)).toMatchObject([
      { id: widgetId, gridX: 0, gridY: 0, gridW: 3, gridH: 3 },
    ])
  })

  it('lists a page in arrangement order — top row first, then left to right', async () => {
    // This IS the single-column order a phone renders, so the two surfaces
    // cannot disagree about what comes first.
    const pageId = await page('Ops')
    const bottom = await raise('bottom')
    const topRight = await raise('top right')
    const topLeft = await raise('top left')
    await placeWidget(db, {
      widgetId: bottom,
      actorId: dru,
      pageId,
      gridX: 0,
      gridY: 2,
      gridW: 2,
      gridH: 2,
    })
    await placeWidget(db, {
      widgetId: topRight,
      actorId: dru,
      pageId,
      gridX: 2,
      gridY: 0,
      gridW: 2,
      gridH: 2,
    })
    await placeWidget(db, {
      widgetId: topLeft,
      actorId: dru,
      pageId,
      gridX: 0,
      gridY: 0,
      gridW: 2,
      gridH: 2,
    })
    expect((await listCanvasWidgets(db, chatId)).map((w) => w.id)).toEqual([
      topLeft,
      topRight,
      bottom,
    ])
  })

  it('moves a canvas widget back to the stack, off its page', async () => {
    const pageId = await page('Ops')
    const widgetId = await raise()
    await placeWidget(db, { widgetId, actorId: dru, pageId })
    await stackWidget(db, { widgetId, actorId: dru })
    expect(await listCanvasWidgets(db, chatId)).toEqual([])
    expect(await listOpenWidgets(db, chatId)).toMatchObject([
      { id: widgetId, placement: STACK_PLACEMENT, pageId: null },
    ])
  })

  it('refuses to place a widget on a page belonging to another chat', async () => {
    const other = uuidv7()
    await createChat(db, { id: other, memberIds: [dru] })
    const foreign = defined(
      await createCanvasPage(db, {
        id: uuidv7(),
        chatId: other,
        title: 'Theirs',
        actorId: dru,
      }),
    )
    await expect(
      placeWidget(db, {
        widgetId: await raise(),
        actorId: dru,
        pageId: foreign.id,
      }),
    ).rejects.toThrow(/page is not in this widget’s chat/)
  })

  it('keeps a dismissed canvas widget out of the page', async () => {
    const pageId = await page('Ops')
    const widgetId = await raise()
    await placeWidget(db, { widgetId, actorId: dru, pageId })
    await dismissWidget(db, { widgetId, actorId: dru })
    expect(await listCanvasWidgets(db, chatId)).toEqual([])
  })

  it('remembers which page EACH person is looking at, independently', async () => {
    const ops = await page('Ops')
    const numbers = await page('Numbers')
    await setViewPage(db, { chatId, userId: dru, pageId: ops })
    await setViewPage(db, { chatId, userId: sam, pageId: numbers })
    expect(await getViewPage(db, chatId, dru)).toBe(ops)
    expect(await getViewPage(db, chatId, sam)).toBe(numbers)
  })

  it('moves one person’s view without touching anyone else’s', async () => {
    const ops = await page('Ops')
    const numbers = await page('Numbers')
    await setViewPage(db, { chatId, userId: dru, pageId: ops })
    await setViewPage(db, { chatId, userId: sam, pageId: ops })
    await setViewPage(db, { chatId, userId: dru, pageId: numbers })
    expect(await getViewPage(db, chatId, dru)).toBe(numbers)
    expect(await getViewPage(db, chatId, sam)).toBe(ops)
  })

  it('has nobody looking anywhere until they open a page', async () => {
    await page('Ops')
    expect(await getViewPage(db, chatId, dru)).toBeNull()
  })

  it('forgets a view of a page that was removed, keeping the person in the chat', async () => {
    const spare = await page('Spare')
    await setViewPage(db, { chatId, userId: dru, pageId: spare })
    await removeCanvasPage(db, { pageId: spare, actorId: dru })
    expect(await getViewPage(db, chatId, dru)).toBeNull()
  })

  it('tells the orchestrator what each human has open, by page NAME', async () => {
    // What the agent is briefed with: a person and the page in front of them.
    const ops = await page('Ops')
    await setViewPage(db, { chatId, userId: dru, pageId: ops })
    expect(await listChatViewers(db, chatId)).toEqual([
      { handle: 'dru', pageTitle: 'Ops' },
      { handle: 'sam', pageTitle: null },
    ])
  })

  it('announces page changes and placements on the chat’s own topic', async () => {
    const pageId = await page('Ops')
    await renameCanvasPage(db, { pageId, title: 'Ops room', actorId: dru })
    const widgetId = await raise()
    await placeWidget(db, { widgetId, actorId: dru, pageId })

    const events = await listEventsSince(db, {
      topicPatterns: [chatTopic(chatId)],
      audience: 'members',
    })
    // The literals, not the constants: the browser dispatches on these strings.
    expect(CHAT_CANVAS_CHANGED).toBe('chat.canvas_changed')
    expect(events.filter((e) => e.type === 'chat.canvas_changed')).toHaveLength(
      2,
    )
    expect(
      events
        .filter((e) => e.type === 'chat.widget_changed')
        .map((e) => (e.payload as { change: string }).change),
    ).toEqual(['raised', 'placed'])
  })

  it('announces NOTHING when somebody changes which page they are looking at', async () => {
    // Your attention is not news for the crew — and an event would make it so.
    const ops = await page('Ops')
    const before = (
      await listEventsSince(db, {
        topicPatterns: [chatTopic(chatId)],
        audience: 'members',
      })
    ).length
    await setViewPage(db, { chatId, userId: dru, pageId: ops })
    const after = await listEventsSince(db, {
      topicPatterns: [chatTopic(chatId)],
      audience: 'members',
    })
    expect(after).toHaveLength(before)
  })
})
