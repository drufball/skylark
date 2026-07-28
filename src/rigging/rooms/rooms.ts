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
   * The surface this room replaced in the rail, still reachable from inside it.
   * A room's canvas tile is a READOUT — eight issues, a folder, the last few
   * notifications — and the board it came from does things a tile doesn't. That
   * view stays a route; the room is now the way in. Without this link it would
   * be a page nobody could find, which is how a good working view gets deleted
   * by accident a slice later.
   */
  view: RoomViewLink
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
    view: { to: '/inbox', label: 'Full inbox' },
    // No `unreadOnly`: an inbox room that empties itself as you read looks
    // broken. The tile marks unread and shows the rest.
    widgets: [{ kind: 'inbox', props: {}, gridW: 4, gridH: 3 }],
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
