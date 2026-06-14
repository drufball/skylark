# The Agent

_agent zine — issue #1_

## tl;dr

The agent is the ship's first resident — a conversation with Claude, driven by
the [pi.dev](https://pi.dev) coding agent SDK. It can read, run bash, and edit
and write files across the repo: a first mate that actually builds things.

The one idea that shapes everything here: **Postgres is the source of truth, not
the running process.** Every message — what you said, what Claude thought, the
tools it called, what they returned — is a durable row the moment its turn ends.
The live pi.dev session that talks to Claude is disposable; it's rebuilt from
those rows whenever it's needed. Crash the process, eject, pull the power — you
lose at most the turn that was mid-flight. History is whatever the database says
it is.

The service lives in the hull and is driven first from the CLI
(`npm run agent`); the web chat is a view in the rigging on top of the same
logic.

## Components

- **Session** — one conversation, a row in `agent_sessions`: its model, its
  status, when it last spoke. Identified by a UUIDv7.
- **Message** — one entry in the transcript, a row in `agent_messages`: a pi.dev
  `AgentMessage` (user / assistant / tool call / tool result / thinking) stored
  verbatim as JSON, ordered by a monotonic `seq`.
- **Service logic** (`service.ts`) — pure, database-agnostic persistence: create
  a session, append a message, list with filters, read history, set status.
  Touches only its own two tables.
- **Runtime** (`runtime.ts`) — the impure shell that drives the SDK: boots an
  ephemeral session from stored history, persists the transcript as it grows,
  and owns the live-session registry that makes queueing and cancelling
  possible. Narrowed to a `PiSession` interface so it can be driven by a fake in
  tests without a network.
- **Doors** — `cli.ts` (the default door) and `server.ts` (the web door, added
  with the chat UI).
- **Status** — `idle` | `running` | `error`. More than display: it's the
  cross-process signal for "a turn is in flight." A row stuck on `running` after
  a crash is stale, and cancelling forces it back to idle.

## Structure

**A turn, end to end.** A message arrives → the runtime loads the session's full
history from Postgres and seeds it into a fresh in-memory pi.dev session →
Claude streams its turn (thinking, tool calls, text) → at every turn boundary
the runtime appends the new tail of the transcript to Postgres. The session is
marked `running` for the duration and `idle` after.

**Rebuild, don't resume.** There is no long-lived session object that must
survive. Seeding works because pi.dev's `AgentState.messages` is assignable;
persistence works because the transcript is **append-only** (see Decisions), so
"what's new this turn" is just everything past the count we've already stored.

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
- **The transcript is append-only, so auto-compaction is off.** Persistence is
  by index — append everything past what's stored. That is correct only if
  earlier messages are never rewritten, so the runtime disables pi.dev's
  auto-compaction (which summarizes history in place). The database keeps the
  _full_ log; fitting a long history into the model's context window without
  mutating that log is future work, not in-place compaction.
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

## Changelog

- **#2** — The web door: a chat UX (the ship's front door at `/`). Server
  functions kick off a turn fire-and-forget; the client polls the transcript and
  status, since Postgres already holds the truth. A pure normalizer
  (`transcript.ts`) flattens stored messages into view items so the rigging view
  stays SDK-agnostic.
- **#1** — Durable sessions over the pi.dev SDK, with the CLI as the first door:
  create, send (queued mid-turn, booted from history when idle), list, cancel.
  Full coding tools (read/bash/edit/write) on the repo. Single-tenant until the
  crew primitive arrives.
