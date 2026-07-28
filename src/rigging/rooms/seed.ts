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
  listMembers,
  listWidgets,
  placeWidget,
} from '@hull/chat/service'
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
type Crew = { id: string; handle: string; type: string }[]

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
