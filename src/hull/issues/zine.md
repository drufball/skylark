# Issues

_issues zine — issue #4_

## tl;dr

Issues are the ship's message board — a forum where the crew files work and
discusses it, and where agents are launched to actually do it. An issue is a
thread with a lifecycle: `open` (a discussion) → `building` (agents are on it,
in the issue's one git worktree) → `done` (merged) or `closed` (dropped). Every
issue has an **owner** (who answers for it, defaulting to the creator) and a
**playbook** (how it gets worked: a roster of agents and the entrypoint that
starts — `build` implements to a merged PR, `general` is one agent doing what
the issue says). Agents on an issue pass a **baton** between each other with
`handoff` — one agent, one turn at a time, all in the same worktree. Comments,
status changes, and handoffs ride the ship's log, so the board updates live and
— crucially — the **orchestrator** can react across processes.

The orchestrator is what proves the event bus. It runs in the web-server
process, subscribes to the ship's log, and turns `issue.status_changed` events
into the worktree + builder lifecycle: generate a branch, create a worktree,
boot a builder agent session in it, seed it with the issue, and drive it to a
merged PR. It must be **event-driven**, not called inline, because the builder
reports back by running `npm run issue …` from its own bash tool — a separate
process whose transition only reaches the server as a durable event +
`pg_notify`. The same handler hears a human clicking "Build it" in the browser
and an agent typing `issue done` in a worktree.

The service is hull (load-bearing orchestration). The board and thread are
rigging views; the routes are thin mounts, framed by the dock (the rigging's
app-shell nav).

## Components

- **Issue** — a row in `issues`: a UUIDv7 `id`, a 4-char url/git-safe `nano`
  (the short id embedded in branch names), `title`, `body`, `status`
  (`open|building|done|closed`), `authorId` (→ users.id), `ownerId` (→ users.id
  — who answers for it, the creator unless set otherwise), `playbookId` (→
  playbooks.id; null = the `build` default), `visibility` (`public` for now —
  room to grow), `batonHolderId` (→ users.id, nullable — whose turn it is right
  now; see **The baton**), and the build context filled in on the first build:
  `branchName`, `worktreePath`, and `statusLine` (the latest agent progress).
  Issues carry no notion of where they were filed from — an agent that wants to
  report back on one finds the right conversation itself (see
  [chat](../chat/zine.md)).
- **Playbook** (`playbooks.ts`) — a row in `playbooks`: `name` (unique — the
  upsert key and what `--playbook` accepts), `description`, `memberIds` (agent
  users allowed hands on the issue), `entrypointId` (who a → building seeds),
  and `memberInstructions` (optional per-member brief for THIS strategy, keyed
  by user id — `instructionsFor` looks one up; folded into the entrypoint's seed
  prompt and a baton-pass prompt via `roleBlock` in `prompts.ts` when present,
  distinct from the agent's own systemPrompt, which is identity, not strategy).
  Deliberately NOT a state machine: the routing knowledge (who hands to whom,
  when) lives in the agents' own config and prompts; the playbook is the
  guardrail (membership) and the starting gun (entrypoint). Two are seeded —
  `build` (the **builder** implements to an open PR, then batons to the
  **babysitter**, who waits on CI via the `background` tool and merges — or
  hands a fix brief back) and `general` (the `hand` crew agent, full tools, the
  issue's own words as the brief) — and the crew can add more from the Agents →
  Playbooks tab.
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
  announces one of two event types, depending on the target. A target is a crew
  **agent** — `issue.handoff` drives a turn for it in the shared worktree — or
  the special word **OWNER** — `issue.owner_ping` pings the issue's owner
  through [notifications](../notifications/zine.md) (an inbox row for a human,
  an agent wake for an agent) with no worktree turn. One baton per issue: a pass
  is refused while another agent's session on the issue is mid-turn (the caller
  being mid-turn is expected — handing off is a turn's last action). On a
  validated pass `requestHandoff` also moves `batonHolderId` (to the target
  agent, or the OWNER on an owner-ping) on the same write that emits the event —
  see **The baton**.
- **The baton** (`batonHolderId` + `setBatonHolder`) — whose turn it is, as an
  explicit column rather than something re-derived from running-hands checks and
  handoff events. It moves at exactly the points the baton actually moves,
  riding the SAME write that emits each event: to the playbook entrypoint agent
  on → building (the orchestrator, which alone resolves the entrypoint), to the
  target agent on an `issue.handoff` and to the issue OWNER on an
  `issue.owner_ping` (`requestHandoff`), and cleared to null on → done / →
  closed (inline in `transitionIssue`, so a terminal move can't miss it).
  `assertTransition` stays the single state authority — the column only records
  who holds the baton after a move, never decides legality. The load-bearing
  distinction downstream is **human vs agent**: a HUMAN holder is the universal
  "waiting for input" signal the night watch (#q9d9) reads to decide whether to
  nudge; an agent holder means work is (or should be) in flight. The board card
  and thread view surface it (handle + human/agent) via a single users join in
  the door, shown as a modest `BatonChip` ("waiting on @dru" vs "@builder").
- **The state machine** — `assertTransition(from, to)` in `service.ts`: the
  pure, exhaustively-tested heart. Legal moves are `open↔building`,
  `building→done`, `open|building→closed`; `done` and `closed` are terminal; a
  status never transitions to itself. Every door (web, CLI, orchestrator) routes
  through it, so the rules live in exactly one place.
- **Events** — `issue.opened` on creation (its `ownerId` payload is how the
  notifications reactor auto-watches the owner), `issue.status_changed` on every
  transition, `issue.commented` on every comment, and `issue.handoff` (baton
  pass) or `issue.owner_ping` (owner escalation) on every handoff, each emitted
  **once** with topic `issue:<id>` and audience `public`. The thread view
  subscribes to the exact topic (`issue:<id>`); the board subscribes to the
  wildcard (`issue:*`); the orchestrator and the notifications reactor listen
  too. One topic, many subscribers — no dual-emit.
- **The orchestrator** (`orchestrator.ts`) — the build-lifecycle brain. Pure of
  I/O by injection: it takes a `GitOps` (worktree/git/fs), an agent runtime, and
  a slug generator as dependencies, so its decisions are unit-tested against
  fakes. `onStatusChanged` is the single decision point; `handleBusNote` is the
  ship-log subscription that feeds it; `reconcile` is startup recovery.
  `driveTurn(issueId, sessionId, text)` is a narrow seam — its private
  `fireTurn` exposed by name — so the night watch (hull/watch) can nudge a
  stalled build or health-check a long wait through THIS orchestrator's own
  runtime, never a fresh one (see hull/watch/zine.md's ownership note).
- **The live shell** (`orchestrator-live.ts`) — the impure wiring the
  orchestrator's decisions plug into: `nodeGitOps` (real `git worktree` +
  file-copy via `child_process`), `generateSlug` (a cheap Anthropic call that
  falls back to slugifying the title), and `ensureOrchestrator` (boots it into
  the server process, subscribes it to `shipLogBus`, runs reconciliation). All
  `v8 ignore`d — the live builder is exercised manually, not in CI.
- **Doors** — `cli.ts` (`npm run issue`:
  `new <title> [--body <text>] [--owner <handle>] [--playbook <name>]`, `list`,
  `show`, `comment`, `handoff <id> <agent|OWNER> <message>`, `playbooks`,
  `status`, and the verb shorthands `building`/`open`/`done`/`close`) and
  `server.ts` (the web doors, including `listPlaybooksView`/`savePlaybook` for
  the editor tab). The CLI attributes every action to `cliActor()`, so the
  orchestrator's `SKYLARK_ACTOR=<agent id>` command prefix makes each agent's
  comments, transitions, and handoffs show as that agent.
- **The views** (rigging) — the **board** (issues grouped by status, author +
  comment count + the live status line for building issues), the **thread**
  (body, the merged comment/status-change timeline, a composer, status
  controls), and the **dock** (the persistent app-shell nav —
  Chat/Issues/Files/Inbox/Agents/Models).

## Structure

**A build, end to end.** A human clicks "Build it" (or an agent runs
`npm run issue building <id>`) → `transitionIssue` moves the row through
`assertTransition` and emits `issue.status_changed` once on topic `issue:<id>`
(audience `public`) → the durable row + `pg_notify` reach the server's one
LISTEN connection, which fans onto `shipLogBus` → the orchestrator's
subscription reads the full event by id and calls `onStatusChanged`. On
`→ building` it generates a slug (LLM, cheap) into `<slug>-<nano>`, creates the
worktree if absent, copies the `.worktreeinclude` files in, boots (or reuses)
the playbook entrypoint's session with `cwd` = the worktree, and fires a turn
seeded with the issue + the contract (build-feature-to-an-open-PR for `build`,
the plain brief otherwise). The turn's live events become the issue's
`statusLine`. On the `build` playbook the builder ends its part by batoning to
the babysitter, which waits on `gh pr checks --watch` through the agent
runtime's `background` tool (its turn ends; the session is resumed with the
output when the watch exits), then merges and sets `done` — or hands a fix brief
back to the builder.

**A handoff, end to end.** The builder finishes its part and, as its turn's last
action, runs
`SKYLARK_ACTOR=<its id> npm run issue -- handoff <nano> babysitter "PR #12 open — take it home"`.
`requestHandoff` validates (target is an agent, issue is building, no other hand
mid-turn) and emits `issue.handoff`. The orchestrator hears it, ensures the
target's session exists — booted as the **target's own identity**, its config
riding on that `users` row, `cwd` = the same worktree — and fires a turn briefed
with the message. The notifications reactor fans the same event to the issue's
watchers, so the crew sees the baton move. `handoff <nano> OWNER "<message>"`
emits `issue.owner_ping` instead and skips the worktree turn entirely: the
reactor delivers straight to the owner's inbox, and if the owner is an agent the
waker wakes it on its own inbox session, briefed to find the right chat itself
(see [chat](../chat/zine.md)).

**Why event-driven, not inline.** The builder runs `npm run issue done <id>`
from its bash tool — a separate CLI process. That transition is only a durable
row + a notify; the in-process call that started the build is long gone. The
orchestrator hears the agent because it subscribes to the log, the same way it
hears the browser. This is the bus earning its keep.

**Idempotent side-effects, serialized per issue — and session spawn arbitrated
by the database.** A worktree or session may already exist — a duplicate event,
a resume from `open`, a reconcile racing a live bus note. `ensureBuild`
checks-then-acts: it generates the branch only when `branchName` is unset,
creates the worktree only when absent, and reuses the existing session. But
check-then-act is a race if two events for the same issue run concurrently, so
`onStatusChanged` is **serialized per issue id** (a per-issue promise chain);
different issues still run in parallel. The chain only guards ONE process,
though — a reload window or a second process re-raced it and spawned twin
sessions into the same worktree (#f5io) — so session spawn does not trust the
chain: `ensureAgentSession` creates the session row and claims the
`issue_sessions` link **in one transaction**, and the link's composite PK
`(issueId, agentUserId)` is the arbiter. Losing the claim rolls the candidate
session back (never durable, never fired) and adopts the winner's session.
`reconcile` also sweeps orphans this race left before the fix: a worktree-`cwd`
session no link points at is never resumed (resume only follows links) and, if
stuck `running`, is cancelled — never deleted; session rows are durable
transcripts. The branch + worktree are persisted the moment the worktree exists
on disk — _before_ the session is created — so a DB failure mid-build can't
strand a worktree with no branch recorded (which would re-slug and leak a second
one). `teardown` removes only what's there.

**`.worktreeinclude`.** `git worktree add` does **not** carry gitignored files,
so a fresh worktree has no `.env` and can't reach Postgres. The orchestrator
mirrors what Claude Code does: parse `.worktreeinclude` (`.gitignore` syntax —
comments and blanks dropped; currently just `.env`) and copy each listed path
from the server's checkout into the new worktree.

**Decoupling.** The service writes only its own four tables (`issues`,
`issue_comments`, `issue_sessions`, `playbooks`). It references other services
by id (FKs to `users.id` and `agent_sessions.id`, the one-way pattern the events
and agent schemas already use) and learns about the world through events — it
never queries those tables. The orchestrator reaches into the agent service (to
create/reuse sessions) and the users service (to resolve the builder id) through
their public functions, not their tables.

## Decisions

- **The orchestrator is event-driven, and that is the point.** It would be
  simpler to drive the lifecycle inline from the web transition. We don't,
  because an agent-initiated transition arrives from a separate process and must
  still be heard. Subscribing to the ship's log is what makes "the agent reports
  back by running the CLI" work at all. A future change that "optimizes" this
  into an inline call breaks cross-process builds silently.
- **Decisions route through one pure state machine.** `assertTransition` is the
  only place the legal transitions live. New doors call it; they don't re-encode
  the rules. A transition that isn't legal throws before any write or emit, so a
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
  the merge (`branchMerged`): the branch being an ancestor of `main`, **or** —
  because PRs land here by squash merge, which makes a new commit so the branch
  tip is never an ancestor — a merged PR for the branch per
  `gh pr list --head <branch> --state merged`. If it can't confirm either, it
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
  check if the ship ever grows past shell-is-host trust.
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
- **The baton is an explicit column, moved on the writes that emit its events —
  not re-derived.** Whose turn it is used to be inferred at read time from
  running-hands checks plus the handoff event stream. `batonHolderId` makes it a
  fact, set at the three points it moves (→ building: the entrypoint, in the
  orchestrator, which alone resolves it; `issue.handoff`/`issue.owner_ping`: the
  target/owner, in `requestHandoff`) and cleared on the terminal transitions
  (inline in `transitionIssue`, so a done/closed move can't forget it). Each SET
  rides the SAME durable write that emits the event, so the column and the log
  can't drift; a forged bus event, which never passes through `requestHandoff`,
  can never move the baton. This does NOT add a second state machine —
  `assertTransition` stays the only place legality lives; the column just
  records the holder after a move already made. The one distinction downstream
  reads is human-vs-agent: a human holder is "waiting for input" (the night
  watch, #q9d9, suppresses stall nudges on it), an agent holder is work in
  flight. Backfill is deliberately skipped — a pre-column building issue starts
  with a null holder, which the watch handles conservatively.
- **The event consumer re-validates; the emitter's checks are courtesy.**
  `applyHandoff` re-checks the target is a crew **agent** (a forged or replayed
  event must never boot a session that acts as a human) and only honors an event
  whose envelope agrees with its payload (source `issues`, audience `public`,
  topic = `issue:<payload.issueId>`). The notifications reactor applies the same
  topic-binding before letting a handoff payload adjust recipients.
- **Owner ≠ author, and OWNER rides notifications, not a turn.** `ownerId`
  defaults to the creator and exists so an agent can file work someone else
  answers for. A `handoff OWNER` never boots a worktree session — the owner
  reviews from wherever they are (inbox for a human, an agent wake on its own
  inbox session for an agent; see [notifications](../notifications/zine.md)).
  Corollary: a baton pass to an agent is delivered ONLY as the orchestrator's
  turn — the reactor excludes the target from fan-out so an inbox wake can't
  double-drive it. And an owner may not ping **themself**: your own action is
  never your own news, so a self-ping would vanish silently — `requestHandoff`
  refuses it and points the agent at comment-and-pause instead.
- **A row in `issue_sessions` is a key, so it's guarded like one.** The RLS
  session-visibility rule reads "does an issue point at this session?" from
  `issue_sessions` — which makes inserting a link the power to flip a session
  crew-public. Migration 0015 puts an insert policy on the table: you may only
  link a session you can already see. Selects stay open (the board is public;
  the links carry no content).
- **Reconcile sweeps stranded turns, then resumes the entrypoint's hand.** A
  crash leaves sessions stuck on `running`, and a stuck row would jam the baton
  forever (every handoff refused with "wait for their turn to end"). On startup,
  reconcile cancels any running issue session — a fresh process has no live
  turns, so they're all corpses — then re-seeds the playbook entrypoint's turn.
  If the baton was with a NON-entrypoint agent when the server died, that hand
  stays paused until the next handoff or a human nudge — the honest gap that
  remains.
- **Reconcile ALSO sweeps lost background jobs — last, on purpose (#69iz).** The
  runtime's `reconcileJobs` (hull/agent, #v6ft) clears every stranded
  `background_jobs` row and resumes its session with a "job lost, re-run it"
  message. It's the LAST thing this orchestrator's `reconcile` does, and it's
  wired here — not in `boot.ts` as a standalone call — for two reasons. Order:
  it must run AFTER the stranded-`running` cancels, or a job-lost resume could
  mark its session `running` and then be swept back to idle mid-message, after
  the row was already claimed — silencing the one message that session was owed.
  Instance: it must run on the SAME runtime this orchestrator drives, so a
  job-lost resume landing on a session whose re-seeded entrypoint turn is
  already streaming queues as a `followUp` (one live entry per session —
  `ensureEntry` is single-flight) rather than double-driving the conversation.
  `boot.ts` calls `ensureOrchestrator()` exactly once per boot, so this sweep
  runs exactly once. Both halves are error-isolated (a down DB or a failed sweep
  is logged, never sinks boot). Known residual, accepted for now: a job on a
  CHAT session is swept on the ISSUES runtime while the chat orchestrator
  reconciles that same session on its OWN separate runtime (each
  `orchestrator-live` builds its own `createServerRuntime`) — two live sessions,
  two registries, so the `startGate` single-flight can't see across them. Rows
  are append-only (nothing is deleted), but two turns interleaved into one `seq`
  order could leave a transcript that isn't a valid single conversation, which
  the next boot would feed back to the model verbatim — a resumability hazard,
  not merely cosmetic. Tolerated because builder sessions are jobs' overwhelming
  users and the destructive move (cancel) lives on this side; the real cure is
  one shared server runtime for both orchestrators (then the sweep moves to
  `boot.ts` and single-flight covers chat too), a separate voyage.
- **Playbook entrypoints boot from the entrypoint user's own config.** The
  playbook names WHO starts; how that agent boots is data on its own `users` row
  — one source of truth, the same one a handoff target uses. Corollary:
  `seedAgentConfig` (hull/agent) writes the `builder`, `hand`, and `babysitter`
  crew members' config directly (the chat default is never right for them), and
  `ensureOrchestrator` runs crew + agent-config + playbook seeding on every boot
  so entrypoint resolution never runs against half-seeded config. An issue whose
  playbook (or entrypoint agent) is gone falls back to the legacy builder path,
  loudly.
- **`playbookId` is nullable, and null MEANS build.** No backfill, no required
  field on every door: a bare `issue new`, every pre-playbooks issue, and every
  agent that never heard of playbooks all keep their meaning. The default is
  resolved at orchestration time (`playbookFor`), not stamped at creation.
- **Playbook seeding: boot ENSURES, the explicit CLI seed CONVERGES.**
  `ensureOrchestrator` runs `seedPlaybooks` every boot with create-if-absent
  semantics, so an edit made in the Playbooks editor survives a restart. The
  explicit `npm run agent seed` (`convergeAll: true`) is the factory-reset door
  that rewrites the standard playbook rows to their declared shape. A seeder
  that silently converges on boot un-does the very edits the editor invites —
  that bug shipped once in review and must not ship again. Ensure mode has
  exactly one exception: newly-standard members are APPENDED to an existing
  standard playbook's roster (the factory flow must stay whole when the standard
  roster grows), while every other edit survives. Agent config
  (`seedAgentConfig`) doesn't need this split at all — see hull/agent/zine.md's
  "seed converges an agent's config once, and never again."
- **The build prompt is keyed on the playbook NAME — a known crack.** The
  entrypoint's turn prompt is `buildPrompt` iff the playbook is literally named
  `build`, else `generalPrompt`; the work contract therefore lives in two places
  (the agent's own config, by user; the turn prompt, by name). Fine while
  `build` is the one code-shaped playbook. The intended refit: one uniform turn
  prompt (issue brief + CLI contract) with the build-feature contract living
  only in the builder's config/skill — do that before cloning build-like
  playbooks.
- **The live end-to-end builder is exercised manually, not in CI.** The
  orchestrator's decision logic is unit-tested against fake git/runtime/slug
  (`orchestrator.test.ts`), but a real LLM building real code to a real merged
  PR needs a network, an API key, and a writable git remote — so that path (and
  the cross-process event reaction) is verified by running the ship.
- **The board is public by design.** Issues carry `visibility` (`public` for
  now) as the seam for anything narrower later; unlike chats and sessions, an
  issue is crew-wide news, so no RLS policy hides it.

## Changelog

- **#q9d9** — `driveTurn(issueId, sessionId, text)` added to the orchestrator's
  return: the private `fireTurn` exposed by name so the night watch (hull/watch)
  drives nudges/health-checks through THIS orchestrator's runtime, never a fresh
  one. No lifecycle change.
- **#5vp3** — The baton is now an explicit column, not a re-derivation.
  `issues.batonHolderId` (→ users.id, nullable) + `setBatonHolder`; set to the
  playbook entrypoint on → building (orchestrator), to the target agent on
  `issue.handoff` and to the issue OWNER on `issue.owner_ping`
  (`requestHandoff`, on the same write that emits), and cleared on → done / →
  closed (inline in `transitionIssue`). `assertTransition` stays the single
  state authority. The board card + thread expose the holder (handle +
  human/agent) via one users join in the door, rendered as a modest `BatonChip`.
  This is the "waiting for input" signal the night watch (#q9d9) will read; no
  history backfill — existing building issues start null.
- **#f5io** — Session spawn is idempotent under concurrency, enforced by the
  database: `claimIssueSession` (insert `.onConflictDoNothing().returning()` on
  the `issue_sessions` composite PK) replaces the swallowed-conflict
  `recordIssueSession`; `ensureAgentSession` wraps create-session + claim in one
  transaction and adopts the winner on a lost claim, so a concurrent spawner can
  never fire a turn on an orphan twin. `reconcile` gained an orphan sweep:
  unlinked worktree sessions left by pre-fix duplicate spawns are cancelled if
  `running` (clearing their background jobs too), never resumed, never deleted.
- **Playbooks carry optional per-member instructions, reusable across every
  issue that picks the strategy.** `playbooks.memberInstructions` is a
  user-id-keyed map of role briefs; `instructionsFor` resolves one, and
  `generalPrompt`/`handoffPrompt` fold it into the entrypoint's seed prompt or a
  baton-pass prompt as its own paragraph when set. `buildPrompt` (the hardcoded
  build-feature contract) doesn't take one — it's already fully scripted.
  `validatePlaybookInput`/`validateRoster` reject an instruction keyed to an id
  off the roster; `seedPlaybooks`' append-missing-member path preserves existing
  instructions rather than clobbering them. The Playbooks editor grew a
  per-selected-member textarea for it.
- **Entrypoints boot from agent config, not `users.profileId`.** Profiles
  retired (see hull/agent/zine.md); the playbook still names WHO starts, but HOW
  is now data on that agent's own `users` row, written by `seedAgentConfig` in
  place of the old profile seeding + wiring.
- **Decouple issues from chat** — Dropped `issues.originChatId` and the CLI's
  `--chat` flag: issues carry no reference to chat at all. An agent's wake now
  arrives on its own inbox session (see the [chat zine](../chat/zine.md)), which
  is where it decides which conversation an update belongs in.
- **Housekeeping** — fixed doc drift: the Components/Structure sections still
  described owner pings as riding `issue.handoff` with a `toOwner` flag, though
  #103 split that into a distinct `issue.owner_ping` event type.
- **#4** — The build split: the `babysitter` agent + profile joins the `build`
  playbook, the builder's contract ends at an open PR + a baton, and ensure-mode
  seeding gains its append exception.
- **#3** — Playbooks: roster + entrypoint as data, `issues.playbookId` (null =
  build), the `hand` agent + `general` playbook, the Playbooks editor tab, and
  boot-time seeding convergence.
- **#2** — Owners and the baton: `ownerId` split from `authorId`,
  `issue_sessions` (one per issue × agent), and `handoff` (agent turns + OWNER
  pings).
- **#1** — The message board and building agents: tables, the pure state
  machine, issue events, the CLI, the event-driven orchestrator, the web doors,
  the board + thread views, and the dock.
