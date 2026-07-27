# Files

_files zine — issue #1_

## tl;dr

Shared documents for the crew — humans and agents — stored as **real files in
the repo** (`src/home/files/`), with git's branch management abstracted away.
Every edit through the service stages on one branch; after a quiet period the
sweep merges it back into `main` with no PR, pushes `main` to origin, and the
docs are plain files on disk again — the interop surface for every other tool.

## Components

- **The files dir** — `src/home/files/`, the home deck's document folder. What's
  on disk (committed on `main`, plus any edits other tools made) is the resting
  state.
- **The staging branch** — `files/staging`. Every service write commits here via
  git plumbing (a temp index; the working tree and the crew's index are never
  touched). One branch, shared by everyone, so all readers see the same live
  staged state.
- **The sweep** — merges staging into `main` once it's been idle (the staging
  tip's committer time is the clock, so it works across processes and restarts),
  making `main` pushable first and pushing the result after, so local `main`
  never drifts from origin. Only on a clean, `main`-checked-out repo; a conflict
  aborts and waits for a human, loudly and a bounded number of times.
- **Doors** — web (`server.ts`, behind the Files surface) and CLI
  (`npm run files -- list|read|write|rm`), both attributing writes to the acting
  user (the staged commit's author).
- **Events** — every change announces `file.changed` on topic `file:<path>`
  (audience public); a merge announces `files.staging_merged`, and a sweep that
  has given up retrying announces `files.sweep_wedged` on `files:sweep`. The
  explorer subscribes to `file:*`, which is what makes every tab live.

## Structure

**A write, end to end.** The Files surface auto-saves a paused edit → the
`saveFile` door → the service validates the path and commits it onto
`files/staging` (created from `main` if missing) → `file.changed` fires on the
ship's log → every subscribed view re-runs its loader and shows the new state.
Reads route to staging while it exists, else to disk.

**The merge.** A 30s timer sweeps: staging idle past the window (2 min) → repo
on `main`, no other git operation open, and `src/home/files` clean → fetch
origin, and converge with `origin/main` _only if origin actually moved past us_
→ real `git merge` (the docs land on disk) → staging branch deleted → push
`main` to origin. Anything not ready is postponed to the next sweep; a
conflicting convergence or merge is aborted cleanly, leaving every side intact.
A rejected push (origin moved between fetch and push) waits too: local `main` is
now ahead of the last-fetched `origin/main`, so the next sweep — staged work or
not — pushes it. A repo with no origin remote skips all of it and merges as
before.

**Converging with origin.** `origin/main` already an ancestor of local `main`
(nothing fetched that we lack) means a plain push fast-forwards, so the sweep
does nothing to history — the case that covers a fat backlog of unpushed doc
commits. When origin genuinely advanced, the sweep **merges** `origin/main` into
`main`: one content-level three-way merge, so no historical commit can block it,
and every local commit keeps its identity and its author. A conflict inside
`src/home/files` is resolved by **union** — both sides' hunks, in order, no
markers, nothing deleted; a doc only one side still has survives with that
side's content. A conflict anywhere else (code, config), a binary file, or a
merge that fails before conflicting is never auto-resolved: the merge aborts and
the sweep asks for a human.

**When the sweep can't.** Every tick reports its outcome: idle and successful
sweeps say nothing (a quiet log means a healthy sweep), and `postponed`,
`conflict`, `push-rejected` and `wedged` say so on the console — first time,
then once every ten repeats, so it never floods and never goes silent. Five
consecutive failures latch the sweep **wedged**: it stops running the same
doomed git command every 30s, announces `files.sweep_wedged` once on the ship's
log, and only probes every twentieth tick (~10 min) so a cause that clears
itself still recovers without a restart. A success clears the latch.

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
  `format:check` ignores `src/home/files/` for the same reason, and CI's push
  trigger ignores the same path so the sweep's pushes to `main` don't burn a run
  (PR gates are untouched — code still can't dodge them).
- **The sweep pushes `main`, because an unpushed `main` poisons everything
  downstream**: doc and memory commits that only exist locally put every branch
  cut from local `main` dozens of commits ahead of origin, and block the serving
  checkout from ever fast-forwarding (#fssz). A rejected push just waits for the
  next sweep, which sees `main` ahead of origin and retries. Never a forced
  push.
- **Don't touch history to push what already fast-forwards.** The sweep used to
  sync unconditionally, and #p5as is what that cost: with `origin/main` already
  an ancestor of local `main`, it rebased 56 historical doc commits onto origin
  anyway, conflicted on the first, and retried the identical doomed rebase every
  30s for 25 minutes. The ancestor check is the whole fix for the common case.
- **Converge on content, not on history.** When origin has genuinely advanced,
  the sweep merges rather than replaying local commits. Replaying N historical
  doc commits over a base that already holds newer content is inherently
  conflict-prone, and granular per-commit history is not what these documents
  are for: they're append-mostly logs written concurrently by agents, where the
  useful thing is the current content plus who wrote it. A merge is one content
  decision instead of N, so no historical commit can wedge it, and every local
  commit keeps its id and author. The cost is merge commits on `main`, which we
  accept.
- **A conflicting document is unioned: the sweep never deletes a line either
  side wrote.** This is the tie-break policy, and it's a product decision, not
  an implementation detail. Preferring local would clobber deliberate edits made
  on origin — a PR touching `src/home/files` is legitimate and has happened
  (#q2zi repaired the crew's memory files that way). Preferring origin would
  silently delete agent memory the live ship wrote and hasn't pushed yet, and
  the ship is the primary writer. Union loses nothing from either side; its cost
  is that a doc can briefly carry duplicated lines, or resurrect a line origin
  deliberately removed — visible, tidy-able by any agent or human, and recorded
  in the merge commit. That trade — a mess you can see over content you can't
  get back — is the one we take every time. It applies **only** inside
  `src/home/files`, and only to text: a conflict in code, or in a binary file,
  is never guessed at.
- **The sweep never touches a git operation it didn't start.** Its failure paths
  run `merge --abort`, and an abort doesn't ask whose merge it is — the serving
  checkout is somebody's working copy, and a crew member part way through
  resolving a merge or rebase on `main` by hand would simply lose that work. So
  `mergeReadiness` reports `merge-in-progress` while any merge, rebase,
  cherry-pick or revert is open, and the sweep postpones — even if the files dir
  itself is clean. Undefined state, human's call, said out loud.
- **A wedged sweep is loud and bounded.** Retrying a known-failing git command
  every 30s forever, silently, is how #p5as stayed invisible for 25 minutes.
  Outcomes are reported (idle ones stay quiet, so silence is real news), five
  consecutive failures stop the hammering, and the wedge announces itself on the
  ship's log. An out-of-band edit blocking a sweep is accepted behaviour — that
  state is undefined and wants a human — but it must fail loudly, not silently.
- **The write path refuses captured command output.** An agent that pipes
  `npm run files -- read` output back into a write buries npm's two-line script
  banner in the document; #q2zi repaired that data and it recurred, because
  nothing stopped it. The guard rejects the write (never rewrites content) and
  keys on the banner's two-line PAIR — a lone `> word` is a blockquote, so
  ordinary prose, fenced code, and `> npm run files -- list` all pass untouched.

## Changelog

- **#1** — The files service and the Files surface land.
- **#fssz** — The sweep syncs `main` with origin and pushes after merging, so
  local `main` stops diverging from origin.
- **#p5as** — The sweep stops rebasing what a plain push would fast-forward,
  converges on content (union inside the files dir) when origin really moved,
  reports every outcome and gives up after five identical failures, and refuses
  writes carrying captured npm banner output.
