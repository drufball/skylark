# The home canvas

_home-canvas zine — issue #cse6_

## tl;dr

Your **home canvas** is a personal screen of **pointers**. Widget instances
always live in exactly one chat (`chat_widgets`, owned by the chat service —
[`hull/chat/zine.md`](../chat/zine.md)); a home tile is a _placement_ pointing
at one. That's the iOS model: an app has one canonical home, and your home
screen holds live views onto apps that live somewhere else. **Indirection exists
in exactly one place — here — instead of everywhere**, which is what lets a chat
canvas keep containing its widgets directly.

A tile points at either **one specific widget** (stable: always that widget) or
**a chat** (live: whatever is at the top of that chat's stack right now). The
second mode is the point of the whole product: an agent raises a question in a
conversation you're in, it appears on your home screen, and you answer it with a
thumb without ever opening the chat — and the answer posts into that chat as an
ordinary message, through chat's own door, exactly as answering from the stack
or the canvas does.

**A pointer is not a grant.** Whether a tile renders is decided server-side at
READ time, from your CURRENT chat membership — never from what was true when you
pinned it, and never in the browser. Lose membership and the content stops dead,
including on the live event path.

## Components

- **Home page** — a row in `home_canvas_pages`: one page of one person's home,
  with a title and a place in the strip. `ownerId` is `not null`; there is
  deliberately no shared or nullable-owner variant, so there is no orphan state
  to reason about.
- **Home tile** — a row in `home_canvas_tiles`: a pointer plus a cell rectangle.
  Exactly one of `widgetId` or `chatId` is set (a `check` constraint, not just a
  door rule). Both FK **cascade**, so a deleted chat — or a deleted chat's
  widget — takes its pointers with it. A pointer can never dangle, which is what
  keeps "you no longer have access" meaning exactly that and not "the thing is
  gone".
- **`ownerId` on both tables** — repeated on the tile rather than reached
  through its page, so the RLS policy (migration 0036) is a single-table
  predicate: `owner_id = current_setting('app.actor')`. No membership wrapper,
  no join, no SECURITY DEFINER helper. Home is personal; that's the whole rule.
- **The resolve** (`readHomeCanvas`) — three RLS-filtered reads whatever the
  tile count: your chats (`listChatSummaries`), your pinned widgets
  (`listWidgetsByIds`), and the open stacks of your pinned chats
  (`listOpenWidgetsForChats`). Every one is a call into the CHAT service on your
  own connection, so chat's policies are what answer "may this person see it?".
  A target that doesn't come back is `lost`.
- **`HomeTileTarget`** — what a tile resolved to: `widget` (that exact one),
  `chat` (the chat plus the top of its stack, or `null` if nothing is raised),
  or `lost`. `lost` carries **nothing** — no chat name, no question, no id.
- **`topics`** — the ship-log topics the live half subscribes to, one per chat
  the read could actually resolve, deduped, computed on the server. A `lost`
  tile contributes none.
- **Doors** (`server.ts`) — read (`getHomeCanvas`), page CRUD,
  `pinHomeCanvasTile` / `moveHomeCanvasTile` / `unpinHomeCanvasTile`. Every one
  runs under `withCurrentActor`; **none of them takes an `ownerId`**, and the
  policy wouldn't accept one if it did. Notably absent: an answer door — see
  below.
- **The view** — `rigging/widgets/home-canvas.tsx`, on the page primitives
  shared with the chat canvas (`rigging/widgets/grid.tsx`). See
  [`rigging/widgets/zine.md`](../../rigging/widgets/zine.md).

## Structure

**A tile, end to end.** You pin a conversation from home's picker (or a widget
from its chat-canvas tile's home button) → the door checks you can currently SEE
the target, by reading it through chat under your actor, and writes a tile row
on your first page (making you one if this is your first pin) → `getHomeCanvas`
resolves every pointer on the next read → the view draws a tile per resolution,
never deciding access itself.

**Answering from home is chat's door, not home's.** The route calls
`answerChatWidget` — literally the server fn the stack and the canvas call.
There is no home answer path, because a second path is a second place for the
answer rules (the offer whitelist, the double-submit guard, the ordinary-message
write) to drift. Home is a lens, and a lens must not grow its own writes.

**Live.** Home rides the existing SSE ship-log: the route subscribes to the
`topics` the server handed back and invalidates on any event. It re-RESOLVES
rather than patching, because "what does this tile show?" is a membership
question and membership is only answered on the server. No new transport, no
polling.

**The subscription set.** A home may point into many chats, so the set is worth
watching: it's deduped server-side and rides ONE `EventSource`, the same one the
chat route opens for a single chat (measured live: seven pinned chats → one
connection, a 359-character `?topics=` query). The honest limit is that nothing
caps it — a home pointing at a few hundred conversations would push the query
toward URL limits and make every raise anywhere invalidate the whole route.
Neither is a problem at crew scale; if it becomes one, the fix is to page the
subscription to the tiles on the OPEN page rather than the whole canvas.

**Which page you're looking at is the URL** (`/home?page=…`), not a table. The
chat canvas needed a per-viewer row (`chat_view_state`) because a page is shared
and three members can be on three different pages. Home has exactly one viewer,
so the URL is the honest home for it — and it hands us browser back/forward for
free, which is precisely what makes tapping through to a chat and coming back
land you where you were.

## Decisions

- **Home holds pointers; nothing else does.** A chat canvas contains its widgets
  directly. Making every surface indirect would mean every surface reasoning
  about a referent that might be gone; making exactly one surface indirect
  confines that reasoning to this file and the view beside it. The rule to hold:
  a widget instance always lives in exactly one chat, and only home points.
- **A pointer is not a grant, and the READ is where that's enforced.** Not a
  door check, not a filter in the browser: the resolve asks the chat service on
  the viewer's own RLS connection, so a widget in a chat they've left simply
  isn't returned. Removing somebody from a chat needs no home-side cleanup at
  all — nothing to sweep, nothing to invalidate, and no window where a stale
  grant is still good. Pinned tiles keep working for the members who remain.
- **The live path is closed the same way the read is.** `topics` comes from the
  server, derived from the chats the read RESOLVED — so a `lost` tile never puts
  its chat's topic in the subscription set. (`canSeeTopic` would refuse it
  anyway; it defers to the same chat policy. Two locks, because "the browser
  asked for a topic it shouldn't have" is a bug class worth making impossible to
  reach rather than merely unsuccessful.)
- **A lost pointer shows an honest placeholder — and that is safe HERE only.**
  Because home is **personal**, you are the only viewer of your own home, so
  there is no third party to leak the existence of a conversation to. Against
  that, a tile silently vanishing out of an arrangement you made is a worse
  experience: you'd never know whether you'd lost access or lost the tile. So
  the placeholder says "you no longer have access to this" and names nothing at
  all. **The same placeholder on a shared surface would not be safe**, and if
  home ever gains a second viewer this decision has to be reopened before
  anything else is.
- **The home canvas is its own hull service, and it FKs into chat.** Its tables
  are load-bearing personal state under RLS, so hull. Its tiles reference
  `chats.id` and `chat_widgets.id` so the cascade — not a sweep — is what keeps
  a pointer from dangling; that's the fifth entry in
  `src/architecture.test.ts`'s `SCHEMA_FK_ALLOWLIST` (`home-canvas -> chat`) and
  the diff on it was the design review. It reads chat's DATA only by calling
  chat's exported functions, so "may this person see it?" keeps one home.
- **Nothing here raises, places, or writes a widget.** The chat zine's rule
  stands untouched: only an actor with judgment puts a widget in front of a
  person, and only chat owns `chat_widgets`. Home writes tiles. If a future
  temptation appears to "just create the widget from home", it's the same
  re-tangling the ban exists to prevent.
- **The grid arithmetic is chat's `widgets.ts`, imported rather than copied.**
  `clampCanvasBox` / `freeCanvasBox` / `nextCanvasSlot` are pure, node-free and
  already shared between chat's door and the browser; a second copy for home
  would be two layout engines that agree until they don't.
- **A pin with no page named lands on your first page, creating one if needed.**
  "Pin this to my home" is a move you make from a chat, where you have no page
  in mind. Asking you to go and make a page first would make the affordance
  useless exactly when it's most wanted.
- **A page holding tiles can't be removed.** Same rule the chat canvas keeps:
  tidying your tabs must never be the thing that destroys an arrangement.
- **Home is its own route and dock entry; `/` is unchanged.** What the front
  door IS remains a question for the next slice, and answering it here would
  tangle two things. Home sits after Chat in the dock for the same reason.

## Changelog

- **#cse6 — The home canvas.** `home_canvas_pages` + `home_canvas_tiles`
  (migration 0035, RLS 0036), the two pointer modes, `readHomeCanvas` resolving
  against current membership, `/home` and its dock entry. Answering from home
  goes through chat's own `answerChatWidget`; the page primitives are shared
  with the chat canvas (`rigging/widgets/grid.tsx`).
