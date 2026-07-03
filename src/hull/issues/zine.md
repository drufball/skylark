# Issues

_issues zine — issue #2_

## tl;dr

Issues are the ship's message board — a forum where the crew files work and
discusses it, and where agents are launched to actually do it. An issue is a
thread with a lifecycle: `open` (a discussion) → `building` (agents are on it,
in the issue's one git worktree) → `done` (merged) or `closed` (dropped). Every
issue has an **owner** (who answers for it, defaulting to the creator), and
agents working an issue pass a **baton** between each other with `handoff` — one
agent, one turn at a time, all in the same worktree. Comments, status changes,
and handoffs ride the ship's log, so the board updates live and — crucially —
the **orchestrator** can react across processes.

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
  (`open|building|done|closed`), `authorId` (→ users.id), `ownerId` (→ users.id
  — who answers for it, the creator unless set otherwise), `visibility`
  (`public` for now — room to grow), and the build context filled in on the
  first build: `branchName`, `worktreePath`, and `statusLine` (the latest agent
  progress).
- **Issue session** — a row in `issue_sessions`: `(issueId, agentUserId)` →
  `sessionId`. Which agents have a hand on an issue, one session per (issue,
  agent), every one of them with `cwd` = the issue's ONE worktree. The builder's
  session is a row here like any other; links are kept (not deleted) on teardown
  — the session rows are the durable transcript. RLS-guarded (see Decisions): a
  link makes its session publicly visible, so inserting one requires being able
  to see that session already.
- **Comment** — a row in `issue_comments`: `id`, `issueId`, `authorId`, `body`.
  A forum reply, or an agent's note when it pauses for clarification.
- **Handoff** (`handoff.ts`) — the baton: `requestHandoff` validates a pass and
  announces `issue.handoff` on the issue's topic. A target is a crew **agent**
  (a turn is driven for it in the shared worktree) or the special word **OWNER**
  (the issue's owner is pinged through [notifications](../notifications/zine.md)
  — an inbox row for a human, an agent wake for an agent). One baton per issue:
  a pass is refused while another agent's session on the issue is mid-turn (the
  caller being mid-turn is expected — handing off is a turn's last action).
- **The state machine** — `nextStatus(from, to)` in `service.ts`: the pure,
  exhaustively-tested heart. Legal moves are `open↔building`, `building→done`,
  `open|building→closed`; `done` and `closed` are terminal; a status never
  transitions to itself. Every door (web, CLI, orchestrator) routes through it,
  so the rules live in exactly one place.
- **Events** — `issue.status_changed` on every transition, `issue.commented` on
  every comment, and `issue.handoff` on every baton pass or owner ping, each
  emitted **once** with topic `issue:<id>` and audience `public`. The thread
  view subscribes to the exact topic (`issue:<id>`); the board subscribes to the
  wildcard (`issue:*`); the orchestrator and the notifications reactor listen
  too. One topic, many subscribers — no dual-emit.
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
- **Doors** — `cli.ts` (`npm run issue`:
  `new <title> [--body <text>] [--chat <id>] [--owner <handle>]`, `list`,
  `show`, `comment`, `handoff <id> <agent|OWNER> <message>`, `status`, and the
  verb shorthands `building`/`open`/`done`/`close`) and `server.ts` (the web
  doors). The CLI attributes every action to `cliActor()`, so the orchestrator's
  `SKYLARK_ACTOR=<agent id>` command prefix makes each agent's comments,
  transitions, and handoffs show as that agent.
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

**A handoff, end to end.** The builder finishes its part and, as its turn's last
action, runs
`SKYLARK_ACTOR=<its id> npm run issue -- handoff <nano> babysitter "PR #12 open — take it home"`.
`requestHandoff` validates (target is an agent, issue is building, no other hand
mid-turn) and emits `issue.handoff`. The orchestrator hears it, ensures the
target's session exists — booted with the **target's own profile**
(users.profileId) and identity, `cwd` = the same worktree — and fires a turn
briefed with the message. The notifications reactor fans the same event to the
issue's watchers, so the crew sees the baton move.
`handoff <nano> OWNER "<message>"` skips the worktree turn entirely: the reactor
delivers straight to the owner's inbox, and if the owner is an agent the waker
wakes it in the issue's origin chat.

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
- **Build context is recorded, not derived.** `branchName`/`worktreePath` are
  columns set on first build and reused thereafter; each agent's session is a
  row in `issue_sessions`. The branch is generated **once** (the slug LLM call
  is not repeated on resume), so a resume always returns to the same branch and
  worktree.
- **One worktree per issue, one baton.** Every agent on an issue works in the
  SAME worktree — parallel worktrees per issue are a deliberate non-goal (merge
  hell for no gain on a crew-sized ship). The concurrency rule that makes that
  safe is the baton, enforced twice: `requestHandoff` refuses at the door
  (giving the agent a good error), and `applyHandoff` re-checks **inside the
  per-issue chain** — the only place check-and-act is atomic — so two passes
  that both squeaked past the door can't both fire. A baton the orchestrator
  drops (raced a close, lost the re-check) is written back onto the thread as a
  comment: the from-agent already stopped, so the message must not evaporate
  into a console log. There's a residual overlap window (the caller's turn
  finishing while the target's boots) accepted on the same grounds as
  `SKYLARK_ACTOR`'s honesty: the contract says don't touch files after handing
  off.
- **The event consumer re-validates; the emitter's checks are courtesy.**
  `applyHandoff` re-checks the target is a crew **agent** (a forged or replayed
  event must never boot a session that acts as a human) and only honors an event
  whose envelope agrees with its payload (source `issues`, audience `public`,
  topic = `issue:<payload.issueId>`). The notifications reactor applies the same
  topic-binding before letting a handoff payload adjust recipients.
- **Owner ≠ author, and OWNER rides notifications, not a turn.** `ownerId`
  defaults to the creator and exists so an agent can file work someone else
  answers for. A `handoff OWNER` never boots a worktree session — the owner
  reviews from wherever they are (inbox for a human, an agent wake in the origin
  chat for an agent; see [notifications](../notifications/zine.md)). Corollary:
  a baton pass to an agent is delivered ONLY as the orchestrator's turn — the
  reactor excludes the target from fan-out so an inbox wake can't double-drive
  it. And an owner may not ping **themself**: your own action is never your own
  news, so a self-ping would vanish silently — `requestHandoff` refuses it and
  points the agent at comment-and-pause instead.
- **A row in `issue_sessions` is a key, so it's guarded like one.** The RLS
  session-visibility rule reads "does an issue point at this session?" from
  `issue_sessions` — which makes inserting a link the power to flip a session
  crew-public. Migration 0015 puts an insert policy on the table: you may only
  link a session you can already see. Selects stay open (the board is public;
  the links carry no content).
- **Reconcile sweeps stranded turns, then resumes the builder's hand.** A crash
  leaves sessions stuck on `running`, and a stuck row would jam the baton
  forever (every handoff refused with "wait for their turn to end"). On startup,
  reconcile cancels any running issue session — a fresh process has no live
  turns, so they're all corpses — then re-seeds the builder's turn. If the baton
  was with another agent when the server died, that hand stays paused until the
  next handoff or a human nudge: fine while the builder is the entrypoint of
  every flow; revisit when playbooks make the entrypoint explicit data.
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

- **#2** — Owners and the baton: `ownerId` split from `authorId` (defaulting to
  the creator; `--owner` on `issue new`), `issue_sessions` (one session per
  issue × agent, replacing the single `issues.session_id` — the RLS visibility
  function re-pointed in migration 0014), and `handoff` (the `issue.handoff`
  event, the CLI command, orchestrator-driven baton turns in the shared
  worktree, OWNER pings via notifications). Groundwork for playbooks.
- **#1** — The message board and building agents: the `issues` +
  `issue_comments` tables, a pure state machine, `issue.status_changed` /
  `issue.commented` events, the `npm run issue` CLI, the event-driven
  orchestrator (worktree + builder lifecycle, reacting to the ship's log,
  idempotent, with a defensive self-refresh on `done` and startup
  reconciliation), the web doors, the board + thread views, and the dock
  (Chat/Issues/Agents nav, Agents a placeholder for M4). A `builder` crew member
  is seeded for builder sessions to act as.
