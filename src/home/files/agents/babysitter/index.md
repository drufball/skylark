# babysitter memory

## Role
I shepherd open PRs to merge (babysit-pr skill) and triage inbox updates
(issue status moves, PR check results) routing them to the chat where the
work was planned. I never write code — code fixes go to @builder; blocked
merges (branch protection, required review, or 2nd builder round-trip on
same PR) go to OWNER.

## Chat access
`npm run chat -- list/show/post` is scoped by chat membership (RLS) —
I (babysitter) am often not a member of the chat where work was originally
planned (e.g. drufball+tilde chats). If `chat list` shows "No chats" or
`show` says "not a member of this chat", there's no chat I can post to —
per instructions that's fine, just do nothing for the routing step.

## Verifying a merge actually landed clean
- `gh pr view <n> --json state,mergedAt,statusCheckRollup,title,headRefName`
  — check state == MERGED and every check conclusion == SUCCESS.
- Cross-check the fix commit is actually in the merged tip:
  `git log <branch> --oneline` and `git show origin/main:<file> | grep ...`
  to confirm regenerated files (e.g. package-lock.json) match main post-merge.
- DB is reachable via `docker exec skylark-db-1 psql -U postgres -d skylark -c "..."`
  when I need ground truth beyond the CLI doors (e.g. who's a member of what chat).

## Issue CLI notes
- `npm run issue -- done <id>` errors "Illegal issue transition: done → done"
  if already done — harmless, just confirms it's already closed out. The
  issue `list` view can show a stale/cached status icon briefly after a
  move; `issue show <id>` is the source of truth.
- Comment before transitioning if you want a durable note of what was
  verified (`npm run issue -- comment <id> "..."`).

## Case log
- 2026-07-12: PR #123 (remove TanStack devtools logo, issue #3c5b) had CI
  all-red on a stale package-lock.json (npm version drift: local npm 11.x
  vs CI's npm 10.9.8 via node 22/.nvmrc). @tilde filed #59vb, diagnosed root
  cause, regenerated the lockfile with npm 10.9.8, pushed fix commit
  027a1bb. CI went green (verify/coverage/smoke all SUCCESS), PR merged as
  2a9ae78. #59vb already correctly marked done by tilde by the time I
  reviewed — I added a confirming comment. No follow-up needed; #iv1t
  already tracks the systemic root cause (pin npm via packageManager/corepack).
  Neither babysitter nor builder were members of the chat where this was
  planned (drufball+tilde's "Mobile UI" chat) — nothing to post there.
