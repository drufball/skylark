import { uuidv7 } from '@earendil-works/pi-agent-core'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { asActor, defined, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'
import {
  getChat,
  listCanvasPages,
  listCanvasWidgets,
  listMembers,
  listWidgets,
  listWidgetsByIds,
  createCanvasPage,
  dismissWidget,
  placeWidget,
  removeMember,
  setTitle,
} from '@hull/chat/service'

import { listHomePages, listHomeTiles } from '@hull/home-canvas/service'

import type { RoomSpec } from './rooms'
import { seedHomes, seedRooms } from './seed'

// The default rooms, seeded. Everything here is about the SECOND run: a seed
// that duplicates rooms, widgets or memberships is worse than no seed at all,
// and a returning crew's arrangement is theirs — a rename, a drag, a dismissal
// and a page they added all have to survive every subsequent boot.

const ROOMS: readonly RoomSpec[] = [
  {
    id: 'room-test-issues',
    title: 'Issues',
    page: 'Board',
    agentHandle: 'tilde',
    view: { to: '/issues', label: 'Board' },
    widgets: [{ kind: 'issue-list', props: { limit: 5 }, gridW: 4, gridH: 3 }],
  },
  {
    id: 'room-test-files',
    title: 'Files',
    page: 'Documents',
    agentHandle: 'dot',
    view: { to: '/files', label: 'All files' },
    widgets: [{ kind: 'files', props: {}, gridW: 4, gridH: 3 }],
  },
]

describe('seedRooms', () => {
  let db: Database
  let close: () => Promise<void>
  let captain: string
  let mate: string
  let tilde: string

  /** Seed as the operator, under RLS — the same context the CLI door runs in. */
  const seed = (rooms: readonly RoomSpec[] = ROOMS) =>
    asActor(db, captain, (tx) => seedRooms(tx, { actorId: captain, rooms }))

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    captain = uuidv7()
    mate = uuidv7()
    tilde = uuidv7()
    await createUser(db, {
      id: captain,
      handle: 'captain',
      displayName: 'Captain',
      type: 'human',
    })
    await createUser(db, {
      id: mate,
      handle: 'mate',
      displayName: 'Mate',
      type: 'human',
    })
    await createUser(db, {
      id: tilde,
      handle: 'tilde',
      displayName: 'Tilde',
      type: 'agent',
    })
    await createUser(db, {
      id: uuidv7(),
      handle: 'dot',
      displayName: 'Dot',
      type: 'agent',
    })
    await createUser(db, {
      id: uuidv7(),
      handle: 'bix',
      displayName: 'Bix',
      type: 'agent',
    })
  })
  afterEach(() => close())

  it('makes a room per spec, arranged and ready to look at', async () => {
    const seeded = await seed()
    expect(seeded.map((r) => r.id)).toEqual(ROOMS.map((r) => r.id))
    expect(seeded.every((r) => r.created)).toBe(true)

    const chat = await getChat(db, 'room-test-issues')
    expect(chat?.title).toBe('Issues')

    // One page, and the widget already ON it — the crew shouldn't have to
    // arrange the ship's own rooms before they're useful.
    const pages = await listCanvasPages(db, 'room-test-issues')
    expect(pages.map((p) => p.title)).toEqual(['Board'])
    const [widget] = await listCanvasWidgets(db, 'room-test-issues')
    expect(widget.kind).toBe('issue-list')
    expect(widget.pageId).toBe(pages[0].id)
    expect({ gridW: widget.gridW, gridH: widget.gridH }).toEqual({
      gridW: 4,
      gridH: 3,
    })
  })

  it('puts every human aboard in the room, plus the room’s own agent', async () => {
    await seed()
    const members = await listMembers(db, 'room-test-issues')
    expect(members.map((m) => m.handle).sort()).toEqual([
      'captain',
      'mate',
      'tilde',
    ])
    // The OTHER agents stay out: a roster of every agent aboard is noise, and
    // only @mentioned agents answer in a group anyway.
    expect(members.map((m) => m.handle)).not.toContain('dot')
  })

  it('names the seeding actor on every widget it raises', async () => {
    // Only an actor with judgment puts a widget in front of a person. The seed
    // is the operator's own move, run from their CLI, so their name is on it —
    // no service ever raises one on its own behalf.
    await seed()
    const [widget] = await listWidgets(db, 'room-test-issues')
    expect(widget.createdById).toBe(captain)
  })

  it('changes nothing at all on a second run', async () => {
    await seed()
    const before = {
      chats: await Promise.all(ROOMS.map((r) => getChat(db, r.id))),
      members: await listMembers(db, 'room-test-issues'),
      pages: await listCanvasPages(db, 'room-test-issues'),
      widgets: await listWidgets(db, 'room-test-issues'),
    }

    const again = await seed()
    expect(again.every((r) => r.created)).toBe(false)

    expect(await Promise.all(ROOMS.map((r) => getChat(db, r.id)))).toEqual(
      before.chats,
    )
    expect(await listMembers(db, 'room-test-issues')).toEqual(before.members)
    expect(await listCanvasPages(db, 'room-test-issues')).toEqual(before.pages)
    expect(await listWidgets(db, 'room-test-issues')).toEqual(before.widgets)
  })

  it('leaves a room the crew renamed alone, and doesn’t make a second one', async () => {
    // A room's identity is its WELL-KNOWN ID, never its title — which is what
    // makes renaming it safe.
    await seed()
    await setTitle(db, 'room-test-issues', 'The Work')
    await seed()
    expect((await getChat(db, 'room-test-issues'))?.title).toBe('The Work')
    expect(await listWidgets(db, 'room-test-issues')).toHaveLength(1)
  })

  it('leaves a tile the crew dragged where they put it', async () => {
    await seed()
    const [page] = await listCanvasPages(db, 'room-test-issues')
    const [widget] = await listCanvasWidgets(db, 'room-test-issues')
    await placeWidget(db, {
      widgetId: widget.id,
      actorId: captain,
      pageId: page.id,
      gridX: 1,
      gridY: 2,
      gridW: 2,
      gridH: 1,
    })
    await seed()
    const [after] = await listCanvasWidgets(db, 'room-test-issues')
    expect({ x: after.gridX, y: after.gridY, w: after.gridW }).toEqual({
      x: 1,
      y: 2,
      w: 2,
    })
  })

  it('does not re-raise a widget the crew waved away', async () => {
    // Dismissing the seeded tile is a decision, not damage to repair.
    await seed()
    const [widget] = await listWidgets(db, 'room-test-issues')
    await dismissWidget(db, { widgetId: widget.id, actorId: captain })
    await seed()
    expect(await listWidgets(db, 'room-test-issues')).toHaveLength(1)
    expect(await listCanvasWidgets(db, 'room-test-issues')).toHaveLength(0)
  })

  it('leaves pages and widgets the crew added alone', async () => {
    await seed()
    await createCanvasPage(db, {
      id: uuidv7(),
      chatId: 'room-test-issues',
      title: 'Mine',
      actorId: captain,
    })
    await seed()
    expect(
      (await listCanvasPages(db, 'room-test-issues')).map((p) => p.title),
    ).toEqual(['Board', 'Mine'])
  })

  it('brings a crew member who joined later into every room', async () => {
    await seed()
    const newbie = uuidv7()
    await createUser(db, {
      id: newbie,
      handle: 'newbie',
      displayName: 'Newbie',
      type: 'human',
    })
    const again = await seed()
    expect(again[0].membersAdded).toBe(1)
    expect(
      (await listMembers(db, 'room-test-issues')).map((m) => m.handle),
    ).toContain('newbie')
  })

  it('converges a widget added to the spec later into an existing room', async () => {
    await seed()
    const grown = ROOMS.map((room) =>
      room.id === 'room-test-issues'
        ? {
            ...room,
            widgets: [
              ...room.widgets,
              { kind: 'note', props: { text: 'later' }, gridW: 2, gridH: 1 },
            ],
          }
        : room,
    )
    await seed(grown)
    expect(
      (await listCanvasWidgets(db, 'room-test-issues')).map((w) => w.kind),
    ).toEqual(['issue-list', 'note'])
  })

  it('reports a room it cannot reach and still seeds the rest', async () => {
    // The 2 a.m. case: somebody removed the operator from a default room, so
    // RLS now hides the very row the seed is trying to converge and the create
    // hits the primary key instead. One odd room must not cost the ship the
    // rooms after it in the list — every boot runs this.
    await seed()
    await asActor(db, captain, (tx) =>
      removeMember(tx, 'room-test-issues', captain),
    )
    const again = await seed()
    expect(again[0].error).toMatch(/./)
    expect(again[1].error).toBeNull()
    expect(await getChat(db, 'room-test-files')).toBeTruthy()
  })

  it('makes the room even when its agent isn’t aboard, and says so', async () => {
    // A ship whose crew was hand-edited must still get its rooms; a missing
    // agent is a note in the report, not a failed boot.
    const [seeded] = await seed([{ ...ROOMS[0], agentHandle: 'nobody' }])
    expect(seeded.created).toBe(true)
    expect(seeded.missingAgent).toBe('nobody')
    expect(
      (await listMembers(db, 'room-test-issues')).map((m) => m.handle),
    ).toEqual(['captain', 'mate'])
  })

  /**
   * A blank grid is the worst possible first screen now that home IS the front
   * door — it reads as a ship that failed to load rather than one waiting for
   * you. So the seed arranges the rooms it just made onto every crew member's
   * home, under that person's own RLS context (a home is personal; nobody,
   * including the operator, may write somebody else's).
   *
   * The non-clobbering rule is one predicate: a home with **no pages and no
   * tiles** is one nobody has touched. The instant you make a page, pin
   * anything, or unpin one of these, the seed never comes near your home again.
   */
  describe('seedHomes', () => {
    const seedTheHomes = async () => {
      const crew = [
        { id: captain, handle: 'captain', type: 'human' },
        { id: mate, handle: 'mate', type: 'human' },
        { id: tilde, handle: 'tilde', type: 'agent' },
      ]
      return seedHomes({
        crew,
        rooms: ROOMS,
        asActor: (userId, fn) => asActor(db, userId, fn),
      })
    }

    it('arranges every crew member’s home with the rooms they’re in', async () => {
      await seed()
      const report = await seedTheHomes()
      expect(report.map((r) => r.tilesAdded)).toEqual([2, 2])

      // Pointers at the rooms' READOUTS, so the very first load shows the
      // ship working rather than three tiles saying "nothing raised right now"
      // (a room's tile lives on its canvas, never on its stack).
      const tiles = await listHomeTiles(db, mate)
      const pinned = await listWidgetsByIds(
        db,
        tiles.flatMap((t) => (t.widgetId ? [t.widgetId] : [])),
      )
      expect(pinned.map((w) => w.kind).sort()).toEqual(['files', 'issue-list'])
      // Pointers, never copies: the widgets still live in their own chats.
      expect(pinned.map((w) => w.chatId).sort()).toEqual([
        'room-test-files',
        'room-test-issues',
      ])
      // One page, made for them, not three.
      expect((await listHomePages(db, mate)).map((p) => p.title)).toEqual([
        'Home',
      ])
    })

    it('falls back to a live chat pointer for a room with no readout left', async () => {
      // Somebody waved the room's tile away (the room seed won't re-raise it,
      // by design). A pointer at the ROOM is worse than one at its readout, and
      // far better than a home missing a room the crew is in.
      await seed()
      const [widget] = await listWidgets(db, 'room-test-issues')
      await dismissWidget(db, { widgetId: widget.id, actorId: captain })
      await seedTheHomes()
      const [tile] = await listHomeTiles(db, captain)
      expect(tile.widgetId).toBeNull()
      expect(tile.chatId).toBe('room-test-issues')
    })

    it('skips the agents — a home screen is for somebody with a thumb', async () => {
      await seed()
      const report = await seedTheHomes()
      expect(report.map((r) => r.handle)).toEqual(['captain', 'mate'])
      expect(await listHomeTiles(db, tilde)).toEqual([])
    })

    it('adds nothing at all on a second run', async () => {
      await seed()
      await seedTheHomes()
      const again = await seedTheHomes()
      expect(again.every((r) => r.tilesAdded === 0)).toBe(true)
      expect(await listHomeTiles(db, captain)).toHaveLength(2)
    })

    it('never touches a home somebody has already arranged', async () => {
      // The one that matters: unpinning a seeded tile is a DECISION, and the
      // next boot must not undo it. Their page survives, so their home is no
      // longer untouched, so the seed leaves it alone forever after.
      await seed()
      await seedTheHomes()
      const [first] = await listHomeTiles(db, captain)
      await asActor(db, captain, (tx) =>
        tx.execute(sql`delete from home_canvas_tiles where id = ${first.id}`),
      )
      const again = await seedTheHomes()
      expect(again[0].tilesAdded).toBe(0)
      expect(await listHomeTiles(db, captain)).toHaveLength(1)
    })

    it('resolves each room under the viewer’s own membership', async () => {
      // A room the operator was removed from is not on the operator's home —
      // the seed asks chat, as them, rather than assuming the spec list.
      await seed()
      await asActor(db, captain, (tx) =>
        removeMember(tx, 'room-test-issues', captain),
      )
      const report = await seedTheHomes()
      expect(report[0].tilesAdded).toBe(1)
      const [tile] = await listHomeTiles(db, captain)
      const [pinned] = await listWidgetsByIds(db, [defined(tile.widgetId)])
      expect(pinned.chatId).toBe('room-test-files')
    })

    it('reports a crew member it cannot seed and still seeds the rest', async () => {
      // Every boot runs this, so one crew member's bad home must not cost the
      // ship the people after them in the list.
      await seed()
      const report = await seedHomes({
        crew: [
          { id: captain, handle: 'captain', type: 'human' },
          { id: mate, handle: 'mate', type: 'human' },
        ],
        rooms: ROOMS,
        asActor: (userId, fn) =>
          userId === captain
            ? Promise.reject(new Error('connection went away'))
            : asActor(db, userId, fn),
      })
      expect(report[0].error).toMatch(/./)
      expect(report[1].error).toBeNull()
      expect(await listHomeTiles(db, mate)).toHaveLength(2)
    })
  })
})
