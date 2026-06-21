# Issues

_issues zine — issue #1_

## tl;dr

Issues are the ship's message board — a forum where the crew files work and
discusses it, and where a **building agent** is launched to actually do it. An
issue is a thread with a lifecycle: `open` (a discussion) → `building` (an agent
is on it, in its own git worktree) → `done` (merged) or `closed` (dropped).
Comments and status changes both ride the ship's log, so the board updates live
and — crucially — the **orchestrator** can react across processes.

The orchestrator is the heart of this milestone and the thing that proves the
event bus. It runs in the web-server process, subscribes to the ship's log, and
turns `issue.status_changed` events into the worktree + builder lifecycle:
generate a branch, create a worktree, boot a builder agent session in it, seed
it with the issue, and drive it to a merged PR. It must be **event-driven**, not
called inline, because the builder reports back by running `npm run issue …`
from its own bash tool — a separate process whose transition only reaches the
server as a durable event + `pg_notify`. The same handler hears a human clicking
"Build it" in the browser and an agent typing `issue done` in a worktree.

The service is hull (load-bearing orchestration). The board and thread are
rigging views; the routes are thin mounts. The dock — a slim app-shell nav
between Chat, Issues, and a placeholder Agents slot — is rigging too.

## Components

- **Issue** — a row in `issues`: a UUIDv7 `id`, a 4-char url/git-safe `nano`
  (the short id embedded in branch names), `title`, `body`, `status`
  (`open|building|done|closed`), `authorId` (→ users.id), `visibility` (`public`
  for now — room to grow), and the build context filled in on the first build:
  `branchName`, `worktreePath`, `sessionId` (→ agent_sessions.id), and
  `statusLine` (the latest builder progress).
- **Comment** — a row in `issue_comments`: `id`, `issueId`, `authorId`, `body`.
  A forum reply, or a builder's note when it pauses for clarification.
- **The state machine** — `nextStatus(from, to)` in `service.ts`: the pure,
  exhaustively-tested heart. Legal moves are `open↔building`, `building→done`,
  `open|building→closed`; `done` and `closed` are terminal; a status never
  transitions to itself. Every door (web, CLI, orchestrator) routes through it,
  so the rules live in exactly one place.
- **Events** — `issue.status_changed` on every transition and `issue.commented`
  on every comment, each emitted **once** with topic `issue:<id>` and audience
  `public`. The thread view subscribes to the exact topic (`issue:<id>`); the
  board subscribes to the wildcard (`issue:*`); the orchestrator listens too.
  One topic, many subscribers — no dual-emit.
- **The orchestrator** (`orchestrator.ts`) — the build-lifecycle brain. Pure of
  I/O by injection: it takes a `GitOps` (worktree/git/fs), an agent runtime, and
  a slug generator as dependencies, so its decisions are unit-tested against
  fakes. `onStatusChanged` is the single decision point; `handleBusNote` is the
  ship-log subscription that feeds it; `reconcile` is startup recovery.
- **The live shell** (`orchestrator-live.ts`) — the impure wiring the
  orchestrator's decisions plug into: `nodeGitOps` (real `git worktree` +
  file-copy via `child_process`), `generateSlug` (a cheap Anthropic call that
  falls back to slugifying the title), and `ensureOrchestrator` (boots it into
  the server process, subscribes it to `shipLogBus`, runs reconciliation). All
  `v8 ignore`d — the live builder is exercised manually, not in CI.
- **Doors** — `cli.ts` (`npm run issue`: `new <title> [--body <text>]`, `list`,
  `show`, `comment`, `status`, and the verb shorthands
  `building`/`open`/`done`/`close`) and `server.ts` (the web doors). The CLI
  attributes every action to `cliActor()`, so the orchestrator's
  `SKYLARK_ACTOR=<builder id>` command prefix makes a builder's comments and
  transitions show as the builder.
- **The views** (rigging) — the **board** (issues grouped by status, author +
  comment count + the live status line for building issues), the **thread**
  (body, the merged comment/status-change timeline, a composer, status
  controls), and the **dock** (the persistent Chat/Issues/Agents nav shell).

## Structure

**A build, end to end.** A human clicks "Build it" (or an agent runs
`npm run issue building <id>`) → `transitionIssue` moves the row through
`nextStatus` and emits `issue.status_changed` once on topic `issue:<id>`
(audience `public`) → the durable row + `pg_notify` reach the server's one
LISTEN connection, which fans onto `shipLogBus` → the orchestrator's
subscription reads the full event by id and calls `onStatusChanged`. On
`→ building` it generates a slug (LLM, cheap) into `<slug>-<nano>`, creates the
worktree if absent, copies the `.worktreeinclude` files in, boots (or reuses) a
builder session with `cwd` = the worktree and `agentUserId` = the builder, and
fires a turn seeded with the issue + the ship-feature contract. The turn's live
events become the issue's `statusLine`.

**Why event-driven, not inline.** The builder runs `npm run issue done <id>`
from its bash tool — a separate CLI process. That transition is only a durable
row + a notify; the in-process call that started the build is long gone. The
orchestrator hears the agent because it subscribes to the log, the same way it
hears the browser. This is the bus earning its keep.

**Idempotent side-effects, serialized per issue.** A worktree or session may
already exist — a duplicate event, a resume from `open`, a reconcile racing a
live bus note. `ensureBuild` checks-then-acts: it generates the branch only when
`branchName` is unset, creates the worktree only when absent, and reuses the
existing session. But check-then-act is a race if two events for the same issue
run concurrently, so `onStatusChanged` is **serialized per issue id** (a
per-issue promise chain); different issues still run in parallel. The branch +
worktree are persisted the moment the worktree exists on disk — _before_ the
session is created — so a DB failure mid-build can't strand a worktree with no
branch recorded (which would re-slug and leak a second one). `teardown` removes
only what's there.

**`.worktreeinclude`.** `git worktree add` does **not** carry gitignored files,
so a fresh worktree has no `.env` and can't reach Postgres. The orchestrator
mirrors what Claude Code does: parse `.worktreeinclude` (`.gitignore` syntax —
comments and blanks dropped; currently just `.env`) and copy each listed path
from the server's checkout into the new worktree.

**Decoupling.** The service writes only its own two tables. It references other
services by id (FKs to `users.id` and `agent_sessions.id`, the one-way pattern
the events and agent schemas already use) and learns about the world through
events — it never queries those tables. The orchestrator reaches into the agent
service (to create/reuse sessions) and the users service (to resolve the builder
id) through their public functions, not their tables.

## Decisions

- **The orchestrator is event-driven, and that is the point.** It would be
  simpler to drive the lifecycle inline from the web transition. We don't,
  because an agent-initiated transition arrives from a separate process and must
  still be heard. Subscribing to the ship's log is what makes "the agent reports
  back by running the CLI" work at all. A future change that "optimizes" this
  into an inline call breaks cross-process builds silently.
- **Decisions route through one pure state machine.** `nextStatus` is the only
  place the legal transitions live. New doors call it; they don't re-encode the
  rules. A transition that isn't legal throws before any write or emit, so a
  rejected move leaves both the row and the log untouched.
- **The done-refresh is a known sharp edge, kept defensive.** On `→ done` the
  orchestrator pulls `main` into the **running server's own checkout**
  (`git pull --ff-only`) and runs migrations, so the merged work goes live (Vite
  HMR reloads on the pulled files — no explicit restart for _code_; an in-flight
  turn in a _sibling_ worktree is dropped and recovered by reconcile, not
  carried across the reload). A process updating its own code is dangerous, so
  it is deliberately defensive: ff-only, every failure logged, and **never
  thrown** — a failed self-update must not sink the server, and the merged work
  is safe in `main` regardless. **Teardown is guarded by a merge check**: the
  prompt asks the agent to set `done` only after a real merge, but a prompt
  isn't a contract, so before removing the worktree the orchestrator confirms
  the branch is an ancestor of `main` (`branchMerged`). If it can't confirm, it
  leaves the worktree standing rather than orphan an in-flight PR.
- **The builder's identity is a command prefix, not a process env.** The
  orchestrator seeds the prompt with
  `SKYLARK_ACTOR=<builder id> npm run issue …`. A command-level prefix sets the
  env for exactly that child process, so several builders running in one server
  process never race on a shared `process.env` — which a per-process env
  injection would. This is why the builder's comments attribute to the builder,
  not the operator. `SKYLARK_ACTOR` is **unauthenticated by design** — the CLI
  trusts whatever id it's handed — and is safe only because shell access to the
  host _is_ host access on a single-laptop ship; it gets a real entitlement
  check when the crew-filter primitive lands.
- **Build context is recorded, not derived.** `branchName`/`worktreePath`/
  `sessionId` are columns set on first build and reused thereafter. The branch
  is generated **once** (the slug LLM call is not repeated on resume), so a
  resume always returns to the same branch and worktree.
- **What's verified vs. deferred.** The orchestrator's decision logic — create/
  reuse/remove worktrees, start/resume/cancel sessions, idempotency, the
  defensive done-refresh, status-line writing, the bus-note handler, and startup
  reconciliation — is unit-tested against fake git/runtime/slug
  (`orchestrator.test.ts`). The **live end-to-end builder** (a real LLM building
  real code in a real worktree to a real merged PR) is exercised **manually**,
  not in CI, because it needs a network, an API key, and a writable git remote.
  The cross-process event reaction _is_ verified manually too (a CLI transition
  in one process waking the orchestrator in the dev server). Startup
  reconciliation resumes building issues with a dead in-process session; it does
  **not** try to detect a session that died mid-turn in _this_ process (the
  runtime already drops a failed session and a fresh turn rebuilds it).
- **A `builder` crew member, single-tenant for now.** Builder sessions act as
  the seeded `builder` agent user. No crew column on the issues tables yet — the
  ship is single-tenant until the crew-filter primitive lands (see
  [`../zine.md`](../zine.md)); `visibility` is the seam it will attach to.

## Changelog

- **#1** — The message board and building agents: the `issues` +
  `issue_comments` tables, a pure state machine, `issue.status_changed` /
  `issue.commented` events, the `npm run issue` CLI, the event-driven
  orchestrator (worktree + builder lifecycle, reacting to the ship's log,
  idempotent, with a defensive self-refresh on `done` and startup
  reconciliation), the web doors, the board + thread views, and the dock
  (Chat/Issues/Agents nav, Agents a placeholder for M4). A `builder` crew member
  is seeded for builder sessions to act as.
