# Babysitter memory

## Role
I shepherd open PRs to merge for issues handed to me by @builder. I never write
code — if CI fails or reviews need real changes, hand back to @builder with a
precise brief; after a second round-trip on the same PR, or if merging is
blocked by branch protection/required review, hand off to OWNER instead.

## Workflow (see plugins/skylark-builder/skills/babysit-pr/SKILL.md, full text
below skill dirs under each worktree — read it fresh each time, it's the
authoritative process)
1. `gh pr checks <pr>` for a quick peek; use `gh pr checks <pr> --watch
   --interval 30` in the FOREGROUND via the bash tool with a generous timeout
   (there is no working `background` tool in this environment as of 2026-07 —
   attempts to call a `background` function failed with "Tool background not
   found"). Just run the watch command directly with `bash` and a timeout
   (e.g. 600-900s); it blocks until checks settle, which is fine. Sometimes it
   returns "no checks reported" right after a push before GH has registered
   the new run — wait ~20s and retry rather than treating that as an error.
2. Once checks are green, confirm `gh pr view <pr> --json
   mergeStateStatus,mergeable` — only merge on CLEAN/UNSTABLE+MERGEABLE.
   BEHIND -> rebase+push. DIRTY/CONFLICTING -> rebase, resolve, re-check.
   BLOCKED -> escalate to OWNER, don't retry. Note: right after a push the
   API can transiently report mergeStateStatus UNKNOWN — wait a few seconds
   and re-query rather than treating that as blocked.
3. Check `gh pr view <pr> --comments` for unresolved review feedback before
   merging.
4. `gh pr merge <pr> --squash --delete-branch`. Note: a PR can end up merged
   already by the time you get here (e.g. checks watch showed CLEAN, another
   process/auto-merge landed it) — the merge command will error "already
   merged"; just verify via `gh pr view <pr> --json state,mergedAt` and treat
   MERGED as success, don't treat that error as a failure to fix. Also: `gh pr
   merge --delete-branch` can fail with "fatal: 'main' is already checked out
   at <other-worktree-path>" even though the merge itself succeeded (it's just
   the local branch-delete/checkout step tripping over another worktree
   having main checked out) — check mergedAt to confirm the merge landed, and
   if so just delete the remote branch yourself: `git push origin --delete
   <branch>` (or just `git fetch origin --prune` first — gh sometimes deletes
   the remote branch itself before the local checkout step fails, so it may
   already be gone; check `git branch -r` / the prune output before assuming
   you need to delete it).
5. Mark the issue done via `npm run issue -- done <issue>` as the LAST action.

## Conflict-resolution notes
- When a PR conflicts with main because another already-merged PR touched the
  same files (e.g. two layout PRs both editing chat.tsx/agent-chat.tsx/
  files.tsx), `git rebase origin/main` is the right move — resolve by keeping
  both intents: the earlier-merged structural change (e.g. a new
  CollapsibleSidebar component) plus this PR's additive change (e.g.
  overflow-hidden/min-h-0 pinning classes) layered on top, not picking one
  side wholesale. Read both versions in full before resolving, diff the
  pre-rebase PR branch vs origin/main per file to understand which lines are
  genuinely new vs a superseded copy of the same pattern.
- Not every CONFLICTING/DIRTY mergeStateStatus means real file conflicts:
  sometimes `git rebase origin/main` replays cleanly with zero manual
  resolution (git's own conflict detection vs GitHub's mergeability check can
  disagree, or the divergence is just unrelated commits landing in between).
  Don't assume you need to hand-merge content — try the plain rebase first
  and only dig into per-file diffing if git actually stops with conflict
  markers.
- After resolving and committing, if you end up in a detached HEAD (rebase
  auto-committed without an interactive rebase-merge state file, e.g. because
  the git version handles single-commit rebases as a plain replay), just
  `git branch -f <branch> HEAD && git checkout <branch>` before pushing.
- Always rerun `npm run check` after resolving conflicts even if the original
  builder said it was clean — a rebase changes the code. If the full run shows
  a batch of unrelated failures (e.g. DB/postgres hook timeouts across many
  hull/* test files), re-run just those files in isolation before assuming
  it's a real regression — resource contention in a big parallel vitest run
  can produce spurious timeouts unrelated to the change; if isolated runs pass
  and a second full `npm run check` run is clean, treat the first as flake.

## History
- osy7 (Mobile-friendly responsive layout, PR #124): builder's audit was
  correct — issue-board.tsx/inbox.tsx are single-column nav-per-item pages,
  nothing to fix there. PR added useIsMobile()+CollapsibleSidebar (shadcn
  Sheet drawer), wired into chat/agent-chat/files. All CI checks (smoke,
  verify, review, coverage) passed clean, mergeStateStatus CLEAN, no blocking
  review comments, merged squash+delete-branch. Straightforward one-round
  babysit, no builder round-trip needed.
- en2b (Sidebar/dock pinned-to-viewport layout, PR #125): opened CONFLICTING
  because osy7/#124 merged first and touched the same layout files
  (chat.tsx/agent-chat.tsx/files.tsx, adding CollapsibleSidebar). Rebased onto
  main myself (no code-writing needed, just merge-conflict resolution —
  layered en2b's h-full+overflow-hidden+min-h-0 pinning on top of #124's
  CollapsibleSidebar/useIsMobile plumbing), fixed a couple of conflict-marker
  leftovers in test files by hand, ran npm run check (one spurious full-suite
  DB-timeout batch, confirmed unrelated via isolated re-runs + a clean second
  full run: 830/830), force-pushed. CI green, mergeStateStatus CLEAN, no
  review comments, merged squash. `gh pr merge --delete-branch` failed on the
  local checkout-collision error even though merge succeeded — deleted the
  remote branch manually after confirming mergedAt. No builder round-trip
  needed; handled the conflict myself since it was pure merge mechanics, not
  a code defect.
- iv1t (Pin npm to match CI / npm-cmd auto-routing, PR #127): opened
  CONFLICTING/DIRTY, but `git rebase origin/main` replayed all 7 commits
  clean with zero conflict markers (the divergence was just unrelated commits
  — #124/#125 layout PRs and some agent-memory writes — landing in between,
  not overlapping file edits). Ran npm run check post-rebase: 834/834 clean
  on the first try (no flake this time). Force-pushed, watched checks
  (smoke/verify/coverage all pass), mergeStateStatus went CLEAN/MERGEABLE
  after a brief UNKNOWN blip right after push, no review comments, merged
  squash. Same --delete-branch local-checkout-collision as before; deleted
  remote branch manually post mergedAt confirmation. No builder round-trip
  needed.
- zo3a (Chat thinking bubble persistence via chat_members progress column,
  PR #128): builder's PR was already rebased onto latest main (past
  #124/#125/#127) before opening. Watched checks: review/smoke/verify/coverage
  all passed clean on the first run, no flake, no rebase needed.
  mergeStateStatus CLEAN/MERGEABLE, no review comments. Squash-merged
  cleanly in one round, no builder round-trip. `gh pr merge --delete-branch`
  hit the usual local-checkout-collision error but merge itself succeeded
  (mergedAt confirmed) and the remote branch was already gone by the time I
  fetched --prune — gh apparently deletes the remote branch before the local
  checkout step fails, so no manual `git push origin --delete` was needed
  this time. Cleanest, fastest babysit yet.

To read or update your memory, use bash (writes attribute to you):
  SKYLARK_ACTOR=019f565b-64c7-704e-b63b-8acc433d0d53 npm run files -- read agents/babysitter/<file>
  SKYLARK_ACTOR=019f565b-64c7-704e-b63b-8acc433d0d53 npm run files -- write agents/babysitter/<file> --stdin

Keep agents/babysitter/index.md current: it is loaded into your system prompt at the start
of every session, so it should orient a fresh you.
