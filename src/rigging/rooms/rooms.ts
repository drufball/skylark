import type { JsonValue } from '@hull/chat/widgets'

/**
 * The rooms a Skylark boots with.
 *
 * The thesis of this deck's chat-native turn is that the ship's "apps" were
 * never apps — they were conversations that hadn't been given a room yet. A
 * default room is that room: a chat with the crew in it, an agent already
 * aboard, and the readout the surface used to BE arranged on its canvas. The
 * agent sitting beside the thing is the whole point; a board you can only stare
 * at is the surface we already had.
 *
 * **This is data, deliberately.** The seed (`seed.ts`) knows how to make a room
 * idempotently and knows no kind by name; the kinds and props live here, on the
 * deck that holds what a widget MEANS. Nothing validates the blobs at runtime —
 * `rooms.test.ts` does it at build time, against the real catalog, so a room
 * can't ship props the tile would only refuse.
 *
 * It's on the RIGGING deck because these are a starting point, not a
 * foundation: a ship is meant to rename these rooms, rearrange them, add
 * widgets, or delete this list outright, and nothing below breaks.
 */

/** One widget a fresh room is arranged with, and how much page it takes. */
export interface RoomWidgetSpec {
  /** A kind from the catalog (`@rigging/widgets/registry`). */
  kind: string
  /** The blob the kind's own parser has to accept — pinned by `rooms.test.ts`. */
  props: JsonValue
  /** Columns of the four-column canvas grid. */
  gridW: number
  /** Rows of the canvas grid. */
  gridH: number
}

/**
 * The richer, non-chat view a room is the room FOR — the board, the browser,
 * the full notification list. A tile is a readout; this is the whole surface.
 */
export interface RoomViewLink {
  /** A route in `src/routes`. */
  to: string
  /**
   * What the link says in the room's own header. Short: it shares a 390px row
   * with the chat's name and the surface toggle, and a sentence there wraps the
   * header to a third line — the exact cost #cse5 spent a whole slice removing.
   */
  label: string
}

/** One default room: a chat the ship boots with, and what's arranged in it. */
export interface RoomSpec {
  /**
   * The chat's WELL-KNOWN id, and the room's whole identity. Not a uuid and not
   * the title: the seed finds a room by this and nothing else, which is exactly
   * what makes renaming one safe (a title-keyed seed would make a rename look
   * like a missing room and open a second one beside it).
   */
  id: string
  /** The title a FRESH room gets. Never rewritten — see the seed. */
  title: string
  /** The name of the canvas page a fresh room gets. */
  page: string
  /**
   * The agent who lives in this room, by handle. One of the standard crew
   * (`SEED_AGENTS`) — a room is not the place to invent a persona.
   */
  agentHandle: string
  /**
   * The surface this room replaced in the rail, still reachable from inside it
   * — or undefined for a room whose canvas widget is a filtered, app-specific
   * VIEW rather than the ship's whole answer to that surface (the Inbox room:
   * `/inbox` is a permanent rail entry now, #933f, so the room no longer owns
   * a route of its own; it's an ordinary conversation that happens to carry an
   * `inbox` tile).
   *
   * A room's canvas tile is a READOUT — eight issues, a folder, the last few
   * notifications — and the board it came from does things a tile doesn't. That
   * view stays a route; the room is now the way in. Without this link it would
   * be a page nobody could find, which is how a good working view gets deleted
   * by accident a slice later.
   */
  view?: RoomViewLink
  /** What a fresh room is arranged with, on its canvas. */
  widgets: RoomWidgetSpec[]
}

/**
 * The three rooms. Each gets the crew member whose documented speciality it is
 * (the reviewers in `.claude/agents/`, seeded as chat pilots): Tilde the
 * shipwright where the work is planned, Dot the quartermaster among the
 * documents she writes and edits, Bix the lookout beside what needs watching.
 *
 * Full-width tiles (`gridW: 4`) because a room holds one readout and a
 * half-width one would leave the page looking unfinished; on a phone the page
 * is a single column either way.
 */
export const DEFAULT_ROOMS: readonly RoomSpec[] = [
  {
    id: 'room-issues',
    title: 'Issues',
    page: 'Board',
    agentHandle: 'tilde',
    view: { to: '/issues', label: 'Board' },
    widgets: [
      {
        kind: 'issue-list',
        props: { statuses: ['open', 'building'], limit: 8 },
        gridW: 4,
        gridH: 3,
      },
    ],
  },
  {
    id: 'room-files',
    title: 'Files',
    page: 'Documents',
    agentHandle: 'dot',
    view: { to: '/files', label: 'All files' },
    widgets: [{ kind: 'files', props: {}, gridW: 4, gridH: 3 }],
  },
  {
    id: 'room-inbox',
    title: 'Inbox',
    page: 'Inbox',
    agentHandle: 'bix',
    // No `view`: `/inbox` is a permanent rail entry (#933f), not a surface this
    // room owns. The room is an ordinary conversation with @bix that happens
    // to carry a filtered `inbox` tile — exactly the "chat canvases can still
    // have inbox widgets" half of that issue.
    // No `unreadOnly`: an inbox room that empties itself as you read looks
    // broken. The tile marks unread and shows the rest.
    widgets: [{ kind: 'inbox', props: {}, gridW: 4, gridH: 3 }],
  },
  {
    id: 'room-config',
    title: 'Config',
    page: 'Config',
    agentHandle: 'keel',
    // No `view` either, for the same reason Inbox has none: this room is not
    // the whole answer to a surface that used to live at one route. Its three
    // underlying surfaces (`/models`, `/agents?tab=playbooks`,
    // `/agents?tab=crew`) are ALREADY reachable from the permanent rail
    // (Models, Crew) — giving this room its own `view` link would list one
    // of those surfaces twice, which `navigation.test.ts` refuses. The room
    // is a genuinely NEW front door (talk instead of clicking through three
    // separate settings pages), not a replacement for an existing route, so
    // it links to nothing and nothing needs to link back.
    widgets: [{ kind: 'config', props: {}, gridW: 4, gridH: 3 }],
  },
]

/**
 * The view a chat is the ROOM for, or null for an ordinary conversation —
 * which is nearly all of them. Keyed on the well-known id, like everything else
 * about a room, so renaming one doesn't cost it its link.
 *
 * Pure and node-free, because the chat route calls it in the browser.
 */
export function roomViewLink(chatId: string): RoomViewLink | null {
  return DEFAULT_ROOMS.find((room) => room.id === chatId)?.view ?? null
}

/**
 * The way BACK: given one of the richer views, the room it belongs to — or null
 * for a surface that is nobody's room, which is most of them.
 *
 * `roomViewLink` is the door out of a room and this is the door back in. It
 * exists because for one slice there wasn't one: `/issues` and `/files` left
 * the rail, gained a link IN from their rooms, and offered nothing out, so
 * the only way back was the browser's own back button — which is a rescue,
 * not navigation, and which strands anybody who arrived by typing the URL or
 * following a link an agent posted. (`/inbox` made the same trip and back
 * out again — #cse8 then #933f — so it no longer needs this door at all.)
 *
 * The label is built from the SEEDED title, not the chat's current one: this is
 * a pure, node-free function the browser calls with no database in reach, for
 * the same reason the rail is hardcoded. A crew that renames the Issues room
 * gets a link that still lands them in the right conversation and calls it by
 * the name the ship shipped with — the small honest cost of a link that cannot
 * fail to render.
 *
 * Pure and node-free, so a route can call it during render.
 */
export function roomForView(to: string): RoomViewLink | null {
  const room = DEFAULT_ROOMS.find((spec) => spec.view?.to === to)
  if (!room) return null
  return { to: `/chat?chat=${room.id}`, label: `${room.title} room` }
}
