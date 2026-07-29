# The Rigging

_rigging zine — issue #cse9_

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
  inbox, agents, models, the rail). A view is a plain component: no routing, no
  data fetching of its own.
- **The rail** (`views/dock.tsx`) — the ship's permanent navigation: **Home**
  (`/`, your canvas), **Chats** (`/chat`), **Crew** (`/agents`), **Models**, and
  a way out. Four hardcoded entries, on every surface, reading no row — see the
  decision below. A bar across the bottom on a phone and a slim column at the
  side from `md` up, in CSS rather than a measured breakpoint, because the rail
  has to be right on the first paint.
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
  @dot), `Inbox` (an `inbox` tile, @bix). Issues and Files also name the **view
  they are the room for** (`/issues`, `/files`) and link through to it from
  their own header — those two surfaces left the rail, and the room is the way
  in now. Each of those views carries the way BACK, too (`roomForView`, drawn by
  the shell above the surface). Inbox names no `view` (`view` is optional on a
  `RoomSpec`) — `/inbox` is a permanent rail entry (#933f), not a surface this
  room owns; it's an ordinary conversation carrying a filtered `inbox` tile,
  same as any chat could. `rooms.ts` is the specs as data, `seed.ts` the
  idempotent write (rooms, then homes), `cli.ts` the door —
  `npm run rooms seed`, which `scripts/serve` runs on every boot right after
  `npm run users seed` — and `server.ts` the one web door, `welcomeAboard`,
  which the signup route calls so a crew member who joins between restarts
  doesn't wait for one.

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

**A home, from nothing to arranged.** Then `seedHomes` runs, once per human,
each pass under THAT person's own actor — a home canvas is gated by
`owner_id = the acting actor` and there is no door anywhere that takes an
`ownerId`, so the operator cannot write somebody else's home and this doesn't
try. It touches a home only if the ship has **never considered it before**
(`home_canvas_seeds`) and it has **no pages and no tiles**, and pins the room's
canvas READOUT rather than the room itself: a chat pointer shows the top of a
chat's stack, and a room's tile lives on its canvas, so three chat pointers
would give a new crew member three tiles saying "nothing raised right now". A
widget pointer puts the open issues, the documents and the inbox on the home
screen on the very first load, and the tile still names its room and links into
it.

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
- **The rail is five entries and it is hardcoded.** It's the ship's only
  navigation that isn't data. Everything else — your chats, your pages, your
  tiles — is rows the crew can delete, and without a fixed floor somebody can
  arrange their way into a corner with no path back to a surface they need. So
  the rail reads nothing, renders identically on an empty home, and is
  deliberately short: it holds the two things every ship needs (your screen,
  your conversations) plus the three surfaces that AREN'T conversations — Crew,
  Models, and Inbox (badged live with the unread count, #933f).
  `src/navigation.test.ts` is the enforcement — every route is reachable from
  the rail or from a default room, or it's named there as not being a
  destination.
- **A room keeps the view it replaced, and the link goes BOTH ways.** `/issues`,
  `/files` and `/inbox` did not go away when the rooms arrived: a tile is a
  readout — eight issues, a folder, the last few notifications — and the board
  does things a tile doesn't. Deleting a good working view in the same slice
  that moved the front door would be two irreversible things at once. So the
  view stays a route and the room carries the link. **Models stays in the
  rail**, and that's the same argument from the other side: a settings surface
  is not a conversation, and the thesis is proven by what migrates well rather
  than by mandating that everything migrate. The way BACK (`roomForView`) is
  drawn by the SHELL rather than by each view: it is the way OUT of a surface,
  so it has to be somewhere always on screen, identical everywhere, and
  impossible for a view to forget — and `/files` settles that on its own, since
  its header sits inside a sidebar that's a closed drawer on a phone.
- **The home seed arranges a home ONCE, and a row remembers that.** Two
  conditions, and the first is what makes the second safe: the ship has never
  considered this home (`home_canvas_seeds`, written whether or not a tile
  lands), and the home has zero pages and zero tiles. That's a stricter promise
  than the room seed makes — a room converges what's new forever — and
  deliberately so: unpinning a tile is an ordinary move somebody makes with a
  thumb, and a seed that undid it on the next boot would be the ship arguing
  with its crew. Emptiness alone couldn't carry that promise, because it cannot
  tell _untouched_ from _I removed everything_, so a deliberate clear-out used
  to come straight back on the next boot. See
  [`hull/home-canvas/zine.md`](../hull/home-canvas/zine.md) for the row itself.
- **A newcomer is welcomed by a door, not by waiting for a reboot.** The boot
  seed converges the crew already aboard; somebody who signs up at four in the
  afternoon would otherwise land on a blank grid until the next restart, and
  that grid is now the first and only thing they'd see. `welcomeAboard` runs the
  same idempotent seed at the one moment it matters. It runs the ROOM pass as
  the ship's operator, because a newcomer cannot add themselves to a chat they
  aren't in (membership is visibility, and RLS refuses), and only then the home
  pass as the newcomer. That escalation is narrow and named out loud in the
  file: a logged-in crew member can cause the ship to perform its own boot seed,
  with a fixed room list and no input of their own.
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

- **#933f — Inbox rejoins the rail.** A fifth, permanent rail entry (`/inbox`),
  badged everywhere with the live unread count (`use-unread-count.ts`), not just
  on the inbox route. `rooms.ts`'s room-inbox drops its `view` link — the room
  is still the same conversation with @bix, carrying the same filtered `inbox`
  tile, it just no longer owns the route.
- **#cse9 — The closing pass: durability, and a phone header that can't grow.**
  The three views that left the rail stop being one-way doors — `roomForView` is
  the way back, drawn by the shell above every one of them, and
  `navigation.test.ts` holds the round trip rather than half of it. The home
  seed gains a durable marker, so a deliberate clear-out sticks (see
  [`hull/home-canvas/zine.md`](../hull/home-canvas/zine.md)). The chat header
  folds to ONE row at 390px — the name, the surface toggle with its waiting
  count, and a single overflow holding the room link, Schedules and the roster —
  so the next control somebody adds can't wrap it again. And the last sub-44px
  tap targets on a phone go: the inbox's rows and its Mark-all-read, the board's
  New issue, and the roster's own controls, where the overflow has room for
  them.
- **#cse8 — The front door moves, and a rail replaces the dock.** The dock's
  seven entries become four permanent ones (Home, Chats, Crew, Models), a bottom
  bar on a phone; Issues, Files and Inbox leave for their rooms, and each room
  now names and links to the view it replaced. (Inbox later rejoins the rail as
  a fifth entry — #933f, above.) `seedHomes` joins the seed, so a crew member's
  home opens with the three rooms' readouts already on it, and `welcomeAboard`
  runs the whole thing for somebody who signs up between boots. The chat
  header's Open-Chats, People, Schedules and Send controls finally reach the
  44px floor the widget surfaces have used since #cse4.
- **#cse7 — The ship's apps get rooms.** `rooms/` opens `Issues`, `Files` and
  `Inbox` as real conversations, each with a crew member's speciality agent in
  it and its readout already on the canvas — the two new tiles are `files` and
  `inbox` ([`widgets/zine.md`](widgets/zine.md)). Idempotent and non-clobbering,
  wired into `scripts/serve`. The old `/issues`, `/files` and `/inbox` routes
  are untouched; what the front door IS stays the next slice's question (#cse8
  answered it).
- **#cse3** — The widget catalog joins the deck
  ([`widgets/zine.md`](widgets/zine.md)). It's the one place rigging
  deliberately reads hull services directly (each kind's data comes through that
  service's own door), and the reason it isn't in the hull is the import cycle
  that would be.
- **#1** — First issue: the deck's shape written down — owned shadcn primitives,
  the thin-route/props view convention, `useShipLog`, and the CSS variable
  theme.
