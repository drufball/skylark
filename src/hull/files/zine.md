# Files

_files zine — issue #1_

## tl;dr

Shared documents for the crew — humans and agents — stored as **real files in
the repo** (`src/home/files/`), with git's branch management abstracted away.
Every edit through the service stages on one branch; after a quiet period the
sweep merges it back into `main` with no PR, and the docs are plain files on
disk again — the interop surface for every other tool.

## Components

- **The files dir** — `src/home/files/`, the home deck's document folder. What's
  on disk (committed on `main`, plus any edits other tools made) is the resting
  state.
- **The staging branch** — `files/staging`. Every service write commits here via
  git plumbing (a temp index; the working tree and the crew's index are never
  touched). One branch, shared by everyone, so all readers see the same live
  staged state.
- **The sweep** — merges staging into `main` once it's been idle (the staging
  tip's committer time is the clock, so it works across processes and restarts).
  Only on a clean, `main`-checked-out repo; a conflict aborts and waits for a
  human.
- **Doors** — web (`server.ts`, behind the Files surface) and CLI
  (`npm run files -- list|read|write|rm`), both attributing writes to the acting
  user (the staged commit's author).
- **Events** — every change announces `file.changed` on topic `file:<path>`
  (audience public); a merge announces `files.staging_merged`. The explorer
  subscribes to `file:*`, which is what makes every tab live.

## Structure

**A write, end to end.** The Files surface auto-saves a paused edit → the
`saveFile` door → the service validates the path and commits it onto
`files/staging` (created from `main` if missing) → `file.changed` fires on the
ship's log → every subscribed view re-runs its loader and shows the new state.
Reads route to staging while it exists, else to disk.

**The merge.** A 30s timer sweeps: staging idle past the window (2 min) → repo
on `main` and `src/home/files` clean → real `git merge` (the docs land on disk)
→ staging branch deleted. Anything not ready is postponed to the next sweep; a
conflicting merge is aborted cleanly, leaving both sides intact.

## Decisions

- **One staging branch, not one per edit.** Everyone routed to the same live
  state means per-edit branches would collapse into one anyway; a single branch
  is the same experience with no cross-branch clobbering, by construction.
- **Plumbing against refs, never a checkout.** The working tree is the running
  app and the crew's dev state; a doc edit must not move it. Files reach disk
  only through the guarded merge.
- **Git is the store; there are no tables.** The database is only used to
  announce changes on the ship's log.
- **The idle clock is git's committer time**, not process memory — correct
  across restarts, and across processes (a CLI write elsewhere counts).
- **Auto-merge skips the PR gates on purpose**: these are documents, not code.
  `format:check` ignores `src/home/files/` for the same reason.

## Changelog

- **#1** — The files service and the Files surface land.
