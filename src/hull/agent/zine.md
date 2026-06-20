# The Agent

_agent zine — issue #4_

## tl;dr

The agent is the ship's first resident — a conversation with Claude, driven by
the [pi.dev](https://pi.dev) coding agent SDK. How it boots is decided by a
**profile**: a read-only chat pilot, a full builder, or anything in between.

The one idea that shapes everything here: **Postgres is the source of truth, not
the running process.** Every message — what you said, what Claude thought, the
tools it called, what they returned — is a durable row the moment its turn ends.
The live pi.dev session that talks to Claude is disposable; it's rebuilt from
those rows whenever it's needed. Crash the process, eject, pull the power — you
lose at most the turn that was mid-flight. History is whatever the database says
it is — the **full** history, even across compaction (see Decisions).

The service lives in the hull and is driven first from the CLI
(`npm run agent`); the web chat is a view in the rigging on top of the same
logic.

## Components

- **Session** — one conversation, a row in `agent_sessions`: its model, status,
  when it last spoke, and how it boots — a `profileId`, a `cwd` (where its tools
  operate; null = repo root), and an `agentUserId` (which crew member it acts
  as). Identified by a UUIDv7.
- **Profile** — a reusable recipe for booting an agent, a row in
  `agent_profiles`: which `tools` (null = the default coding set), a
  `systemPrompt`, whether to read CLAUDE.md (`readContextFiles`), whether to
  load the repo's skills (`useRepoSkills`), which `extensionIds` to load, and an
  optional `model` override. The runtime resolves a profile into pi.dev session
  options. Two are seeded: **chat** (read+bash, no context/skills/extensions —
  the front door, which reads and operates but never writes; to build, it files
  an issue) and **builder** (full coding tools, CLAUDE.md + skills, the
  build-gates extension — used by building agents).
- **Extension** — a pi.dev TS extension, registered as a row in `extensions`
  (name, description, repo-relative `path`). Profiles reference extensions by
  id. Extensions intercept the agent's lifecycle — pi.dev's answer to the
  human's Claude Code hooks.
- **build-gates** — the first extension. Mirrors the ship's Claude Code hooks
  for builder agents: run `npm run check` before a `git add`/`git commit` and
  block on failure (commit-gate), warn about unpushed commits at session end
  (landing-gate), and run `./scripts/setup` on session start. Its pure decisions
  live in `gates.ts` (unit-tested); the pi wiring in `index.ts` is `v8 ignore`d
  like the runtime's live layer.
- **Message** — one entry in the transcript, a row in `agent_messages`: a pi.dev
  `AgentMessage` (user / assistant / tool call / tool result / thinking) stored
  verbatim as JSON, ordered by a monotonic `seq`.
- **Service logic** (`service.ts`, `profiles.ts`) — pure, database-agnostic
  persistence: sessions/messages in `service.ts`; profiles + the extensions
  registry (CRUD, idempotent `seedProfiles`) in `profiles.ts`. Touches only the
  agent's own tables.
- **Runtime** (`runtime.ts`) — the impure shell that drives the SDK: resolves a
  session's profile, boots an ephemeral session from stored history in the
  session's `cwd`, persists the transcript as it grows (compaction-safe — see
  Decisions), and owns the live-session registry that makes queueing and
  cancelling possible. Narrowed to a `PiSession` interface so it can be driven
  by a fake in tests without a network.
- **Session config** (`session-config.ts`) — the pure mapping from a resolved
  profile + cwd to pi.dev session/resource-loader options. Unit-tested apart
  from the live `createPiSession` wiring, so the decision (which tools, skills,
  context, extensions) is verifiable without a network.
- **Progress helpers** (`progress.ts`) — neutral primitives for translating
  `AgentSessionEvent`s into progress lines: `toolExecutionDetail` extracts tool
  name + args, `isTurnBoundary` identifies turn_end/agent_end, `truncate` limits
  text length. Consumer formatters (`chatProgressLine`, `issuesProgressLine`)
  compose these for their display policy. The CLI also uses the primitives for
  terminal rendering.
- **Doors** — `cli.ts` (the default door: also `seed`, `profiles`, `extensions`)
  and `server.ts` (the web door; the front-door chat boots the chat profile).
- **Shared config** (`config.ts`) — resolves the ship's CLAUDE.md and skill
  directories so the runtime can feed them to the agent: one source of config
  for both the human and the agent.
- **Status** — `idle` | `running` | `error`. More than display: it's the
  cross-process signal for "a turn is in flight." A row stuck on `running` after
  a crash is stale, and cancelling forces it back to idle.

## Structure

**A turn, end to end.** A message arrives → the runtime resolves the session's
profile (and its extensions), loads the session's full history from Postgres,
and seeds it into a fresh in-memory pi.dev session booted in the session's `cwd`
→ Claude streams its turn (thinking, tool calls, text) → at every turn boundary
the runtime appends the new tail of the transcript to Postgres. The session is
marked `running` for the duration and `idle` after.

**Rebuild, don't resume.** There is no long-lived session object that must
survive. Seeding works because pi.dev's `AgentState.messages` is assignable;
persistence works because the **durable log is append-only and monotonic** — a
message is written once, in order, and never rewritten — so "what's new" is
everything past a baseline count. The in-memory transcript _is_ rewritten by
compaction; the runtime keeps the durable log whole anyway (see Decisions).

**Per-session cwd.** Every pi tool (bash/read/edit/write) operates relative to
the `cwd` passed to `createAgentSession`, not the process's global cwd
(verified: `runtime-cwd.test.ts`). That's what lets several building agents run
in-process at once, each on its own git worktree, without colliding.

**Queue and cancel are per-process.** The runtime keeps a registry of the
sessions live _in this process_. A second message to a session whose turn is
still streaming is queued onto it (pi.dev's follow-up); a cancel aborts it. A
long-lived host (the web server) is where this matters; a one-shot CLI
invocation just boots, runs a turn, and disposes. Any process can pick up any
idle session, because the truth is in the database, not the registry.

## Decisions

- **Postgres is the source of truth; the pi.dev session is ephemeral.** We do
  not rely on an in-process session surviving. pi.dev's own JSONL session store
  is run in-memory and ignored. This is the whole point of the service: durable
  to a crash, resumable from anywhere.
- **Auto-compaction is ON; the durable log stays the full history.** A long
  builder session would overflow the context window, so pi.dev's auto-compaction
  is enabled — it collapses an early prefix of the in-memory transcript into a
  summary and keeps a recent suffix. But the database is the source of truth and
  must keep _every_ real message, so persistence is **append-only and monotonic,
  not a mirror of the live array**: the runtime flushes the full pre-compaction
  transcript on pi's `compaction_start` (fired _before_ the array is rewritten),
  then rebases its baseline to the post-compaction length on `compaction_end`.
  The synthetic summary is never persisted as history, the kept suffix is never
  re-persisted, and post-compaction messages keep growing the durable log. On
  reboot we seed pi with the full durable history and let it re-compact
  in-memory as needed. (This replaces the prior issue-#1 contract, where the log
  was a strict index-mirror and compaction was disabled to protect it.)
  - **Read the volatile values synchronously, at event time.** The
    pre-compaction snapshot and the post-compaction length are both captured
    _inside_ the event handler, never in the deferred persist-chain `.then` — pi
    rewrites the array in place, so a deferred read would race the rewrite and
    the post-compaction appends. Only the durable _writes_ are deferred onto the
    chain. This is the fragile, load-bearing detail: a rebuild that defers the
    reads would still pass the compaction tests yet reintroduce the race.
  - **A retry-after-compaction can leave a harmless ghost.** If an errored
    assistant message triggers compaction with `willRetry`, that message is
    flushed durably before pi slices it off to retry — so the durable log may
    carry one transient errored message that re-seeds as context on reboot.
    Append-only holds and nothing is lost; this is a known fidelity artifact,
    not a bug to "fix" into one.
- **A failed turn drops its live session from the registry.** A flush that
  rejects can leave a permanently-rejected persist-chain on the in-process
  entry; reusing it would wedge the session forever in a long-lived host. So
  `runTurn` disposes the entry on any error — the next turn rebuilds a clean
  session from the durable log, the same recovery any other process would take.
- **A session carries a real FK to `users.id` (`agentUserId`); the reverse link
  is deliberately FK-free.** `agent/schema` imports `users/schema` for that FK,
  the same one-way pattern the events service uses. The mirror —
  `users.profileId` pointing at agent profiles — is kept FK-free on purpose to
  keep the import one-directional (a FK there would make the schemas import each
  other). See [`../users/zine.md`](../users/zine.md).
- **The agent is hull, not rigging.** It's load-bearing — the ship's primary
  resident, the thing other services will route work through — and its
  persistence contract is a foundation you shouldn't have to re-derive per ship.
  The _experience_ of talking to it (the chat UI) is rigging; the durable core
  is hull.
- **No crew column yet — a known, temporary debt.** `src/zine.md` holds that
  access is structural: every row knows its crew, by construction. These two
  tables ship without it because the crew primitive isn't built. This is the one
  place the ship knowingly defers that invariant; when crew lands (in the hull,
  per [`hull/zine.md`](../zine.md)), these tables get crew columns and queries
  get crew filters. Tracked here so the deferral is honest, not silent.
- **Anthropic models only, for now.** Default `claude-sonnet-4-5`, pinned per
  session and overridable. The SDK speaks other providers; we don't yet.
- **A profile decides how an agent boots; the runtime is one engine.** Tools,
  prompt, context, skills, extensions, model — all data on a profile row, not
  hardcoded. One runtime drives a read-only chat pilot and a full builder alike.
  A session with no profile falls back to the pre-profiles default (full tools,
  CLAUDE.md + skills, no extensions), so legacy sessions boot unchanged.
- **The front door reads but never writes.** The chat profile has only read+bash
  — the front-door agent operates the ship's services and reads its code, but to
  build or change something it files an issue. This is the intended end state
  ("file an issue to build"), and a deliberate narrowing from issue #1, where
  the only agent had full write tools.
- **The agent shares the ship's config; hooks become extensions.** CLAUDE.md and
  the human's skills are fed through pi.dev's resource loader (`config.ts`), so
  config lives in one place — but a profile can opt out of either. Hooks are not
  shared as shell-commands (those are Claude Code harness wiring about the
  human's git flow); their pi.dev equivalent is **TS extensions**, loaded via
  the loader's `additionalExtensionPaths`. The build-gates extension is the
  commit/landing/session-start gates rebuilt against pi's extension API for
  builder agents — same intent, different mechanism, not auto-translated from
  `settings.json`.
- **Extensions are referenced by registry, not by path.** A profile names
  extensions by id; the `extensions` table maps id → repo-relative path. The
  registry is the single place a profile (and the future UX) names an extension,
  so code can move without rewriting every profile.

## Changelog

- **#27** — Progress primitives: extracted neutral event helpers
  (`toolExecutionDetail`, `isTurnBoundary`, `truncate`) into `progress.ts` so
  chat, issues, and the CLI all compose from the same base rather than
  duplicating ~120-char truncation and tool formatting logic.
- **#4** — Profiles, an extensions registry, and compaction-safe persistence.
  How an agent boots is now a profile row (tools/prompt/context/skills/
  extensions/model), resolved by the runtime into pi.dev options; two are seeded
  (chat, builder). Extensions are registered rows; build-gates is the first
  (commit/landing/session gates for builders). Sessions gained `profileId`,
  `cwd`, and `agentUserId`. Auto-compaction is now **on** and the durable log
  keeps the full history regardless — replacing #1's "compaction off to protect
  an index-mirror" contract. Agent users default to the chat profile.
- **#3** — Config sharing: the agent reads the ship's CLAUDE.md and skills via
  pi.dev's resource loader, so there's one source of config for human and agent.
  Hooks stay Claude-Code-only by design.
- **#2** — The web door: a chat UX (the ship's front door at `/`). Server
  functions kick off a turn fire-and-forget; the client polls the transcript and
  status, since Postgres already holds the truth. A pure normalizer
  (`transcript.ts`) flattens stored messages into view items so the rigging view
  stays SDK-agnostic.
- **#1** — Durable sessions over the pi.dev SDK, with the CLI as the first door:
  create, send (queued mid-turn, booted from history when idle), list, cancel.
  Full coding tools (read/bash/edit/write) on the repo. Single-tenant until the
  crew primitive arrives.
