import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

import { chats, chatWidgets } from '@hull/chat/schema'
import { users } from '@hull/users/schema'

/**
 * The **home canvas**: your own screen of tiles, and the one place in the whole
 * ship where indirection lives.
 *
 * A widget instance always lives in exactly one chat (`chat_widgets`, owned by
 * the chat service) — that never changes. What a home canvas holds is
 * **pointers** at those widgets: a tile here is a placement, not an instance,
 * exactly like an iOS home screen holds a live view onto an app whose real home
 * is somewhere else. Keeping indirection to this ONE surface is the whole
 * bargain: a chat canvas contains its widgets directly, and nothing else in the
 * system gets a pointer.
 *
 * **A pointer is not a grant.** Nothing in these tables says who may see what.
 * Whether a tile renders is decided at READ time from the viewer's CURRENT chat
 * membership, by asking the chat service under the viewer's own RLS context
 * (see service.ts) — never from what was true when they pinned it. Losing
 * membership stops the content dead, and the tile degrades to an honest "you no
 * longer have access to this" placeholder, which is safe here only because a
 * home canvas is PERSONAL: there is no third party on your own home screen to
 * leak the existence of a chat to. (It would NOT be safe on a shared surface.)
 */

/**
 * One page of ONE person's home canvas. Owner-scoped and `not null`: there is
 * deliberately no shared or nullable-owner variant, so there is no orphan state
 * to reason about — every page belongs to exactly one crew member, forever.
 */
export const homeCanvasPages = pgTable(
  'home_canvas_pages',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** Where it sits in the page strip, low first. `order` is SQL-reserved. */
    pageOrder: integer('page_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('home_canvas_pages_owner_idx').on(table.ownerId, table.pageOrder),
  ],
)

/**
 * One tile on a home page — a POINTER, in one of exactly two modes:
 *
 * - **`widgetId`** — a specific widget instance. Stable: it always shows that
 *   one widget, wherever it sits in its chat.
 * - **`chatId`** — a live pointer at a conversation, rendering whatever is
 *   currently at the top of that chat's stack. This is the mode the whole
 *   product is for: an agent raises a question in a chat and it appears on your
 *   home screen, and you answer it with a thumb without ever opening the chat.
 *
 * Exactly one is set (the check constraint below). Both cascade, so a deleted
 * chat or a deleted chat's widget takes its pointers with it — a tile can never
 * point at nothing, which is what keeps the "you no longer have access" state
 * meaning exactly that and not "the thing is gone".
 *
 * `ownerId` is repeated here rather than reached through the page, so the RLS
 * policy (migration 0036) is a single-table predicate with no join and no
 * SECURITY DEFINER wrapper: `owner_id = the acting user`, and that's the whole
 * rule. Home is personal, so it needs nothing more.
 */
export const homeCanvasTiles = pgTable(
  'home_canvas_tiles',
  {
    id: text('id').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pageId: text('page_id')
      .notNull()
      .references(() => homeCanvasPages.id, { onDelete: 'cascade' }),
    /** Pointer mode 1: this exact widget instance, wherever it lives. */
    widgetId: text('widget_id').references(() => chatWidgets.id, {
      onDelete: 'cascade',
    }),
    /** Pointer mode 2: whatever is at the top of this chat's stack right now. */
    chatId: text('chat_id').references(() => chats.id, { onDelete: 'cascade' }),
    /** The tile's cell rectangle, clamped by the same `clampCanvasBox` a chat canvas uses. */
    gridX: integer('grid_x').notNull().default(0),
    gridY: integer('grid_y').notNull().default(0),
    gridW: integer('grid_w').notNull().default(2),
    gridH: integer('grid_h').notNull().default(2),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One page's tiles, in arrangement order — which is also the order a phone
    // stacks them into a single column, exactly like the chat canvas.
    index('home_canvas_tiles_page_idx').on(
      table.pageId,
      table.gridY,
      table.gridX,
    ),
    // A tile points at ONE thing. Two targets would make "what does this show?"
    // ambiguous at read time, and none would make it a tile pointing at nothing
    // — both are states no door should be the only thing preventing.
    check(
      'home_canvas_tiles_one_target',
      sql`(${table.widgetId} is null) <> (${table.chatId} is null)`,
    ),
  ],
)

/**
 * One row per crew member: **the ship has already arranged this home once.**
 *
 * The rooms seed (`rigging/rooms/seed.ts`) puts the default rooms' readouts on
 * a new crew member's home so nobody's first screen is a blank grid. Its whole
 * predicate used to be "this home has no pages and no tiles", which cannot tell
 * *empty because untouched* from *empty because I removed everything* — so
 * somebody who unpinned their tiles and deleted their last page got the entire
 * default arrangement back on the next boot. That is the ship arguing with its
 * crew, and it argues forever.
 *
 * This row is the difference the emptiness couldn't carry. It's written the
 * first time the seed considers a home — whether or not it pins anything — and
 * after that the seed never looks at that home again. Deliberately not a column
 * on `users`: it's home-canvas state, and the users service must not grow a
 * field about a surface it knows nothing about.
 *
 * Under the same one-line policy as the rest of this service (migration 0038):
 * the row is yours, and the seed only ever writes it while running as you.
 */
export const homeCanvasSeeds = pgTable('home_canvas_seeds', {
  ownerId: text('owner_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  seededAt: timestamp('seeded_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

export type HomeCanvasPageRow = typeof homeCanvasPages.$inferSelect
export type HomeCanvasTileRow = typeof homeCanvasTiles.$inferSelect
