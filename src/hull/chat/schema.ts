import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core'

import { agentSessions } from '@hull/agent/schema'
import { users } from '@hull/users/schema'

import type { JsonValue } from './widgets'

// The chat service owns these tables. A chat is a conversation between a set of
// users (humans and agents); membership IS visibility — only members see a chat,
// and an added member sees the whole history (no per-message ACL). Chat lives in
// the hull: it's load-bearing (there's more planned for it) and it drives the
// ship's resident agents, like the issues board does.
//
// Agents are members too. When a chat needs an agent to speak, the chat
// orchestrator drives a backing agent session (one per chat+agent, recorded on
// the membership row) and posts the agent's reply back as a chat message — so
// the clean chat transcript here and the agent's full tool-call transcript stay
// separate surfaces over one conversation.

/** One conversation. */
export const chats = pgTable('chats', {
  id: text('id').primaryKey(),
  /** Optional human title; null shows as the member list. */
  title: text('title'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Bumped on every message — drives the recency-ordered sidebar. */
  lastMessageAt: timestamp('last_message_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/**
 * Who is in a chat — the visibility list. One row per (chat, user). For an agent
 * member, `sessionId` points at the backing agent session that speaks for it in
 * this chat (created lazily on first response, kept so the agent has continuity).
 */
export const chatMembers = pgTable(
  'chat_members',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The agent's backing session for this chat; null for humans / not-yet-spoken. */
    sessionId: text('session_id').references(() => agentSessions.id, {
      onDelete: 'set null',
    }),
    /**
     * The agent's latest live "working…" line, persisted (not just streamed
     * over SSE) so the bubble survives a page navigation. Null when the agent
     * isn't mid-turn.
     */
    progressLine: text('progress_line'),
    /**
     * How far this member's turns have READ the chat — advanced by the
     * orchestrator when a reply turn ends, whether or not the agent chose to
     * speak. Needed because an agent now speaks by calling `chat_post` from its
     * own turn, so "the agent took a turn and said nothing" is a first-class
     * outcome: without a watermark of its own, a silent turn would leave the
     * same messages unseen forever and re-feed them on every later reply.
     *
     * NOT the whole watermark on its own. `messagesSinceAgent` resolves the
     * watermark as max(this column, the last message this member AUTHORED) — so
     * a crash between an agent's post landing and this write cannot re-drive a
     * turn that already spoke. See the note there.
     *
     * `set null` on delete rather than cascade: losing the watermark re-feeds
     * some history (chatty, recoverable), where cascading the member row away
     * would drop somebody out of a conversation (not).
     */
    lastSeenMessageId: text('last_seen_message_id').references(
      (): AnyPgColumn => chatMessages.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.userId] })],
)

/** One message in a chat, authored by a member (human or agent). */
export const chatMessages = pgTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('chat_messages_chat_idx').on(table.chatId, table.id)],
)

/**
 * A message queued to post itself into a chat later — one-shot or recurring —
 * owned entirely by the chat service. It fires by posting a chat message AS its
 * `authorId` (the same message write + event as any post, committed atomically
 * with the schedule's advance), so the existing reply rules do the rest: a
 * human-authored schedule triggers agent replies (a recurring task), an
 * agent-authored one triggers none (a recurring announcement; agents never
 * trigger agents).
 *
 * Timing is one of two shapes, never both: a one-shot carries `fireAt` (and is
 * disabled once it fires); a recurring one carries `intervalMinutes` with a
 * `nextFireAt` advanced each fire. Schedules ride chat membership like messages
 * (RLS, migration 0027) — visible to every member, no invisible clockwork.
 *
 * NOTE: the timing XOR and the author rule ("posts as the creator or an agent
 * member, never another human") are enforced at the doors (scheduleTiming,
 * canAuthorSchedule in service.ts), NOT in the schema/RLS — every write path
 * must go through them. RLS only gates visibility by chat membership.
 */
export const chatSchedules = pgTable(
  'chat_schedules',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    /** The member this posts AS — the creator themself, or an agent member; never another human. */
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    /** One-shot: the single time to fire. Null for a recurring schedule. */
    fireAt: timestamp('fire_at', { withTimezone: true }),
    /** Recurring: whole minutes between fires (floor enforced at the door). Null for a one-shot. */
    intervalMinutes: integer('interval_minutes'),
    /** Recurring: the next time to fire, advanced each fire. Null for a one-shot. */
    nextFireAt: timestamp('next_fire_at', { withTimezone: true }),
    /** Off never fires; a fired one-shot is disabled (consumed), not deleted. */
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Who created the schedule (audit) — distinct from `authorId`, who it posts as. */
    createdById: text('created_by_id')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    index('chat_schedules_chat_idx').on(table.chatId),
    // The sweep scans enabled rows by due time (fireAt for one-shots, nextFireAt for recurring).
    index('chat_schedules_due_idx').on(
      table.enabled,
      table.fireAt,
      table.nextFireAt,
    ),
  ],
)

/**
 * A live little view kept open inside a chat — a poll to answer, a meter to
 * watch. **A widget instance is not data, it's a piece of the conversation:** a
 * lens some crew agreed to keep open together. So its lifetime is the
 * conversation's lifetime (the cascade below, not a cleanup job), its access is
 * the conversation's access (chat membership under RLS, migration 0031), and its
 * CONTENTS are fetched fresh on render — never stored here.
 *
 * A widget instance always lives in exactly one chat; nothing else ever owns
 * one. That's why this table sits in the chat service rather than a service of
 * its own: half the row's identity IS a chat id, so owning it here needs no new
 * cross-service coupling.
 *
 * The row knows nothing about specific kinds. `kind` and `props` are opaque
 * strings/JSON to it; what they mean is `widgets.ts`'s `parseProps`, which is
 * total — an unparseable blob or a kind this ship no longer knows renders an
 * honest tile, never a crash. Rows outliving their definitions is expected, not
 * a bug.
 *
 * `dismissedAt` is set when an ephemeral widget is answered or waved away: the
 * widget leaves the stack, but the row survives as history — what was asked, of
 * whom, and when it stopped being open.
 *
 * NOTE: only an ACTOR with judgment raises a widget — an agent or a human,
 * through a door, from its own turn. No service reaches in here to put something
 * in front of a human; that rule is what keeps the service graph untangled (see
 * chat/zine.md).
 */
export const chatWidgets = pgTable(
  'chat_widgets',
  {
    id: text('id').primaryKey(),
    /** The one chat this widget lives in — cascade, so it can never be orphaned. */
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    /** Which widget this is — opaque here; `widgets.ts` gives it meaning. */
    kind: text('kind').notNull(),
    /** The kind's own configuration — opaque here; validated by `parseProps`. */
    props: jsonb('props').$type<JsonValue>().notNull(),
    /**
     * Which surface it renders on: `stack` (above the composer, turn-shaped) or
     * `canvas` (a page you arranged, state-shaped). See widgets.ts for the
     * division of labour. Crossing between them is an ordinary update of this
     * column plus the page/grid ones below — deliberately not a special
     * mechanism, since that same update is how an agent raises a canvas widget
     * into the stack when it needs your attention.
     */
    placement: text('placement').notNull().default('stack'),
    /** Position within the stack, low first. Agents may write this to reorder. */
    stackOrder: integer('stack_order').notNull().default(0),
    /**
     * Which canvas page it sits on. Null for a stack widget; set (with the grid
     * box below) for a canvas one. Cascades, so a page can never leave widgets
     * pointing at nothing — though the doors only ever delete an EMPTY page, so
     * the cascade is a backstop rather than the path a human takes.
     */
    pageId: text('page_id').references(() => chatCanvasPages.id, {
      onDelete: 'cascade',
    }),
    /**
     * The tile's cell rectangle on its page — read only when `placement` is
     * `canvas`, and clamped into the grid by `clampCanvasBox` at every door. A
     * stack widget carries the defaults and nothing reads them.
     */
    gridX: integer('grid_x').notNull().default(0),
    gridY: integer('grid_y').notNull().default(0),
    gridW: integer('grid_w').notNull().default(2),
    gridH: integer('grid_h').notNull().default(2),
    /** Set when answered or waved away: out of the stack, kept as history. */
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    /** Which member put it here (audit) — a widget is always somebody's judgment. */
    createdById: text('created_by_id')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The stack read: one chat's widgets, in the order they render.
    index('chat_widgets_chat_idx').on(
      table.chatId,
      table.placement,
      table.stackOrder,
    ),
    // The canvas read: one page's widgets, in the order they're arranged (which
    // is also the order a phone stacks them into a single column).
    index('chat_widgets_page_idx').on(table.pageId, table.gridY, table.gridX),
  ],
)

/**
 * One page of a chat's **canvas** — the spatial surface beside the thread, where
 * widgets are arranged and stay put. Like a home screen: several pages, each
 * named, each holding a grid of tiles.
 *
 * Pages are EXPLICIT rows rather than implied by whichever widgets happen to
 * carry a page number, because the two things we most want are impossible
 * otherwise: an empty page you just made and haven't filled yet, and a page with
 * a name and a place in the order.
 *
 * Access is chat membership under RLS (migration 0034), deferring to 0007's
 * `app_can_see_chat` like `chat_widgets` and `chat_schedules` do — a page belongs
 * to exactly one chat and nothing else ever owns one, so its lifetime and its
 * visibility are the conversation's.
 */
export const chatCanvasPages = pgTable(
  'chat_canvas_pages',
  {
    id: text('id').primaryKey(),
    /** The one chat this page belongs to — cascade, so it can't be orphaned. */
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** Where it sits in the page strip, low first. `order` is SQL-reserved. */
    pageOrder: integer('page_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('chat_canvas_pages_chat_idx').on(table.chatId, table.pageOrder),
  ],
)

/**
 * What ONE person is looking at in ONE chat — the canvas page in front of them.
 *
 * **This is per viewer, not per chat, and that distinction is the whole point.**
 * Three people in a chat can be on three different pages, so "which page is
 * open" is a property of the person, never of the conversation. Keyed by (chat,
 * user) and persisted so a reload puts you back where you were; read by the
 * orchestrator when it builds a turn, so an agent answering "what's this?" knows
 * what's in front of THAT person.
 *
 * Nothing here is broadcast: changing your own view emits no ship-log event,
 * because your view is not news for the rest of the crew. And no door lets an
 * agent write somebody else's row — moving a person's view without their consent
 * is a later, carefully-designed thing, not a side effect of this table
 * existing. RLS (migration 0034) holds that line: you may only touch your own.
 */
export const chatViewState = pgTable(
  'chat_view_state',
  {
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The page this person has open. Null (or no row) means the thread alone —
     * they haven't opened the canvas. `set null` on the page's deletion, so
     * tidying a page doesn't delete somebody's place in the chat.
     */
    pageId: text('page_id').references(() => chatCanvasPages.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.userId] })],
)

export type ChatRow = typeof chats.$inferSelect
export type ChatMemberRow = typeof chatMembers.$inferSelect
export type ChatMessageRow = typeof chatMessages.$inferSelect
export type ChatScheduleRow = typeof chatSchedules.$inferSelect
export type ChatWidgetRow = typeof chatWidgets.$inferSelect
export type ChatCanvasPageRow = typeof chatCanvasPages.$inferSelect
