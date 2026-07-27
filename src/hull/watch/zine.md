# Night watch

_watch zine — issue #q9d9_

## tl;dr

The night watch is the ship's after-hours supervisor: a ~60s sweep that catches
a build that has quietly stopped and a background wait that has run long, and
does something about each. It exists because the board's status line can lie —
an agent whose turn ended early leaves "thinking…" on screen while nothing
happens (issue #4mna, from a real incident), and a background job whose resume
never fires strands a session forever.

Two rules, both pure of the clock and the runtime so every threshold is
unit-tested with a fake clock. **Rule 1 (stall nudge):** a `building` issue
whose baton is held by an agent, with no outstanding background job, an idle
baton-holder session, and a status line quiet past a threshold, gets nudged —
gently, then firmly, and on the third strike the owner is pinged and the watch
falls silent. **Rule 2 (health check):** a background job outstanding past its
check-in interval wakes its owning session to self-report; a healthy job just
ends its turn and keeps waiting, and the watch re-wakes it every interval.
**Rule 3 (visibility):** every intervention is a `watchdog.*` event on the
issue's topic, so the notifications reactor fans it to watchers for free.

The watch only OBSERVES the world (through other services' functions) and WRITES
only its own two tables — its memory of what it has already done, so a 60s sweep
and a reload never re-act on the same state.

## Components

- **The sweep** (`live.ts`) — an `interval-sweep` armed once per process from
  `bootAllReactors`, AFTER the issues orchestrator. Each tick resolves the same
  memoized orchestrator (`ensureOrchestrator()`) and runs `runWatchSweep` with
  an injected clock and an injected `driveTurn`.
- **`runWatchSweep`** (`service.ts`) — the orchestration: gather building
  issues, their sessions, and outstanding jobs once; apply Rule 1 per issue and
  Rule 2 per job; persist a timestamp for each intervention. Every step is
  error-isolated so one bad issue/job can't sink the sweep.
- **The pure decisions** (`service.ts`) — `decideStall` and `decideHealthCheck`,
  the whole judgment, taking raw signals + an injected `now` and returning an
  action. `decideStall` reuses the issues service's `computeBuildActivity` as
  its "is it quiet, and how long" oracle rather than duplicating those
  thresholds.
- **The escalation ladder** — `nudgeCount` on `watch_nudges`: 1 = gentle nudge,
  2 = firm nudge, 3 = escalated to the owner. Monotonic for the life of the row.
- **The two tables** (`schema.ts`) — `watch_nudges` (per-issue nudge memory) and
  `watch_job_checks` (per-job health-check memory). See Structure.
- **`watchdog.*` events** — `watchdog.nudged`, `watchdog.owner_ping`,
  `watchdog.stuck` (a stranded handoff climbing toward escalation),
  `watchdog.paused` (escalation with no human owner), and
  `watchdog.health_check`, all on `issue:<id>`, audience public, carrying
  `_notification` metadata (Rule 3).
- **`singleFlight`** (`hull/lib/single-flight.ts`) — wraps the live tick so a
  slow sweep can't overlap the next one.
- **The read-only CLI** (`cli.ts`) — `watch status`: the sweep config and the
  watch's memory. Read-only on purpose (see Decisions).

## Structure

`watch_nudges` is keyed by `issueId` (FK → issues, cascade): `nudgeCount`,
`lastNudgeAt`, `updatedAt`. `watch_job_checks` is keyed by `jobId` (FK →
background_jobs, cascade): `checkCount`, `lastCheckedAt`. The cascades mean the
watch's memory can never outlive the issue or job it tracks. These are the two
tables the service writes; everything else it learns by calling other services'
functions (`listIssues`, `listIssueSessions`, `getIssueSession`,
`listOutstandingBackgroundJobs`, `runningSessionIds`, `getUserById`) — it never
reads another service's tables directly.

A per-call check-in override rides on the agent service's `background_jobs` row:
the `background` tool gained an optional `checkInMinutes`, stored as
`check_in_interval_ms` (owned by the agent service, read by the watch, never
written by it). Null means "use the watch default".

Interventions flow OUT two ways. A **drive** (nudge or health check) goes
through `orch.driveTurn(issueId, sessionId, text)` — the one seam added to the
issues orchestrator, which is just its private `fireTurn` exposed by name. A
**surfacing** is an `emitEvent` on the issue topic with `_notification`
metadata; the notifications reactor (which fans any public event carrying that
metadata) turns it into inbox rows.

The third-strike terminal move has two shapes, because it must GUARANTEE the
watch goes quiet. If the issue owner is a **human**, the baton is handed to them
(`setBatonHolder`) and they're pinged — a human baton reads as "waiting for
input", so Rule 1 leaves it alone. But `issues.ownerId` defaults to `authorId`
and can be an **agent**; handing the baton back to an agent would loop the watch
forever (and if the owner IS the stalled holder, the reactor drops the ping as
"your own action"). So when there's no human owner, the watch instead PAUSES the
build to `open` via `transitionIssue` — Rule 1 only watches `building`, so that
is what falls silent — and pings the issue author if they're a distinct human.

## Decisions

- **Drives go through the issues orchestrator's OWN runtime, never a fresh
  one.** An issue-backed session is owned by the runtime the issues orchestrator
  boots; only that instance's single-flight/queue can fold a nudge into a
  `followUp` instead of double-driving a session another turn is already on (the
  #69iz caveat). So the watch's `driveTurn` is injected from
  `ensureOrchestrator()`, and the CLI — a separate process — is READ-ONLY: it
  must never drive a turn, because that would spin up a second runtime and
  double-drive.
- **The sweep arms AFTER reconcile, and its interval floor guarantees it.** The
  first tick fires ~60s in, by which point the orchestrator's boot reconcile has
  long settled — so the watch never acts on pre-crash state (a session marked
  `running` by a crash, a stranded job) that reconcile is still clearing.
- **Idempotency is the persisted timestamp, not a lock.** A 60s sweep must not
  stack nudges or health checks. `lastNudgeAt` gives a re-nudge floor (no two
  interventions inside one stall-threshold window) and `lastCheckedAt` a
  re-check floor (one wake per interval). Both survive a reload, so escalation
  resumes where it left off rather than restarting the gentle ladder.
- **`nudgeCount` is monotonic — never reset on partial recovery.** Repeated
  stalling on one issue should reach a human FASTER, not restart at "gentle". A
  build that recovers and stalls again keeps climbing toward the owner ping.
- **A human (or empty) baton is never nudged.** A human holder is the universal
  "waiting for input" signal; an empty holder (a pre-baton build we can't
  resolve) is treated the same way — conservatively left alone.
- **The owner ping requires a HUMAN owner; otherwise pause.** "Escalate to the
  owner" only makes the watch go quiet if the owner is human. An agent owner
  (the default, since `ownerId` defaults to `authorId`) must never receive the
  baton on escalation — that loops. The safety property is: after the third
  strike the issue is EITHER held by a human OR no longer `building`. See
  Structure. `handoff.ts` guards the analogous self-ping-strands-the-issue case;
  this mirrors that intent for the watch.
- **A stranded handoff (agent baton, no session) escalates — it is not
  skipped.** `requestHandoff` moves the baton to the target agent BEFORE the
  orchestrator creates that agent's session, and a dropped pass (off-roster,
  another hand mid-turn) never reverts it — leaving an agent baton with no
  session to nudge. The watch treats that as stuck: it climbs the same ladder
  (surfacing `watchdog.stuck` without a disruptive action while it waits out the
  stall window — a legit in-flight handoff resolves in seconds) and reaches the
  terminal human escalation, rather than silently returning forever.
- **Record the intervention BEFORE the fire-and-forget drive.** If the drive
  throws after the record, the re-nudge/re-check floor still holds; if it threw
  before, the watch would re-fire every sweep.
- **A slow sweep can't overlap the next.** The live tick is wrapped in
  `singleFlight` (`hull/lib`), so a sweep that runs past the interval (a waking
  database) drops the next fire rather than letting two sweeps read the same
  not-yet-persisted state and double-intervene.
- **Health-check drives repeat every interval; the watcher-facing event fires
  once.** A healthy 90-minute job is re-woken to self-report each interval (by
  design), but only the FIRST check notifies watchers — re-notifying every
  interval would be inbox spam.
- **v1 is issue-backed building sessions only.** Every recorded incident lives
  there. A background job on a chat/bare session is skipped — there's no
  per-session activity clock for non-issue sessions, and driving one would need
  a different owning runtime anyway.
- **The nudge is an invitation, not a script.** It says "continue, or hand off
  the baton if you're blocked" — deliberately NOT a hardcoded
  check/commit/push/PR playbook, which was one playbook's contract, not
  universal.

## Changelog

- **#q9d9** — The night watch: the stall-nudge + background-health-check sweep,
  its two memory tables, the `driveTurn` seam on the issues orchestrator, and
  the `background` tool's optional per-job check-in interval.
