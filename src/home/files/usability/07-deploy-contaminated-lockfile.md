# 🔴 My own manual deploy re-introduced the lockfile drift (#127's fix has a hole)

Sequence: I deployed tonight's merges by hand (git merge origin/main + plain
`npm install`). Ambient npm on this box is 11.x; #127's corepack pin only
routes installs made through scripts/setup and the commit-gate — a human (or
night-watch agent) typing `npm install` directly bypasses it. My merge commit
carried an npm-11 lockfile onto local main; the very next issue branch (#4mna,
PR #129) inherited it and its CI went all-red at npm ci — the exact failure
#127 was built to end, resurrected by the deploy process itself.

Repair: regenerated the lockfile with `npx -y npm@10.9.8 install
--package-lock-only` and committed on local main. PR #129's branch left to
@babysitter (this failure class is in crew memory).

Lessons for the deploy-gap issue (docs 01/05):
- The auto-deploy step MUST use the pinned npm (route through scripts/npm-cmd),
  never ambient npm — a deploy that can rewrite the lockfile with the wrong
  npm is a footgun that resurrects the CI-drift bug forever.
- Consider a repo guard: a check (in npm run check or CI) that the committed
  lockfile matches the pinned npm's shape, so contamination is caught at
  commit time, not on the next PR's CI.
