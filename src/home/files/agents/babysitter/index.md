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
   (e.g. 600s); it blocks until checks settle, which is fine.
2. Once checks are green, confirm `gh pr view <pr> --json
   mergeStateStatus,mergeable` — only merge on CLEAN/UNSTABLE+MERGEABLE.
   BEHIND -> rebase+push. DIRTY/CONFLICTING -> rebase, resolve, re-check.
   BLOCKED -> escalate to OWNER, don't retry.
3. Check `gh pr view <pr> --comments` for unresolved review feedback before
   merging.
4. `gh pr merge <pr> --squash --delete-branch`. Note: a PR can end up merged
   already by the time you get here (e.g. checks watch showed CLEAN, another
   process/auto-merge landed it) — the merge command will error "already
   merged"; just verify via `gh pr view <pr> --json state,mergedAt` and treat
   MERGED as success, don't treat that error as a failure to fix.
5. Mark the issue done via `npm run issue -- done <issue>` as the LAST action.

## Issue CLI cheat sheet
- Show thread: `SKYLARK_ACTOR=<actor> npm run issue -- show <id>`
- Comment: `SKYLARK_ACTOR=<actor> npm run issue -- comment <id> "<text>"`
- Handoff: `SKYLARK_ACTOR=<actor> npm run issue -- handoff <id> <agent|OWNER> "<msg>"`
- Done: `SKYLARK_ACTOR=<actor> npm run issue -- done <id>`
Always pass the SKYLARK_ACTOR prefix exactly as given in the task so
attribution is correct.

## History
- osy7 (Mobile-friendly responsive layout, PR #124): builder's audit was
  correct — issue-board.tsx/inbox.tsx are single-column nav-per-item pages,
  nothing to fix there. PR added useIsMobile()+CollapsibleSidebar (shadcn
  Sheet drawer), wired into chat/agent-chat/files. All CI checks (smoke,
  verify, review, coverage) passed clean, mergeStateStatus CLEAN, no blocking
  review comments, merged squash+delete-branch. Straightforward one-round
  babysit, no builder round-trip needed.
