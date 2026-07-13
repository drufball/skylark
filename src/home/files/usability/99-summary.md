# Night watch summary — 2026-07-12/13 (Spring Cleaning)

## Shipped: 4 tasks, 4 PRs, all merged + deployed
- **#4mna → PR #129** (tilde): issue-board status line now distinguishes
  busy (amber hammer + live command) / waiting-on-job (blue) / **⚠ stalled**
  (red). Verified live; it surfaced the very next incident (a hung find /).
- **#jgdb → PR #130** (bix): `npm run agent show <id> [--tail N]` — session
  inspection without SQL. Immediately found the bricked triager (doc 10).
- **PR #131** (night watch): repaired agent memory files corrupted by #130's
  merge (unresolved conflict markers + CLI banner noise; #q2zi closed).
- **#v6ft → PR #132** (tilde's builder, landed by night watch): background
  jobs write a durable row (migration 0025) and a boot reconciler resumes
  stranded sessions with an explicit "job was lost" message. Landing it
  uncovered and fixed a REAL cross-platform bug: the onClose handler's
  fire-and-forget row delete racing a database close wedges PGlite forever —
  this was the "vitest hang" that stalled the builder locally AND CI.

## The dogfood verdict
The chat→file→build→triage→merge circuit works end to end. @mention routing
was flawless (only the tagged agent ever replied); tilde and bix filed sharp,
well-investigated issues; post-#126 the inbox pings to the chat were clean
and informative.

## All discoveries: docs 00-10 in this folder
Headlines: merges don't deploy (01, 05, 07); builders stall silently and tool
calls have no timeout (06, 09); the triager got bricked by a stale shell cwd
(10); markdown corruption passes every gate (#q2zi); pre-hydration form
submits silently no-op (02).

## Landing lessons (new tonight, for the build-loop backlog)
- The commit-gate runs `npm run check` against the MAIN checkout, not the
  invoking worktree — formatting/lint/type errors escaped to CI on 5 separate
  pushes of PR #132. (Old issue #8cif/#uvnm territory — still real.)
- `npx prettier --write` (latest) formats differently than the repo-pinned
  prettier; always use `node_modules/.bin/prettier`.
- `.gitignore`'s `node_modules/` does not match a node_modules SYMLINK — one
  got committed (and squash-merge erased it).
- The diff-cover 90% gate counts log-only catch lines; repo idiom is
  `/* v8 ignore */` for those.

## Interventions (~17 total)
3 rogue-inbox cancels (pre-#126), dup-babysitter + dup-builder cancels,
3 builder unstick nudges + 2 pace-checks, 6 hung-process kills (find /,
vitest ×5), triager unbrick, 2 lockfile regens (pinned npm), memory-file
repair PR, deploy after every merge.

## Remaining queue (paused for debrief, in priority order)
1. JOINT tilde+bix: watchdog + fleet health (docs 06/09/10 are the case file)
2. bix: orchestrator spawn races (dup sessions same-second: en2b 2, 4mna 3, jgdb 3)
3. tilde: deploy gap — auto-sync serving checkout post-merge with pinned npm,
   move memory/file commits off local main (docs 01/05/07)
4. bix: pre-hydration form guard + stale-cwd bash fallback (docs 02/10)
5. #ppf1 (pending-message display bug) and #6g2p (conflict-marker CI guard) — open, unowned
