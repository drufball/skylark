# The Ship

_src zine — issue #1_

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
- **Serving layer** — the `src/` root (`router.tsx`, `routes/`, `schema.ts`).
  The composition root: it assembles the running app by pulling views and
  services in from the decks.
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
  service; the compile-time crew-filter enforcement is still deferred (see
  [`hull/zine.md`](hull/zine.md)).
- **The ship's log** — the durable event bus services emit to and subscribe on,
  in the hull's events service (see [`hull/zine.md`](hull/zine.md)).
- **Files** — the crew's shared documents: real files in the repo
  (`src/home/files/`), staged and auto-merged by the hull's files service
  ([`hull/files/zine.md`](hull/files/zine.md)).
- **Notifications** — every user's inbox, fed by watches on ship-log topics; for
  agents, a notification is a wake-up
  ([`hull/notifications/zine.md`](hull/notifications/zine.md)).
- **Zine** — a short, readable spec like this one.

## Structure

**Import direction.** `home → rigging → hull`: a deck imports only the decks
below it. The `src/` serving layer is the one exception — it may import from all
three, because wiring them together is its job.

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
- **Only Postgres is containerized.** The app, Ollama, and pi.dev run natively,
  so local models stay reachable; Postgres runs in Docker for a pinned,
  disposable database.
- **One npm package, no workspaces.**

## Changelog

- **#6** — The planning loop closes. Chat agents run on a strong hosted model
  when a key is configured (builders stay local); named agents get persistent
  memory (`agents/<handle>/` in the shared files, folded into every session
  boot) and a Crew tab; the **files** service lands (staged git-backed docs +
  the Files surface, [`hull/files/zine.md`](hull/files/zine.md)); and
  **notifications** land (inbox + watches + the Inbox surface,
  [`hull/notifications/zine.md`](hull/notifications/zine.md)) — through which an
  agent that files an issue from a chat (`--chat` provenance) is **woken in that
  chat** as the work moves, to review and file the next piece.
- **#5** — Chat becomes the ship's front door (`/`): conversations between crew
  (humans and agents), in the hull's chat service
  ([`hull/chat/zine.md`](hull/chat/zine.md)), with membership as visibility and
  agent replies driven through backing sessions. The front door opens your most
  recent chat. Every door now resolves the acting user with `currentActor()`, so
  the system knows it's you without being told.
- **#4** — The **Agents** surface fills the dock's last slot: create/edit agent
  profiles, and monitor sessions (the old front-door chat ux, which was only
  ever a session monitor, moved here) — unstick a wedged one with a direct
  message.
- **#3** — The message board and building agents land in the hull's issues
  service ([`hull/issues/zine.md`](hull/issues/zine.md)): issues with a
  lifecycle, and an event-driven orchestrator that reacts to the ship's log to
  drive a builder agent through a git worktree to a merged PR. The rigging gains
  a board, an issue thread, and the **dock** — a persistent app-shell nav
  (Chat/Issues, with an Agents slot for later).
- **#2** — Two named-but-unbuilt components become real, in the hull: the ship's
  log (a durable event bus, so "everything is an event" works across processes
  and reconnects) and the crew (users + actor resolution; the crew-filter
  enforcement stays deferred). See [`hull/zine.md`](hull/zine.md).
- **#1** — The keel: TanStack Start app, `src/` serving layer over hull/rigging/
  home, Drizzle + Postgres (PGlite in tests), Tailwind + shadcn. A hello-world
  slice (route → server function → Drizzle → Postgres) proves the wiring.
