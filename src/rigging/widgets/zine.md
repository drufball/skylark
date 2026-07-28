# Widgets

_widgets zine — issue #cse9_

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
  canvas page the viewer has open — the human twin of the agent's `place`. On a
  phone the shelf shows only on the thread surface (see the chat zine); the
  Thread toggle carries its count while you're on the canvas.
- **Answer guard** (`answer-guard.ts`) — `useAnswerGuard`, the "this one is
  already spent" state both surfaces hold. The host's `busy` flag drops when the
  write returns, but the answered tile is on screen until the refetch lands — a
  window a thumb double-taps straight through. Shared rather than copied,
  because the two surfaces answer the SAME rows through the same door.
- **Canvas** (`canvas.tsx`) — the state-shaped surface: the tiles a chat
  arranged on the open page. Same catalog, same one subscription, same two
  failure tiles — but a canvas tile's body is **open by default**, because you
  put it there precisely so you could read it without tapping. An **answered**
  choice stays here and shows what was decided, because on a spatial surface an
  answered question is state (the rule is the hull's `answerDismisses`; this
  deck only draws it).
- **Grid** (`grid.tsx`) — the layout engine BOTH canvases share: the page strip,
  the desktop `ArrangeableGrid` (drag by the title bar, resize from the corner,
  arrows to nudge), the phone's `SwipeColumn`, and `TileFrame` (a tile's
  chrome). Plus the two pure halves of arranging, `cellAt` and `nudge`, and the
  tile's height contract — `phoneTileCapPx` and `isOverflowing` (see the
  decision below). It knows nothing of widget kinds, chats or pointers — that's
  what makes it shareable.
- **Home canvas** (`home-canvas.tsx`) — your own screen and, since #cse8, the
  ship's front door (`/`). The one surface that holds POINTERS at widgets living
  in chats ([`hull/home-canvas/zine.md`](../../hull/home-canvas/zine.md)). Same
  grid, same catalog; what differs is that a tile draws a `HomeTileTarget` the
  SERVER resolved, so this component never decides access. Three states a chat
  tile never has: a chat pointer with nothing raised (an honest resting state),
  a widget pointer showing its recorded decision, and `lost`. Its empty states
  carry more weight than anything else on this deck — they are the first screen
  a crew member ever sees.
- **Arrangement** — a tile's cell rectangle, which the HULL owns
  (`clampCanvasBox`, `freeCanvasBox` in `hull/chat/widgets.ts`) because both the
  door and the browser have to agree on it. This deck contributes `cellAt`
  (which cell is the pointer over, from the grid's own box) and `nudge` (where
  an arrow key sends a tile) — the two pure halves of arranging, now in
  `grid.tsx` where both canvases reach them.
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
- **`files`** (`files.tsx`) — the crew's shared documents, **read-only**. Props
  pick what you're looking at (`path` pins one document, `folder` browses one,
  `limit` caps the list); names come from `listFiles`, contents from `readFile`,
  and the tile goes live off `file:<path>` for a pinned document or `file:*` for
  a list. It draws no control that writes, and that's a security boundary — see
  the decision below.
- **`inbox`** (`inbox.tsx`) — the VIEWER's own notifications. Props say how much
  (`unreadOnly`, `limit`) and can never say whose; the read is `myInbox`, which
  resolves the actor server-side, and the tile goes live off `notify:*`. The
  first per-viewer kind: one row on a shared canvas shows each member their own
  inbox (see the decision below).
- **Default rooms** (`../rooms/`) — the conversations a fresh ship boots with,
  and the widgets arranged in them. Also on this deck, and for the same reason
  the catalog is: a room names widget KINDS, which is meaning, not rows. See
  [`rigging/zine.md`](../zine.md).
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

**Two canvases, one engine.** A chat canvas contains its widgets; a home canvas
holds pointers at widgets living in chats. They differ entirely in what a tile
MEANS and not at all in how a page behaves — so `grid.tsx` owns the page
behaviour and each surface brings its own tile. The alternative was a second
layout engine "kept in step", which is two engines drifting.

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

- **A tile is named after its headline, never its row id.** Every control's
  `aria-label` used to read out a primary key — "Dismiss widget 019fa5b1-f0f1-…"
  — which is a database column escaping into the UI, and the only thing a screen
  reader user would hear about the tile. `TileFrame` and the stack both build
  their labels from the resolved headline, falling back to the kind when the
  blob doesn't parse (the honest tiles have no headline to use).
- **The home tile draws access, it never decides it.** `HomeTileTarget` arrives
  already resolved from the viewer's current chat membership, and `lost` carries
  no chat name, no question, no id. A component that filtered would be a second
  opinion about visibility, in the one place an attacker actually controls.
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
- **`files` is READ-ONLY, and that is a security boundary rather than a scope
  decision.** The files service auto-merges every write to `main` with **no PR**
  on purpose — "these are documents, not code" — its path rule restricts
  traversal but **not file extensions**, and a merge **auto-deploys the serving
  checkout**. Chain those and a widget that could write an arbitrary path is a
  path from a chat message — something an agent, or anyone talking to one, can
  produce — to unreviewed executable code running in a ship that is publicly
  exposed through a Cloudflare Tunnel. So the kind imports exactly two doors
  (`listFiles`, `readFile`) and draws nothing that writes; editing a document
  stays on the Files surface, where a human is doing it deliberately. A future
  slice that wants an editable tile has to answer this paragraph first, not
  quietly add a save button. The pinned `path` is validated at PARSE time with
  the files service's OWN rule (`isValidFilePath`, the node-free leaf
  `hull/files/path.ts`), imported rather than re-spelled — a second copy of a
  path policy is two policies that agree until they don't, and this is the one
  where "don't" means a path the service would have refused.
- **A tile that reads a person's data is per-VIEWER, and the row must not be
  able to name the person.** `inbox` is the first, and the shape is the one
  `chat_view_state` set (#cse4): the DATA comes from a door that resolves
  `currentActor()` and runs under RLS, so there is no door that takes a user id
  at all; the props are refused **loudly** if they carry one (`userId`,
  `handle`, …), because silently dropping the key would leave the agent that
  wrote it believing it had aimed the tile at somebody. The tile also says whose
  inbox it is out loud, so a member can SEE it's theirs. The live half asks for
  the `notify:*` wildcard — the props can't name the viewer, so the instance
  can't name a topic — and that leaks nothing by construction: the stream gates
  every event through `canSeeTopic`, and `notify:<userId>` admits exactly that
  user. Pinned by both a unit test (one parsed row, two viewers) and the browser
  pass (two logged-in members, one row, neither sees the other's).
- **A capped list says how much it is hiding.** A `files` tile headlined "Files
  · all" showing the first eight of eighteen documents is the same dishonesty as
  an `issue-list` quietly dropping a pin — you cannot tell a small shelf from a
  capped one. Same rule as "a kind that pins a referent must SAY when it's
  gone".
- **The FRAME caps a tile's height, no kind does — and a capped tile says so.**
  A tile is a fixed box and its contents are not. The desktop grid cell bounded
  a tile; the phone column bounded nothing, so a `files` tile holding eighteen
  documents just grew, and the kinds had each grown an inner `max-h` to
  compensate — which is how one tile ended up with three nested scrolls on a
  device with one thumb. `TileFrame` owns the cap and owns the ONE scroll; the
  phone borrows the tile's ARRANGED height (`phoneTileCapPx`, floored at two
  rows so a squashed tile is still answerable), because that's the same claim
  the desktop grid already makes about how much room the tile should take. And
  when the body is hiding something the tile says "more below", measured rather
  than assumed — the same honesty the `files` list owes its item count, owed for
  the tile's own height.
- **Inside a tile, the label goes over the timestamp, not beside it.** Observed
  live at 390px: `YYYY-MM-DD HH:MM` held a third of an inbox row and cut "@mate
  commented on #a1b2" down to "@mate c…". A tile is far narrower than the
  surface it mirrors, so a row that reads fine on `/inbox` doesn't transplant —
  the thing that IS the notification takes the width, and the secondary fact
  goes underneath. Same call the stack's headline made in #cse5, and the same
  one `files` makes for a document's own name.
- **The buttons a kind draws and the answers the hull accepts must agree.**
  `choice` renders its options verbatim from the row and never normalises them,
  because the hull's whitelist reads the same row — a parser that trimmed would
  draw a button the answer door then refused. Pinned by a test with both sides
  in scope (`choice.test.tsx`).

## Changelog

- **#cse9 — A tile is a fixed box, and now its contents know it.** `TileFrame`
  caps the body, owns the only scroll inside a tile, and says "more below" when
  it's hiding something; the phone column takes the height the arrangement asked
  for instead of growing without limit, and `files` drops the inner `max-h` it
  had grown to compensate. A home tile's "which chat is this?" line moves out of
  the scrolling half into the frame's footer slot. `TAP_TARGET` left `kind.ts`
  for `rigging/lib/tap-target` — it was never a widget fact, and the composer
  and the sidebar were importing a widget module to spell a design token.
- **#cse8 — The home canvas becomes the front door.** No new kinds. The empty
  home says what the surface is for and, for somebody with no conversations yet,
  points at where conversations are made rather than at a picker that would be
  empty; a home with no pages no longer draws a page strip holding one lonely
  `+` above an empty state that already offers the same move. The seeded home
  pins each default room's READOUT rather than the room, because a chat pointer
  shows the top of a chat's STACK and a room's tile lives on its canvas — three
  chat pointers would have been three tiles saying "nothing raised right now".
- **#cse7 — Two apps get rooms.** Two kinds join the catalog: `files`, a
  read-only window onto the crew's shared documents (browse a folder, tap
  through to a document, or pin one open), and `inbox`, the first PER-VIEWER
  kind — one row, and each member of a chat sees their own notifications. Both
  declare their own topics, so both go live over the existing SSE with no new
  transport. The default rooms that hold them live beside this catalog in
  [`rigging/rooms/`](../rooms). Two things the phone pass found and fixed: a
  capped `files` list now says how many documents it isn't showing, and an inbox
  row puts the label over the timestamp instead of beside it.
- **#cse6 — Two canvases, one engine.** The page strip, the desktop grid, the
  phone column and the tile chrome move out of `canvas.tsx` into `grid.tsx`, and
  `home-canvas.tsx` — your personal screen of POINTERS at widgets living in
  chats — is built on them. A kind's `Body` gains `answer`, the decision
  recorded on the row, so `choice` shows what was chosen instead of re-offering
  a settled question on a surface that keeps it. Every tile control is now named
  after its headline rather than its row id.
- **#cse5 — One product on a phone.** The double-tap guard the stack has always
  held moves into `answer-guard.ts` and the canvas gains it: answering from the
  canvas was firing twice through the window between the write returning and the
  refetch landing, which came back as an uncaught "already answered". A tile
  takes `spent` rather than `busy`, so the two surfaces are guarded by the same
  state for the same reason. The phone's canvas surface no longer shares the
  screen with the shelf — see the chat zine for why that belongs to the thread.
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
