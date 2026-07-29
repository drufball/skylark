
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
   UPDATE 2026-07-28: a real `background` tool IS available now (job-based,
   auto-resumes you with output, plus periodic night-watch health-check
   pings) — use it instead of foreground-blocking on long watches.
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
- The `review` (change review) check can fail for reasons that have nothing to
  do with your PR: it's an agentic Claude-Code-action review that itself can
  hit infra errors (e.g. `is_error:true` after ~2s with no real output, no
  actual review content posted). Before treating a review-check failure as a
  real finding to fix, check `gh run list --workflow <name> --limit 10` — if
  many/most recent runs across *other* PRs are also failing the same way, it's
  a repo-wide infra blip, not something raised about your diff. Confirm no
  review comment was actually posted (`gh pr view <pr> --comments`), then
  treat `review` as the advisory check it's documented to be and proceed to
  merge on smoke/coverage/verify passing + mergeStateStatus
  CLEAN/UNSTABLE+MERGEABLE. Rerunning the job once (`gh run rerun <run-id>
  --job <job-id>`) is worth trying but don't block on it repeating cleanly.

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
- jgdb (agent show <session-id> CLI, PR #130): builder's PR was clean going in
  (881 tests, 100% diff coverage on both changed service files, no schema
  drift, manually smoke-tested prefix-match/no-match/ambiguous-prefix cases
  against real local DB). Watched checks: review/smoke/coverage/verify all
  passed on the first run, no flake, no rebase needed. mergeStateStatus
  CLEAN/MERGEABLE, no review comments. Squash-merged in one round, no
  builder round-trip. Usual --delete-branch local-checkout-collision error
  (merge itself succeeded, mergedAt confirmed) — this time the remote branch
  was still present after fetch --prune, so had to `git push origin --delete`
  manually (unlike zo3a where gh had already deleted it).
- 7u5b (Issue CLI --body/oversized-title silent-swallow fix, PR #161):
  smoke/coverage/verify all passed clean, no rebase needed. The `review`
  check failed repeatedly (tried once via `gh run rerun --job`, failed again)
  with `is_error:true` after ~2s and zero posted comments — checked
  `gh run list --workflow` and found the *last ~10* change-review runs across
  the whole repo (other PRs too) were failing identically, confirming a
  repo-wide Claude-Code-action infra blip that day, not a finding about this
  diff. No review comments posted, no branch protection (404 on branch
  protection API), mergeStateStatus UNSTABLE/MERGEABLE (UNSTABLE = only the
  advisory review is red) → merged squash per policy. --delete-branch hit the
  usual worktree-collision error; remote branch was still present after
  fetch --prune so deleted manually. No builder round-trip needed — this is
  the first time I merged with the review check outright failing (not just
  flaky-slow); documented the reasoning above for future reference.
- 0zis (npm-swallows-flag-with-no-leftover-token fix via npm_config_* env
  check, PR #163, follow-up to 7u5b): smoke/coverage/verify all passed clean
  on the first run, no rebase needed, mergeStateStatus UNSTABLE/MERGEABLE.
  `review` failed again with the same is_error:true/~2s/no-comments signature
  as 7u5b's PR #161 the day before — checked `gh run list --workflow "Change
  review" --limit 10` and found all 10 most recent runs across the whole repo
  failing identically, confirming another repo-wide infra blip (same
  Claude-Code-action issue, persisting across days now). No review comments
  posted, no branch protection. Merged squash per policy. --delete-branch hit
  the usual worktree-collision error; remote branch still present after
  fetch --prune so deleted manually. No builder round-trip needed.
- souf (Fix change-review CI perma-red: pin --model to claude-opus-4-8 instead
  of floating 'opus' alias, PR #164): builder's fix pinned a real model ID in
  change-review.yml/architecture-review-global.yml/mutation-scan.yml (the
  'opus' alias was resolving to nonexistent claude-opus-5, breaking the
  advisory review check on every PR — this explains the repeated
  is_error:true/no-comments review failures seen on 7u5b/0zis). Added
  src/workflows.test.ts regression test scanning workflow claude_args for
  bare floating aliases. This was the rare case where the PR's own
  change-review run *was* the verification the issue asked for: watched it go
  green (12s pass) alongside smoke/verify/coverage, confirming the fix works
  live. mergeStateStatus CLEAN/MERGEABLE, no review comments, squash-merged
  in one round, no builder round-trip needed. Usual --delete-branch
  worktree-collision error (merge succeeded per mergedAt); remote branch
  still present so deleted manually. Going forward, don't assume every red
  `review` check is infra noise — check if there's an open fix PR like this
  one first.
- q6xm (Sliding session renewal + canonical-origin redirect, PR #165):
  smoke/verify/coverage all passed clean, no rebase needed,
  mergeStateStatus UNSTABLE/MERGEABLE. `review` failed with the usual
  is_error:true/~2s/no-comments signature. This time I actually checked
  whether souf's model-pin fix (#164, merged ~2.5h earlier) had fixed it: it
  hadn't fully — souf's own PR *skipped* the review job entirely (GitHub
  "workflow validation failed... will begin working once you merge your PR"
  — a workflow-file-editing PR can't get its own new workflow content
  exercised on itself), so the fix was never actually live-verified before
  merging, and post-merge the review job is still failing identically on
  every PR since (confirmed via `gh run list --workflow "Change review"
  --limit 100`, checking `"model"` in each run's SDK-options log line — every
  post-souf run still shows `"model": "opus"` un-pinned, not
  `claude-opus-4-8`; only souf's own skipped run and q6xm's manual rerun ever
  saw the pinned id, and even the pinned id run still failed with the same
  is_error:true 2s-later — so pinning the model was NOT the actual root
  cause, or at least isn't sufficient). Tried `gh run rerun --job` once on
  q6xm's review job — failed again identically even with the model pin
  applied. No review comments ever posted across dozens of runs going back
  weeks. No branch protection (404). Treated `review` as advisory per policy
  and merged squash on smoke/verify/coverage green +
  UNSTABLE/MERGEABLE. --delete-branch hit the usual worktree-collision
  error; remote branch still present after fetch --prune so deleted
  manually. No builder round-trip needed for q6xm's own diff.
  IMPORTANT FOR NEXT TIME: souf's fix (PR #164) does NOT appear to have
  actually resolved the change-review perma-red — worth flagging to OWNER
  or @builder next time this comes up, since is_error:true persists even
  with `--model claude-opus-4-8` pinned (e.g. q6xm's rerun at 16:17:49 UTC
  used the pinned id and still failed in ~2s). The real cause may be
  something else entirely (auth/quota/action-version issue), not the opus
  alias.
- wkh8 (Per-chat files subfolder + turnContext shortcut, PR #166):
  smoke/verify/coverage all passed clean, no rebase needed. `review` failed
  again with the same repo-wide advisory infra blip confirmed via `gh run
  list --workflow "Change review" --limit 10` (9/10 recent runs across
  unrelated PRs failing identically, no comments posted) — souf's #164 model
  pin still hasn't fixed the underlying issue as of this date, consistent
  with q6xm's finding. mergeStateStatus went UNKNOWN transiently right after
  checks settled, then UNSTABLE/MERGEABLE on recheck. No review comments, no
  branch protection. Squash-merged in one round, no builder round-trip
  needed. Usual --delete-branch worktree-collision error (merge succeeded per
  mergedAt); remote branch still present so deleted manually.
- wkh8 (Per-chat files subfolder + turnContext shortcut, PR #166):
  smoke/verify/coverage all passed clean, no rebase needed. `review` failed
  again with the same repo-wide advisory infra blip confirmed via `gh run
  list --workflow "Change review" --limit 10` (9/10 recent runs across
  unrelated PRs failing identically, no comments posted) — souf's #164 model
  pin still hasn't fixed the underlying issue as of this date, consistent
  with q6xm's finding. mergeStateStatus went UNKNOWN transiently right after
  checks settled, then UNSTABLE/MERGEABLE on recheck. No review comments, no
  branch protection. Squash-merged in one round, no builder round-trip
  needed. Usual --delete-branch worktree-collision error (merge succeeded per
  mergedAt); remote branch still present so deleted manually.
- 933f (Notifications rail entry / dock.tsx fifth destination, PR #174):
  smoke/verify/coverage all passed clean on first watch, no rebase needed.
  NOTE: no `review` workflow check present on this run at all — `gh workflow
  list` shows only format/lint/knip/typecheck/test as the active workflow
  now, no separate "Change review" workflow — so the long-running advisory
  review perma-red saga (souf #164, q6xm, wkh8) is moot here, nothing to
  weigh. mergeStateStatus CLEAN/MERGEABLE, no PR comments. Squash-merged in
  one round, no builder round-trip needed. Usual --delete-branch
  worktree-collision error (merge succeeded per mergedAt); remote branch
  still present after fetch --prune so deleted manually.
- wkh8 (Per-chat files subfolder + turnContext shortcut, PR #166):
  smoke/verify/coverage all passed clean, no rebase needed. `review` failed
  again with the same repo-wide advisory infra blip confirmed via `gh run
  list --workflow "Change review" --limit 10` (9/10 recent runs across
  unrelated PRs failing identically, no comments posted) — souf's #164 model
  pin still hasn't fixed the underlying issue as of this date, consistent
  with q6xm's finding. mergeStateStatus went UNKNOWN transiently right after
  checks settled, then UNSTABLE/MERGEABLE on recheck. No review comments, no
  branch protection. Squash-merged in one round, no builder round-trip
  needed. Usual --delete-branch worktree-collision error (merge succeeded per
  mergedAt); remote branch still present so deleted manually.
- 933f (Notifications rail entry / dock.tsx fifth destination, PR #174):
  smoke/verify/coverage all passed clean on first watch, no rebase needed.
  NOTE: no `review` workflow check present on this run at all — `gh workflow
  list` shows only format/lint/knip/typecheck/test as the active workflow
  now, no separate "Change review" workflow — so the long-running advisory
  review perma-red saga (souf #164, q6xm, wkh8) is moot here, nothing to
  weigh. mergeStateStatus CLEAN/MERGEABLE, no PR comments. Squash-merged in
  one round, no builder round-trip needed. Usual --delete-branch
  worktree-collision error (merge succeeded per mergedAt); remote branch
  still present after fetch --prune so deleted manually.
- 0eyx (Config room: playbooks/models/personas front door, PR #176):
  smoke/verify/coverage all passed clean (coverage took ~6m to register as
  pending->pass, others faster), no rebase needed. mergeStateStatus briefly
  UNKNOWN right after checks settled then CLEAN/MERGEABLE on recheck. No
  review comments (no `review` workflow check present on this run, same as
  933f — repo currently has no separate Change-review workflow active). No
  builder round-trip needed. Usual --delete-branch worktree-collision error
  (merge succeeded per mergedAt); remote branch still present after fetch
  --prune so deleted manually.
