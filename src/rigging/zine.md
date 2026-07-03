# The Rigging

_rigging zine — issue #1_

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

## Changelog

- **#1** — First issue: the deck's shape written down — owned shadcn primitives,
  the thin-route/props view convention, `useShipLog`, and the CSS variable
  theme.
