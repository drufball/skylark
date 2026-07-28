import { uuidv7 } from '@earendil-works/pi-agent-core'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { chats } from '@hull/chat/schema'
import {
  addWidget,
  answerWidget,
  createCanvasPage,
  createChat,
  dismissWidget,
  placeWidget,
  removeMember,
} from '@hull/chat/service'
import { chatTopic } from '@hull/chat/topic'
import type { Database } from '@hull/db/client'
import { asActor, defined, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import {
  createHomePage,
  listHomePages,
  listHomeTiles,
  markHomeSeeded,
  moveHomeTile,
  pinHomeTile,
  readHomeCanvas,
  removeHomePage,
  renameHomePage,
  unpinHomeTile,
  wasHomeSeeded,
} from './service'

// The home canvas: pages of POINTERS at widgets that live in chats. Two things
// are being pinned down here and they matter in different ways.
//
// The arrangement half is ordinary CRUD, and it's tested as the chat canvas's
// is: a page is a row, a tile has a clamped box, an occupied cell yields.
//
// The ACCESS half is the point of the slice. A pointer is not a grant: whether
// a tile renders is decided at READ time from the viewer's current chat
// membership, by asking chat under the viewer's own RLS context. So the tests
// that matter run through `asActor` and take membership AWAY.

describe('the home canvas', () => {
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
    await createChat(db, {
      id: chatId,
      title: 'Deploys',
      memberIds: [dru, tilde],
    })
  })
  afterEach(() => close())

  /** A page on @dru's home canvas. */
  async function page(title = 'Home'): Promise<string> {
    const row = await createHomePage(db, { id: uuidv7(), ownerId: dru, title })
    return row.id
  }

  /** A choice raised by @tilde in the shared chat, on the stack. */
  async function raise(question = 'Ship it?'): Promise<string> {
    const id = uuidv7()
    await addWidget(db, {
      id,
      chatId,
      kind: 'choice',
      props: { question, options: ['Yes', 'No'] },
      createdById: tilde,
    })
    return id
  }

  // --- Pages ---------------------------------------------------------------

  it('creates a named page and lists it, in strip order', async () => {
    const first = await page('Morning')
    const second = await page('Ops')
    expect(await listHomePages(db, dru)).toMatchObject([
      { id: first, title: 'Morning', pageOrder: 0 },
      { id: second, title: 'Ops', pageOrder: 1 },
    ])
  })

  it('keeps one crew member’s pages out of another’s', async () => {
    await page('Mine')
    await createHomePage(db, { id: uuidv7(), ownerId: sam, title: 'Theirs' })
    expect((await listHomePages(db, dru)).map((p) => p.title)).toEqual(['Mine'])
    expect((await listHomePages(db, sam)).map((p) => p.title)).toEqual([
      'Theirs',
    ])
  })

  it('refuses a blank page name', async () => {
    await expect(
      createHomePage(db, { id: uuidv7(), ownerId: dru, title: '  ' }),
    ).rejects.toThrow(/needs a name/)
  })

  it('renames a page', async () => {
    const id = await page('Ops')
    await renameHomePage(db, { pageId: id, title: 'Deploys' })
    expect(await listHomePages(db, dru)).toMatchObject([{ title: 'Deploys' }])
  })

  it('removes an EMPTY page and refuses one that still holds tiles', async () => {
    // Same rule as the chat canvas: tidying your tabs must never be the thing
    // that destroys an arrangement you made.
    const id = await page('Ops')
    await pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId: id, chatId })
    await expect(removeHomePage(db, { pageId: id })).rejects.toThrow(
      /still has tiles/,
    )
    const empty = await page('Spare')
    await removeHomePage(db, { pageId: empty })
    expect((await listHomePages(db, dru)).map((p) => p.id)).toEqual([id])
  })

  // --- Tiles: arrangement --------------------------------------------------

  it('pins a chat pointer and a widget pointer, each into a free cell', async () => {
    const pageId = await page()
    const widgetId = await raise()
    await pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId, chatId })
    await pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId, widgetId })
    expect(await listHomeTiles(db, dru)).toMatchObject([
      { chatId, widgetId: null, gridX: 0, gridY: 0, gridW: 2, gridH: 2 },
      { chatId: null, widgetId, gridX: 2, gridY: 0 },
    ])
  })

  it('refuses a tile that points at both, or at neither', async () => {
    // The check constraint is the backstop; the door says it in words.
    const pageId = await page()
    const widgetId = await raise()
    await expect(
      pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId, chatId, widgetId }),
    ).rejects.toThrow(/exactly one/)
    await expect(
      pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId }),
    ).rejects.toThrow(/exactly one/)
  })

  it('clamps a moved tile into the grid, and yields rather than overlapping', async () => {
    const pageId = await page()
    const a = uuidv7()
    const b = uuidv7()
    await pinHomeTile(db, { id: a, ownerId: dru, pageId, chatId })
    await pinHomeTile(db, {
      id: b,
      ownerId: dru,
      pageId,
      widgetId: await raise(),
    })
    // Overshoot the grid: clamped, not refused (an agent-free surface, but the
    // same reasoning — a drag that lands off the edge shouldn't be a dead end).
    await moveHomeTile(db, {
      tileId: b,
      pageId,
      gridX: 99,
      gridY: 1,
      gridW: 99,
      gridH: 1,
    })
    const tile = async (id: string) =>
      defined((await listHomeTiles(db, dru)).find((t) => t.id === id))
    expect(await tile(b)).toMatchObject({
      gridX: 3,
      gridY: 1,
      gridW: 1,
      gridH: 1,
    })

    // Now drag it onto the tile already at 0,0 — the tile being MOVED yields.
    await moveHomeTile(db, { tileId: b, pageId, gridX: 0, gridY: 0 })
    const moved = await tile(b)
    expect(moved.gridX === 0 && moved.gridY === 0).toBe(false)
    expect(await tile(a)).toMatchObject({ gridX: 0, gridY: 0 })
  })

  it('unpins a tile, leaving the widget it pointed at untouched', async () => {
    // The point of the pointer model: removing a placement is not removing an
    // app. The widget goes on living in its chat.
    const pageId = await page()
    const widgetId = await raise()
    const tileId = uuidv7()
    await pinHomeTile(db, { id: tileId, ownerId: dru, pageId, widgetId })
    await unpinHomeTile(db, { tileId })
    expect(await listHomeTiles(db, dru)).toEqual([])
    const home = await readHomeCanvas(db, dru)
    expect(home.tiles).toEqual([])
    // …and the widget is still in the chat's stack, answerable as ever.
    await answerWidget(db, { widgetId, actorId: dru, value: 'Yes' })
  })

  it('takes a tile with the chat it points at — a pointer can never dangle', async () => {
    const pageId = await page()
    await pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId, chatId })
    await pinHomeTile(db, {
      id: uuidv7(),
      ownerId: dru,
      pageId,
      widgetId: await raise(),
    })
    await db.delete(chats).where(eq(chats.id, chatId))
    expect(await listHomeTiles(db, dru)).toEqual([])
  })

  // --- Reading: what a tile actually shows ---------------------------------

  it('resolves a chat pointer to the top of that chat’s stack', async () => {
    const pageId = await page()
    await raise('First?')
    await raise('Second?')
    await pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId, chatId })

    const home = await asActor(db, dru, (tx) => readHomeCanvas(tx, dru))
    expect(home.tiles).toHaveLength(1)
    const target = home.tiles[0].target
    expect(target.mode).toBe('chat')
    if (target.mode !== 'chat') throw new Error('expected a chat pointer')
    expect(target.chat).toMatchObject({ id: chatId, title: 'Deploys' })
    expect(defined(target.widget).props).toMatchObject({ question: 'First?' })
    expect(defined(target.widget).createdByHandle).toBe('tilde')
  })

  it('gives a chat pointer with nothing raised an honest resting state, not an error', async () => {
    const pageId = await page()
    await pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId, chatId })
    const home = await asActor(db, dru, (tx) => readHomeCanvas(tx, dru))
    const target = home.tiles[0].target
    if (target.mode !== 'chat') throw new Error('expected a chat pointer')
    // The chat is still there and still named. There is just nothing to answer.
    expect(target.chat.memberHandles.sort()).toEqual(['dru', 'tilde'])
    expect(target.widget).toBeNull()
  })

  it('follows the stack: a chat pointer shows whatever is on top NOW', async () => {
    const pageId = await page()
    const first = await raise('First?')
    await pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId, chatId })
    await dismissWidget(db, { widgetId: first, actorId: dru })
    await raise('Next?')
    const home = await asActor(db, dru, (tx) => readHomeCanvas(tx, dru))
    const target = home.tiles[0].target
    if (target.mode !== 'chat') throw new Error('expected a chat pointer')
    expect(defined(target.widget).props).toMatchObject({ question: 'Next?' })
  })

  it('resolves a widget pointer to that exact widget, with its recorded decision', async () => {
    const pageId = await page()
    const widgetId = await raise('Ship it?')
    // On a canvas an answered choice stays put and shows what was decided.
    const canvasPage = await createCanvasPage(db, {
      id: uuidv7(),
      chatId,
      title: 'Ops',
      actorId: dru,
    })
    await placeWidget(db, { widgetId, actorId: dru, pageId: canvasPage.id })
    await answerWidget(db, { widgetId, actorId: dru, value: 'Yes' })
    await pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId, widgetId })

    const home = await asActor(db, dru, (tx) => readHomeCanvas(tx, dru))
    const target = home.tiles[0].target
    if (target.mode !== 'widget') throw new Error('expected a widget pointer')
    expect(target.widget).toMatchObject({ id: widgetId, answerValue: 'Yes' })
    expect(target.chat.id).toBe(chatId)
  })

  it('hands back one topic per pointed-at chat, deduped — the subscription set', async () => {
    const pageId = await page()
    const other = uuidv7()
    await createChat(db, { id: other, title: 'Night watch', memberIds: [dru] })
    await pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId, chatId })
    await pinHomeTile(db, {
      id: uuidv7(),
      ownerId: dru,
      pageId,
      widgetId: await raise(),
    })
    await pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId, chatId: other })

    const home = await asActor(db, dru, (tx) => readHomeCanvas(tx, dru))
    // Three tiles, two chats: one topic each, and the SAME chat twice is one.
    expect(home.topics.sort()).toEqual(
      [chatTopic(chatId), chatTopic(other)].sort(),
    )
  })

  // --- Access: a pointer is not a grant ------------------------------------

  it('stops rendering a pinned widget the moment membership is lost', async () => {
    // THE test of the slice. Pin while you're a member, get removed, read again.
    const pageId = await page()
    const widgetId = await raise('Ship it?')
    await pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId, widgetId })

    const before = await asActor(db, dru, (tx) => readHomeCanvas(tx, dru))
    expect(before.tiles[0].target.mode).toBe('widget')

    await removeMember(db, chatId, dru)

    const after = await asActor(db, dru, (tx) => readHomeCanvas(tx, dru))
    // The tile is still THEIRS — it's their home, and a silent disappearance is
    // worse UX than an honest placeholder. But it carries no content, and
    // nothing that would name the chat.
    expect(after.tiles).toHaveLength(1)
    expect(after.tiles[0].target).toEqual({ mode: 'lost' })
    expect(JSON.stringify(after)).not.toContain('Ship it?')
    expect(JSON.stringify(after)).not.toContain('Deploys')
    // …and it contributes no topic, so the live path can't be a side channel.
    expect(after.topics).toEqual([])
  })

  it('stops rendering a pinned CHAT the moment membership is lost', async () => {
    const pageId = await page()
    await raise('Ship it?')
    await pinHomeTile(db, { id: uuidv7(), ownerId: dru, pageId, chatId })
    await removeMember(db, chatId, dru)
    const after = await asActor(db, dru, (tx) => readHomeCanvas(tx, dru))
    expect(after.tiles[0].target).toEqual({ mode: 'lost' })
    expect(after.topics).toEqual([])
  })

  it('refuses to pin something you cannot see in the first place', async () => {
    // @sam is in neither the chat nor the widget's chat.
    const samPage = await asActor(db, sam, (tx) =>
      createHomePage(tx, { id: uuidv7(), ownerId: sam, title: 'Home' }),
    )
    const widgetId = await raise()
    await expect(
      asActor(db, sam, (tx) =>
        pinHomeTile(tx, {
          id: uuidv7(),
          ownerId: sam,
          pageId: samPage.id,
          chatId,
        }),
      ),
    ).rejects.toThrow(/not a member/)
    await expect(
      asActor(db, sam, (tx) =>
        pinHomeTile(tx, {
          id: uuidv7(),
          ownerId: sam,
          pageId: samPage.id,
          widgetId,
        }),
      ),
    ).rejects.toThrow(/no such widget/)
  })

  /**
   * The marker that lets a deliberate clear-out stick. "No pages and no tiles"
   * cannot tell an untouched home from one somebody emptied on purpose, so the
   * seed used to resurrect the whole default arrangement on the next boot. This
   * row is the difference the emptiness couldn't carry.
   */
  describe('the seeded marker', () => {
    it('says nothing has arranged this home yet', async () => {
      expect(await asActor(db, dru, (tx) => wasHomeSeeded(tx, dru))).toBe(false)
    })

    it('remembers, once marked', async () => {
      await asActor(db, dru, (tx) => markHomeSeeded(tx, dru))
      expect(await asActor(db, dru, (tx) => wasHomeSeeded(tx, dru))).toBe(true)
    })

    it('is idempotent — marking twice is not an error', async () => {
      // It runs on every boot, so a second mark must be a no-op rather than a
      // primary-key violation that costs the crew after it in the list.
      await asActor(db, dru, (tx) => markHomeSeeded(tx, dru))
      await asActor(db, dru, (tx) => markHomeSeeded(tx, dru))
      expect(await asActor(db, dru, (tx) => wasHomeSeeded(tx, dru))).toBe(true)
    })

    it('is personal — one person’s marker is not another’s', async () => {
      await asActor(db, dru, (tx) => markHomeSeeded(tx, dru))
      expect(await asActor(db, sam, (tx) => wasHomeSeeded(tx, sam))).toBe(false)
    })

    it('is invisible to anybody but its owner', async () => {
      // Same one-line policy as the pages and the tiles: `owner_id` is you.
      // @sam asking about @dru's marker gets the same answer as asking about a
      // marker that isn't there — which is the honest one.
      await asActor(db, dru, (tx) => markHomeSeeded(tx, dru))
      expect(await asActor(db, sam, (tx) => wasHomeSeeded(tx, dru))).toBe(false)
    })
  })
})
