# Widgets

_widgets zine — issue #cse4_

## tl;dr

A widget is a live little view the crew keeps open inside a chat. The **row**
lives in the hull (`chat_widgets`, owned by chat — see
[`hull/chat/zine.md`](../../hull/chat/zine.md)): a `kind` string, an opaque
`props` blob, and nothing else. The **meaning** lives here: a catalog that maps
each kind to what it renders as, what its props mean, and which ship-log topics
keep it live — plus the two surfaces that render it, the **stack** above the
composer and the **canvas** beside the thread.

**Hull holds the row; rigging holds the meaning.** That split is structural, not
taste. The catalog has to know every service's topic grammar and how to read
each service's data, so in `src/hull/widgets/` it would import every service
that has a widget — and the day `issues` wants one you'd get
`hull/issues → hull/widgets → hull/issues`, an import cycle
`src/architecture.test.ts` fails the build over. Rigging may import every hull
service freely: that's `home → rigging → hull` working as designed.

Adding a kind is one new module plus one line in the map. Nothing in the chat
view changes, and nothing in the hull changes — the agent-facing vocabulary is
generated from the same entries.

## Components

- **Kind** (`kind.ts`) — the contract one widget kind fulfils: a `summary` and a
  `propsDoc` (prose an agent reads), an `example` blob, and a total `parse`. A
  leaf module, so the kinds and the registry never import each other.
- **Catalog** (`registry.ts`) — `WIDGET_REGISTRY`, the map from `kind` string to
  its entry, plus `resolveWidget(kind, props)`: the one dispatch point,
  **total** (never throws) and exact (`Choice` is an unknown kind, not a typo we
  guess at).
- **View** — what a parsed instance gives the stack: a `headline` (the compact
  tile's line, derived from props alone), `topics` (the ship-log patterns this
  instance needs to stay live, `[]` for a static kind), and a `Body` component.
- **Stack** (`stack.tsx`) — the shelf above the composer, for the turn-shaped
  half. Resolves every row through the catalog, renders honest tiles for the two
  failures, and owns the ONE ship-log subscription over the union of its
  widgets' topics. It knows no kind by name. A tile can be pinned down to the
  canvas page the viewer has open — the human twin of the agent's `place`.
- **Canvas** (`canvas.tsx`) — the state-shaped surface: a strip of page tabs and
  the tiles arranged on the open page. Same catalog, same one subscription, same
  two failure tiles — but a canvas tile's body is **open by default**, because
  you put it there precisely so you could read it without tapping. Two layouts
  over one arrangement (below).
- **Arrangement** — a tile's cell rectangle, which the HULL owns
  (`clampCanvasBox`, `freeCanvasBox` in `hull/chat/widgets.ts`) because both the
  door and the browser have to agree on it. This deck contributes `cellAt`
  (which cell is the pointer over, from the grid's own box) and `nudge` (where
  an arrow key sends a tile) — the two pure halves of arranging.
- **Revision** — the counter the stack bumps when an event lands on a subscribed
  topic. A live `Body` refetches when it changes; a static one ignores it. One
  `EventSource` for the whole shelf, and no polling anywhere.
- **`choice`** (`choice.tsx`) — a question with a fixed set of answers, as
  tappable buttons. Zero service coupling, no topics. Answering posts an
  ordinary chat message (the hull's door, not this file).
- **`note`** (`note.tsx`) — a small markdown card, rendered with
  `react-markdown` (already in the repo for the files view). No service, no
  topics, nothing to answer: the trivial case that proves the catalog's shape
  isn't over-fitted to interactive widgets.
- **`issue-list`** (`issue-list.tsx`) — a filtered list of issues that updates
  itself. Props are a filter (`statuses`, `issueIds`, `limit`); the issues are
  read fresh through the issues service's own `listBoard` door, and the tile
  goes live off `issue:*`.
- **Vocabulary** (`widgetKindSpecs`) — the catalog with the components and
  topics stripped off, which is exactly what the hull's `chat_widget` tool needs
  to describe a kind. Handed to the hull by `src/boot.ts`.

## Structure

**A widget, from row to pixels.** The chat route reads the stack through
`listChatWidgets` and passes the rows down as props → `ChatView` hands them
straight to `WidgetStack` → the stack calls `resolveWidget(kind, props)` per row
→ a good blob becomes a compact tile (the `headline`, clamped to two lines) that
expands into the kind's `Body`; a bad blob or an unknown kind becomes an honest
tile that says which it is and can still be dismissed.

**Two layouts, one arrangement.** On a desktop pane the page is a CSS grid of
`CANVAS_COLUMNS` columns: drag a tile by its title bar, resize it from its
bottom-right corner, or move it with the arrow keys (shift to resize) while the
title bar has focus. A pointer drag is local until you let go, so a drag across
the pane is ONE write. On a phone the exact same page is a single column in
arrangement order — the order the service's own read already returns — with no
drag targets and no resize handles at all, and you swipe or tab between pages.
The tile's one phone control (send it back to the stack) is thumb-sized; the
desktop one stays dense, because a 44px header on a 104px row is most of the
tile.

**Live updates ride the existing transport.** The stack unions its widgets'
declared `topics` and opens ONE `useShipLog` subscription over `/api/stream` —
the same SSE endpoint and the same durable log everything else uses. Each event
bumps `revision`; a `Body` that reads a service re-reads. There is no
widget-specific transport and no polling. Every event is already gated per-topic
by `canSeeTopic` (see [`hull/events`](../../hull/events/zine.md)), and a
widget's DATA comes through the owning service's own door, so a widget cannot
become a way to see something you otherwise couldn't — it has no read path of
its own.

**The vocabulary crosses the deck line downward.** `src/boot.ts` (the
composition root, the one module allowed to know both decks) calls
`registerWidgetKinds(widgetKindSpecs())` at server start. The hull's
`chat_widget` tool then generates its own description from that, and validates a
raise against each kind's own parser. So a kind is described in exactly one
place, and the hull still imports nothing from rigging.

## Decisions

- **The catalog is in rigging because it must be.** It knows service topics and
  reads service data; in the hull that's a cycle the architecture test rejects.
  The hull keeps only what's true of the ROW: the answer convention
  (`offeredAnswer`) and the answer's message body. If a future kind tempts you
  to move a parser down into the hull to "share" it, that's the cycle asking
  again.
- **A kind's parser validates against the real vocabulary of the service it
  reads.** `issue-list` checks its `statuses` against the issues service's own
  status list, so `statuses: ["blocked"]` is an honest refusal rather than an
  empty list that reads as "no work on". That check is only possible on this
  deck — it's the sharpest form of the argument above.
- **The two failure tiles are designed states, not error handling.** `bad-props`
  and `unknown-kind` are different things to fix, so they're different tiles,
  and both stay dismissible. Rows outlive the kinds that made them (later slices
  let a ship define its own), so "this ship doesn't know this kind" is a state
  the shelf will really be in.
- **A widget's contents are fetched fresh, never stored.** The row holds the
  QUESTION (which filter); the answer is read on render and lives only as long
  as the tile is on screen. There is deliberately no foreign key from a widget
  to what it shows, so a referent CAN be gone — and a kind that pins one must
  SAY so (`issue-list` names the pins nothing answers to any more) rather than
  silently showing a shorter list.
- **The stack owns the subscription; the kinds declare the topics.** One
  `EventSource` for the shelf instead of one per widget, and `revision` is
  coarse on purpose — "something changed, read it again", the same shape the
  chat route already uses with `router.invalidate()`. Routing each event to the
  widget that asked for it would be more machinery for a shelf that holds a
  handful of tiles.
- **`topics` are declared per INSTANCE, not per kind** — a kind can subscribe
  narrowly based on its props. `issue-list` nonetheless asks for the `issue:*`
  wildcard, and that's not laziness: a filter on `open` has to notice an issue
  MOVING INTO it, which a per-id subscription could never hear.
- **Mobile is a different layout, not a squeezed one.** Drag-and-resize is a
  desktop idiom: a thumb cannot place a tile in a four-column grid, and shipping
  the handles anyway is how a "responsive" canvas becomes unusable on the device
  it matters most on. So the phone gets the same page, ordered the same way, as
  one column — and the arrangement it shows is the one somebody made on a
  desktop, never a second layout to keep in step.
- **No drag-and-drop dependency.** The whole interaction is "which cell is the
  pointer over", which one `getBoundingClientRect` answers (`cellAt`) and CSS
  grid draws. A layout library would buy animation polish in exchange for a
  second layout engine to keep in step with the clamped writes the server does
  anyway — and it would have to be taught the mobile branch, which has no drag
  at all.
- **Arranging is also a keyboard move.** A drag handle alone is unusable without
  a mouse, so arrows nudge and shift+arrows resize the focused tile. It is also
  the honest way to TEST arrangement: a drag needs a laid-out box, which jsdom
  never gives.
- **A body mounts only while its tile is open.** A closed tile costs one line of
  text and asks no service anything, which is what lets the shelf stay a shelf.
- **The buttons a kind draws and the answers the hull accepts must agree.**
  `choice` renders its options verbatim from the row and never normalises them,
  because the hull's whitelist reads the same row — a parser that trimmed would
  draw a button the answer door then refused. Pinned by a test with both sides
  in scope (`choice.test.tsx`).

## Changelog

- **#cse4 — The canvas.** A second surface for the same rows: `canvas.tsx`
  renders a chat's canvas pages as an arrangeable grid on a desktop pane and as
  one swipeable column on a phone, with the tile bodies open by default. The
  stack gains a pin, so a turn-shaped widget can become a state-shaped one. No
  drag library: `cellAt` plus CSS grid, with the clamping arithmetic shared with
  the hull.
- **#cse3 — The catalog lands.** Per-kind parsing, components and topics move
  out of `hull/chat/widgets.ts` and `rigging/views/chat.tsx` into this catalog;
  the hull keeps the row's answer convention only. Two new kinds — `note` (zero
  coupling) and `issue-list` (live, reads the issues door) — and one shared
  ship-log subscription owned by the stack. The agent-facing vocabulary is
  generated from these entries and injected into the hull at `src/boot.ts`.
