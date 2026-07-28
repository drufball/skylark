import { uuidv7 } from '@earendil-works/pi-agent-core'

import type { Database } from '@hull/db/client'
import { errorMessage } from '@hull/lib/errors'
import {
  addMember,
  addWidget,
  createCanvasPage,
  createChat,
  getChat,
  listCanvasPages,
  listCanvasWidgets,
  listChatSummaries,
  listMembers,
  listWidgets,
  placeWidget,
} from '@hull/chat/service'
import {
  listHomePages,
  listHomeTiles,
  markHomeSeeded,
  pinHomeTile,
  wasHomeSeeded,
} from '@hull/home-canvas/service'
import { listUsers } from '@hull/users/service'

import { DEFAULT_ROOMS, type RoomSpec } from './rooms'

/**
 * Seed the ship's default rooms, idempotently — the `npm run users seed` of
 * conversations, run from `scripts/serve` on every boot.
 *
 * The hard requirement is the SECOND run, and every run after it. A seed that
 * duplicated a room, a widget or a membership would be worse than no seed, and
 * a returning crew's arrangement is theirs: a room they renamed, a tile they
 * dragged, a widget they waved away and a page they added all have to survive
 * every boot from here on. So the rules are:
 *
 * - A room's identity is its **well-known id**, never its title. Renaming is
 *   safe by construction; a title-keyed seed would read a rename as a missing
 *   room and open a second one beside it.
 * - An existing room's title, pages and arrangement are **never written**. The
 *   only thing that converges into an existing room is what's genuinely new:
 *   crew who came aboard since, and a widget KIND the room has never held.
 * - A widget is matched by kind across the room's whole history, dismissed rows
 *   included, so waving the seeded tile away is a decision and not damage the
 *   next boot repairs.
 *
 * **The seed raises widgets as an ACTOR, not as a service.** Every widget it
 * creates carries `createdById` = the person who ran the seed, because only an
 * actor with judgment puts a widget in front of somebody (see the chat zine).
 * Run it under that actor's RLS context — the CLI door does — so it writes
 * exactly what a human clicking through the app could have written.
 *
 * It lives in RIGGING because it composes hull services (chat + users) with a
 * catalog of widget kinds this deck owns the meaning of; the hull may not know
 * a kind by name, and doesn't have to.
 */

/** What one room's pass did — what the CLI prints and the tests assert on. */
export interface SeededRoom {
  id: string
  title: string
  /** The room didn't exist and was opened on this run. */
  created: boolean
  /** Crew brought into an existing room (0 on the run that created it). */
  membersAdded: number
  /** Widget kinds the room had never held. */
  widgetsAdded: number
  /** The room's agent handle, when nobody by that name is aboard. */
  missingAgent: string | null
  /** Why this room couldn't be seeded, if it couldn't. Never thrown. */
  error: string | null
}

/**
 * Make sure every room in `rooms` exists, is crewed and is arranged. Returns a
 * report per room; a room that fails is reported and the rest still run, so one
 * odd room can't cost the ship its others on boot.
 */
export async function seedRooms(
  db: Database,
  input: { actorId: string; rooms?: readonly RoomSpec[] },
): Promise<SeededRoom[]> {
  const rooms = input.rooms ?? DEFAULT_ROOMS
  // One crew read for every room: membership is "everyone aboard", so it's the
  // same answer each time.
  const crew = await listUsers(db)
  const report: SeededRoom[] = []
  for (const spec of rooms) {
    report.push(await seedRoom(db, spec, input.actorId, crew))
  }
  return report
}

/** The crew, as this module needs them: who's human, and who answers to a handle. */
export type Crew = { id: string; handle: string; type: string }[]

async function seedRoom(
  db: Database,
  spec: RoomSpec,
  actorId: string,
  crew: Crew,
): Promise<SeededRoom> {
  const agent = crew.find(
    (user) => user.handle === spec.agentHandle && user.type === 'agent',
  )
  // Every human aboard, plus the room's own agent — and never the other agents:
  // a roster of every agent on the ship is noise, and in a group only the
  // @mentioned ones answer anyway. The seeding actor is included whatever they
  // are, because `createChat` refuses a chat its creator isn't in.
  const wanted = [
    ...new Set([
      actorId,
      ...crew.filter((user) => user.type === 'human').map((user) => user.id),
      ...(agent ? [agent.id] : []),
    ]),
  ]
  const room: SeededRoom = {
    id: spec.id,
    title: spec.title,
    created: false,
    membersAdded: 0,
    widgetsAdded: 0,
    missingAgent: agent ? null : spec.agentHandle,
    error: null,
  }

  try {
    if (!(await getChat(db, spec.id))) {
      await createChat(db, {
        id: spec.id,
        title: spec.title,
        memberIds: wanted,
      })
      room.created = true
    }

    // Converge the roster. A crew member who joined after the room did would
    // otherwise never see it — which is the one thing that has to keep working
    // as people come aboard. The honest cost: somebody who LEFT a default room
    // is brought back on the next boot, because nothing records the difference
    // between "never joined" and "left". Leaving a default room isn't a move
    // the ship offers yet; when it is, this needs a record to read.
    const present = new Set(
      (await listMembers(db, spec.id)).map((m) => m.userId),
    )
    for (const userId of wanted) {
      if (present.has(userId)) continue
      await addMember(db, spec.id, userId)
      room.membersAdded++
    }

    // Whichever page is first — the crew's own if they made one, ours if this
    // is a fresh room. Never a second page: tidying up somebody's tabs is not
    // the seed's business.
    const page =
      (await listCanvasPages(db, spec.id)).at(0) ??
      (await createCanvasPage(db, {
        id: uuidv7(),
        chatId: spec.id,
        title: spec.page,
        actorId,
      }))

    // By KIND, over the room's whole history — dismissed rows included, so a
    // tile the crew waved away stays away.
    const held = new Set((await listWidgets(db, spec.id)).map((w) => w.kind))
    for (const widget of spec.widgets) {
      if (held.has(widget.kind)) continue
      const row = await addWidget(db, {
        id: uuidv7(),
        chatId: spec.id,
        kind: widget.kind,
        props: widget.props,
        createdById: actorId,
      })
      // Onto the canvas: these are readouts you keep in front of you, which is
      // the state-shaped surface. `placeWidget` clamps the box and finds the
      // first free slot, so a room that grew a widget later doesn't land it on
      // top of one somebody arranged.
      await placeWidget(db, {
        widgetId: row.id,
        actorId,
        pageId: page.id,
        gridW: widget.gridW,
        gridH: widget.gridH,
      })
      room.widgetsAdded++
    }
  } catch (err) {
    // Reported, never thrown: the seed runs on every boot, and one unreachable
    // room (the operator was removed from it by hand, say — RLS then hides the
    // row from the very actor trying to converge it) must not cost the ship the
    // rooms after it in the list.
    room.error = errorMessage(err)
  }
  return room
}

// --- Homes ------------------------------------------------------------------

/**
 * How much page a seeded room tile takes. Half-width, so the three rooms read
 * as an arrangement on a desktop grid rather than one very tall column; a phone
 * shows one column whatever this says.
 */
const HOME_TILE = { gridW: 2, gridH: 3 }

/** What one person's home pass did — what the CLI prints and the tests assert on. */
export interface SeededHome {
  userId: string
  handle: string
  /** Rooms put on this person's home (0 if they'd already arranged it). */
  tilesAdded: number
  /** Why this home couldn't be seeded, if it couldn't. Never thrown. */
  error: string | null
}

/**
 * Put the ship's rooms on the crew's home screens.
 *
 * Since the home canvas became the front door, an empty grid is the FIRST thing
 * a new crew member sees, and a blank screen reads as a ship that failed to
 * load rather than one waiting for you. So the rooms the seed just opened get
 * arranged onto each person's home: three pointers at three conversations, and
 * the ship is visibly working before anybody has arranged anything.
 *
 * Two rules, both load-bearing:
 *
 * - **A home is personal, so each pass runs as its OWNER.** `home_canvas_*` is
 *   gated by `owner_id = the acting actor` (migration 0036) and there is no
 *   door anywhere that takes an `ownerId` — deliberately. The operator running
 *   `npm run rooms seed` cannot write somebody else's home and this function
 *   does not try: it's handed an `asActor` and opens one RLS context per
 *   person. That also means each pin resolves the rooms through the CHAT
 *   service under THAT person's membership, so a room they aren't in simply
 *   doesn't land on their home.
 * - **It arranges a home ONCE, and there's a row that says so.** Two conditions
 *   have to hold before anything is pinned: the ship has never considered this
 *   home before (`wasHomeSeeded`), and the home is empty. The first is what
 *   makes the second safe. Emptiness alone cannot tell *untouched* from *I
 *   removed everything*, so the old predicate resurrected the whole default
 *   arrangement for anybody who unpinned their tiles and deleted their last
 *   page — every boot, forever, which is the ship arguing with its crew. Now
 *   the marker is written whether or not a tile lands, so a deliberate
 *   clear-out sticks and a home somebody had already arranged before this row
 *   existed is recorded as finished rather than re-decided on every boot.
 *
 *   Both writes ride the one transaction `asActor` opens, so a pass that fails
 *   half way leaves no marker and the next boot converges the person properly.
 */
export async function seedHomes(input: {
  /** Everybody aboard. Agents are skipped — a home screen needs a thumb. */
  crew: Crew
  rooms?: readonly RoomSpec[]
  /** Run a unit of work under one crew member's own RLS context. */
  asActor: <T>(userId: string, fn: (db: Database) => Promise<T>) => Promise<T>
}): Promise<SeededHome[]> {
  const rooms = input.rooms ?? DEFAULT_ROOMS
  const report: SeededHome[] = []
  for (const user of input.crew) {
    if (user.type !== 'human') continue
    const home: SeededHome = {
      userId: user.id,
      handle: user.handle,
      tilesAdded: 0,
      error: null,
    }
    try {
      await input.asActor(user.id, async (tx) => {
        // The ship has had its one go at this home. Whatever it looks like now
        // is the crew's business — including nothing at all.
        if (await wasHomeSeeded(tx, user.id)) return
        // Written before the pins and inside the same transaction, so this pass
        // is the last one either way: a home that's already arranged is left
        // alone AND recorded as finished, rather than re-decided every boot.
        await markHomeSeeded(tx, user.id)
        const [pages, tiles] = await Promise.all([
          listHomePages(tx, user.id),
          listHomeTiles(tx, user.id),
        ])
        // Anything at all here is somebody's arrangement. Leave it.
        if (pages.length > 0 || tiles.length > 0) return
        // Their membership, read as them — never the spec list, which says
        // nothing about whether this person is actually in the room.
        const mine = new Set(
          (await listChatSummaries(tx, user.id)).map((chat) => chat.id),
        )
        for (const room of rooms) {
          if (!mine.has(room.id)) continue
          // Point at the room's READOUT, not just at the room. A chat pointer
          // shows whatever is on top of that chat's stack, and a room's tile
          // lives on its CANVAS — so three chat pointers would give a brand-new
          // crew member three tiles all saying "nothing raised right now",
          // which is a blank screen with extra steps. Pinning the widget puts
          // the open issues, the documents and the inbox on the home screen on
          // the very first load: the ship, visibly working. The tile still
          // names its room and links into it, so the conversation is one tap
          // away either way.
          const readout = (await listCanvasWidgets(tx, room.id)).at(0)
          // No readout (somebody waved it away) — fall back to a live chat
          // pointer rather than skipping the room entirely.
          await pinHomeTile(tx, {
            id: uuidv7(),
            ownerId: user.id,
            ...(readout ? { widgetId: readout.id } : { chatId: room.id }),
            // No page named: the first pin makes their landing page, and the
            // rest find their own free slot on it.
            ...HOME_TILE,
          })
          home.tilesAdded++
        }
      })
    } catch (err) {
      // Reported, never thrown — the same rule the room pass keeps, for the
      // same reason: this runs on every boot, and one odd home must not cost
      // the ship the crew after it in the list.
      home.error = errorMessage(err)
    }
    report.push(home)
  }
  return report
}
