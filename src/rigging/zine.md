# The Rigging

_rigging zine — issue #cse7_

## tl;dr

The rigging is the ship's stdlib: the design system plus the default views —
everything built on the hull that makes it actually sail. Unlike the hull, the
rigging is a **starting point**: it's meant to be tweaked, reskinned, and
replaced per ship without breaking anything below it.

## Components

- **UI primitives** (`components/ui/`) — shadcn/ui components. The generator's
  output is **owned code**, not a dependency: edit freely, and add new ones with
  `npx shadcn@latest add <x>`.
- **Views** (`views/`) — the default surfaces (chat, board, thread, files,
  inbox, agents, models, the dock). A view is a plain component: no routing, no
  data fetching of its own.
- **Theme** (`styles.css`) — the design tokens, as CSS variables (Tailwind v4).
  Restyling the ship is editing variables, not components.
- **`useShipLog`** (`lib/use-ship-log.ts`) — the client half of the ship's log:
  give it topic patterns and a callback, it opens an `EventSource` on
  `/api/stream?topics=…` and fires per event. This replaces polling.
- **Widgets** (`widgets/`) — the catalog of widget kinds a chat can keep open,
  and the shelf that renders them: [`widgets/zine.md`](widgets/zine.md). The
  hull owns the widget ROW; the catalog owns its meaning, because it has to know
  every service's topics — which is why it lives on this deck.
- **Default rooms** (`rooms/`) — the conversations a fresh ship boots with. A
  **room** is a chat with the crew in it, an agent aboard, and a readout already
  on its canvas: `Issues` (an `issue-list`, @tilde), `Files` (a `files` tile,
  @dot), `Inbox` (an `inbox` tile, @bix). `rooms.ts` is the specs as data,
  `seed.ts` the idempotent write, `cli.ts` the door — `npm run rooms seed`,
  which `scripts/serve` runs on every boot right after `npm run users seed`.

## Structure

**Views are wired by thin routes.** A file in `src/routes` binds a URL to a
view: its loader calls the hull's server functions and passes the data down as
props; mutations go back up through server-fn-calling props. The view itself
contains no router and no fetch, so it renders in a unit test and transplants to
another ship unchanged.

**Live updates ride the ship's log.** A route subscribes with `useShipLog` and
re-runs its loader when a matching event lands. The SSE contract is the hull's
(`/api/stream`, `StreamEvent`): the browser's `EventSource` auto-reconnects and
sends `Last-Event-ID`, so a dropped connection replays what it missed from the
durable log — the hook adds nothing but the subscription lifecycle.

**A room, from nothing to arranged.** `npm run rooms seed` resolves the acting
crew member, reads the crew, and for each spec: opens the chat if its well-known
id isn't there, brings every human plus the room's agent in, makes sure the
canvas has a page, and places any widget KIND the room has never held. Every
write goes through chat's own exported functions under that person's RLS
context, so the widgets carry their name — a room is somebody's arrangement,
never a service's.

## Decisions

- **Rigging is rigging because tweaking it is safe.** Load-bearing things (the
  durable services, the access rules) live in the hull; the rigging carries the
  experience. If customizing a thing would cascade into breakage, it doesn't
  belong here.
- **shadcn output is our code.** No wrapper layer, no upstream sync — a
  component is added once and then owned, like anything else in the repo.
- **Views take props, not dependencies.** Data in via props, mutations out via
  server-fn props, identity resolved by the hull (`currentActor()` — a view
  never asks who you are). The route is the only place a URL, a loader, and a
  view meet.
- **One theme, in variables.** Components reference tokens; ships restyle by
  editing `styles.css`.
- **The default rooms are rigging, not hull, and not a migration.** They name
  widget KINDS, and a kind's meaning is this deck's (the hull may not know one
  by name — see [`widgets/zine.md`](widgets/zine.md) for the cycle that forces
  it). They're also exactly what rigging is for: a starting arrangement a crew
  is meant to rename, rearrange or delete, with nothing below breaking. And they
  are a **seed, not a migration** — same convention as `npm run users seed` and
  `npm run agent seed`, run on every boot, so a room added to the list next year
  lands on ships that already sailed.
- **The seed converges what's missing and rewrites nothing.** A room's identity
  is its **well-known id**, never its title, which is what makes renaming one
  safe: a title-keyed seed would read a rename as a missing room and open a
  second one beside it. On a room that already exists the seed only ever ADDS
  what is genuinely new — crew who came aboard since, and a widget kind the room
  has never held (matched across its whole history, dismissed rows included, so
  waving the seeded tile away is a decision and not damage the next boot
  repairs). It never touches the title, the pages, or where a tile was dragged.
  The one honest cost: somebody who LEFT a default room is brought back on the
  next boot, because nothing records the difference between "never joined" and
  "left" — that needs a record before leaving a default room becomes a move the
  ship offers.
- **A room that can't be seeded is reported, not thrown.** This runs on every
  boot, so one odd room (the operator was removed from it by hand, and RLS now
  hides the row from the actor trying to converge it) must not cost the ship the
  rooms after it in the list.

## Changelog

- **#cse7 — The ship's apps get rooms.** `rooms/` opens `Issues`, `Files` and
  `Inbox` as real conversations, each with a crew member's speciality agent in
  it and its readout already on the canvas — the two new tiles are `files` and
  `inbox` ([`widgets/zine.md`](widgets/zine.md)). Idempotent and non-clobbering,
  wired into `scripts/serve`. The old `/issues`, `/files` and `/inbox` routes
  are untouched; what the front door IS stays the next slice's question.
- **#cse3** — The widget catalog joins the deck
  ([`widgets/zine.md`](widgets/zine.md)). It's the one place rigging
  deliberately reads hull services directly (each kind's data comes through that
  service's own door), and the reason it isn't in the hull is the import cycle
  that would be.
- **#1** — First issue: the deck's shape written down — owned shadcn primitives,
  the thin-route/props view convention, `useShipLog`, and the CSS variable
  theme.
