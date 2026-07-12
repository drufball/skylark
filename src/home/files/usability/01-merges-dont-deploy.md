# 🔴 Merged PRs don't deploy — the ship serves stale code

The single biggest finding tonight. Six PRs (#123–#128) merged to origin/main
over ~4 hours, and the running ship served NONE of them: the serving checkout
(~/prod/skylark, what `npm run dev` runs from) never pulls origin. I only
noticed because a screenshot still showed the TanStack devtools logo that
PR #123 had "removed" hours earlier.

Consequences observed tonight:
- The rogue-triage fix (#126) "merged" but the live waker kept sending the old
  do-work briefing — tilde herself wrote in her memory file that she kept
  receiving instructions the merged code should have removed and guessed
  "legacy phrasing not yet scrubbed, or cached". An agent noticed the deploy
  gap before the humans did.
- Local main also diverges: agent memory writes land as commits on the local
  checkout (29 of them tonight), so a plain `git pull` needs a merge and can
  CONFLICT on memory files (it did — builder + tilde index.md both conflicted;
  I union-merged them by hand).

What I did: fetch + merge origin/main, resolved the two memory-file conflicts,
npm install, db:migrate, merge commit a1459c7. Verified by screenshot (logo
gone).

Discussion: the ship needs a deploy story. Options: (a) an orchestrator step
that fast-forwards/merges the serving checkout after every PR merge (plus
migrate + install when lockfile/migrations changed), (b) a "ship is N commits
behind origin" banner in the UI + a one-click sync, (c) stop committing agent
memories to main (write them somewhere unversioned, or their own branch) so
the serving checkout can always fast-forward. (c) also fixes the conflicts.
