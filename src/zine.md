# The Ship

_src zine — issue #cse9_

## tl;dr

Skylark's codebase is one TypeScript app. All source lives under `src/`: a thin
**serving layer** at the root, sitting above three **decks** — `hull`,
`rigging`, and `home`. It's a [TanStack Start](https://tanstack.com/start)
application, so a single server handles both the web UX and the backend logic.

You extend the ship by adding **services** (a slice of data, the logic over it,
and the doors onto it) and **views** (UI), then wiring them in through thin
**routes**. Data lives in Postgres, reached through Drizzle; views are built
with Tailwind and shadcn.

## Components

- **Deck** — one of the three source areas: hull, rigging, home.
- **Hull** — the load-bearing foundation, shared by every ship. See
  [`hull/zine.md`](hull/zine.md).
- **Rigging** — the stdlib: the design system, plus default views and
  components.
- **Home** — your sovereign space. Empty in a fresh clone.
- **Serving layer** — the `src/` root (`router.tsx`, `routes/`, `schema.ts`,
  `migrations/`). The composition root: it assembles the running app by pulling
  views and services in from the decks.
- **Service** — the native unit of work: data + logic + doors. Created via the
  `create-service` skill.
- **Server function** — a function (`createServerFn`) that always runs on the
  server but is called from the client like a local one. The web door onto a
  service.
- **Route** — a file in `src/routes` binding a URL to a view and the data it
  needs. Thin: the view itself contains no routing.
- **Schema** — each service's own `schema.ts` holds its tables; drizzle-kit
  auto-discovers every `src/**/schema.ts`, so there's nothing to wire by hand.
- **Crew** — the people and agents aboard; the identity the whole system is
  scoped to. The data model and actor resolution live in the hull's users
  service; access is enforced with Postgres Row-Level Security in the hull's db
  foundation (see [`hull/zine.md`](hull/zine.md)).
- **The ship's log** — the durable event bus services emit to and subscribe on,
  in the hull's events service (see [`hull/zine.md`](hull/zine.md)).
- **Files** — the crew's shared documents: real files in the repo
  (`src/home/files/`), staged and auto-merged by the hull's files service
  ([`hull/files/zine.md`](hull/files/zine.md)).
- **Widgets** — the live little views a chat keeps open, on two surfaces: the
  turn-shaped **stack** above its composer and the state-shaped **canvas**
  beside its thread. The row lives in the hull's chat service; what a kind MEANS
  lives in the rigging catalog
  ([`rigging/widgets/zine.md`](rigging/widgets/zine.md)) — hull holds the row,
  rigging holds the meaning.
- **Rooms** — the conversations a fresh ship boots with (Issues, Files, Inbox),
  each with an agent aboard and its readout already on the canvas. Seeded
  idempotently by `npm run rooms seed`, on the rigging deck with the catalog
  they arrange ([`rigging/zine.md`](rigging/zine.md)).
- **The home canvas** — **the front door** (`/`): your own personal screen of
  **pointers** at widgets living in chats you're in. A widget instance always
  lives in exactly one chat; home is the one surface in the ship that points
  rather than contains, and a pointer is not a grant — what a tile shows is
  resolved from your CURRENT membership on every read
  ([`hull/home-canvas/zine.md`](hull/home-canvas/zine.md)).
- **The rail** — the ship's four permanent, hardcoded navigation entries (Home,
  Chats, Crew, Models) plus a way out, on every surface
  ([`rigging/views/dock.tsx`](rigging/views/dock.tsx)). Short and hardcoded
  because everything else about navigation is now data somebody can delete; see
  the decision below.
- **Notifications** — every user's inbox, fed by watches on ship-log topics; for
  agents, a notification is a wake-up
  ([`hull/notifications/zine.md`](hull/notifications/zine.md)).
- **Zine** — a short, readable spec like this one.

## Structure

**Import direction.** `home → rigging → hull`: a deck imports only the decks
below it. The `src/` serving layer is the one exception — it may import from all
three, because wiring them together is its job.

**Getting around.** `/` is your home canvas; `/chat` is every conversation;
`/agents` and `/models` are the two surfaces that aren't conversations. Issues,
Files and Inbox are reached through their ROOMS (default chats,
[`rigging/zine.md`](rigging/zine.md)), each of which links through to its own
richer view — those routes are alive, they just aren't in the rail any more —
and each of those views carries the way back to its room.
`src/navigation.test.ts` holds the whole claim: every route the ship serves is
reachable from the rail or from a default room, or is named in that file as
deliberately not a destination, and the three that left the rail are reachable
in BOTH directions.

**A request, end to end.** A browser hits a route in `src/routes` → the route's
loader calls a server function → the server function calls a service's pure
logic in a deck → the logic queries Postgres through the shared connection `db`
from `@hull/db/client` → the typed result flows back out to the view. One server
(Vite in dev, Nitro in build) runs all of it in one process.

**Schema.** Each service owns its tables in its own `schema.ts`; drizzle-kit
discovers every `src/**/schema.ts` automatically (`drizzle.config.ts`), so a new
service's tables join migrations with nothing to wire up by hand.

**Tests.** Service logic is database-agnostic, so tests drive it against
in-memory PGlite — real Postgres, no external database.

## Decisions

- **Imports flow one way: `home → rigging → hull`** (only `src/` crosses all
  decks). Keeps the hull clonable and the graph acyclic.
- **A thing's deck is decided by load-bearingness:** if customizing it would
  cascade into breakage, it's hull; if it's a starting point people freely
  tweak, it's rigging.
- **Services are decoupled.** A service reads and writes only its own tables; it
  learns about other services through the ship's log, never by reaching into
  their tables.
- **Access is structural — every row knows its crew.** Crew-scoping is built
  into tables and queries by construction, never added afterward. (Enforced in
  the hull; see [`hull/zine.md`](hull/zine.md).)
- **Tests depend on no external services.** Database tests use PGlite, and the
  type path stays codegen-free — fewer moving parts between a change and seeing
  it work.
- **The app runs natively; its dependencies run in Docker.** Postgres for a
  pinned, disposable database, and the LiteLLM gateway so every model call goes
  through one OpenAI-compatible endpoint whose providers are config, not code.
- **Navigation is data, so the rail is not.** Which chats you're in, which pages
  you made, which tiles you kept — all of it is rows, and rows can be deleted.
  Without a fixed floor, a crew member can arrange their way into a corner where
  "where's my inbox?" becomes "which page had the inbox tile?" with no path
  back. The rail is that floor: four entries, hardcoded, on every screen,
  consulting no row, identical for somebody whose home is completely empty. It
  stays SHORT for the same reason it exists — a rail that grew an entry per
  surface would be the dock again, and the point of the chat-native turn is that
  most surfaces are conversations.
- **One npm package, no workspaces.**

## Changelog

- **#cse9 — The closing pass: nothing new, everything durable.** The three views
  that left the rail stop being one-way doors; the home seed learns to run once
  per person, so clearing your home is a decision the next boot respects; a tile
  stops being a fixed box full of unbounded contents on a phone; and the chat
  header folds to one row that can't grow again
  ([`rigging/zine.md`](rigging/zine.md)). The `/?chat=<id>` redirect the last
  slice left behind is pinned by the smoke suite now, where a redirect whose job
  is to work for years belongs.
- **#cse8 — Chat became the front door in #5; now it's the ship.** `/` is your
  home canvas, `/chat` is every conversation, and the old `/?chat=<id>` links
  agents posted for months redirect there with the parameter intact. The dock
  becomes a four-entry permanent **rail** (Home, Chats, Crew, Models) — a bottom
  bar on a phone — and Issues, Files and Inbox leave it for their rooms, each
  room linking through to the view it replaced. The rooms seed now also arranges
  every crew member's home with those rooms' readouts, so nobody's first screen
  is a blank grid ([`rigging/zine.md`](rigging/zine.md)).
- **The apps were conversations all along: two of them get rooms.** `files` and
  `inbox` join the widget catalog, and the ship boots with an Issues, a Files
  and an Inbox chat holding them ([`rigging/zine.md`](rigging/zine.md)). The
  `/issues`, `/files` and `/inbox` routes are untouched — what the front door IS
  is a separate question.
- **A home canvas: pointers, in exactly one place.** Every widget still lives in
  a chat; your home holds live views onto them, and losing chat membership stops
  a tile rendering at the read. See
  [`hull/home-canvas/zine.md`](hull/home-canvas/zine.md).
- **A chat gets a canvas.** Pages of widgets the crew arranged, beside the
  thread rather than as a destination — and which page you're looking at is
  yours, not the chat's. See [`hull/chat/zine.md`](hull/chat/zine.md).
- **Chat widgets get a catalog, in rigging.** Hull holds the widget row; rigging
  holds the meaning — see [`rigging/widgets/zine.md`](rigging/widgets/zine.md).
- **Agent profiles retire; config moves onto the agent.** The Agents surface's
  Profiles tab folds into Crew — see [`hull/agent/zine.md`](hull/agent/zine.md).
- **#6** — The planning loop closes: files + notifications services, agent
  memory, agent wake-ups back into the origin chat, hosted chat model.
- **#5** — Chat becomes the ship's front door
  ([`hull/chat/zine.md`](hull/chat/zine.md)); every door resolves the actor with
  `currentActor()`.
- **#4** — The Agents surface: create/edit profiles + the session monitor (moved
  from the old front-door chat).
- **#3** — Issues + building agents
  ([`hull/issues/zine.md`](hull/issues/zine.md)), the board/thread views, and
  the dock.
- **#2** — The ship's log (durable event bus) and the crew (users + actor
  resolution) land in the hull.
- **#1** — The keel: TanStack Start, `src/` over hull/rigging/home, Drizzle +
  Postgres (PGlite in tests), Tailwind + shadcn.
