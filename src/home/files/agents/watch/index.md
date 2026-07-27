# @watch memory

## Role
Night watch: survey fleet + board each wake, nudge/escalate anything stuck. Message-only — never edit/build.

## How to look things up
- `npm run agent -- fleet` — session list (no filters needed; --all doesn't change output, ignore it).
- `npm run issue -- list` / `show <nano>` — board.
- Sessions in the DB use `agentSessions` (src/hull/agent/schema.ts) and `issueSessions`/`issues` (src/hull/issues/schema.ts). Query via:
  `node --env-file-if-exists=.env --import tsx -e "import {db} from './src/hull/db/client.ts'; ..."`
  (drizzle `desc()` needs `import {desc} from 'drizzle-orm'` — bare `desc` as a raw string breaks SQL).
- `gh pr list --state open --json ...` / `gh pr view <n> --json statusCheckRollup,comments,reviews` to check real CI vs the advisory "change review" step (which fails on every PR right now because ANTHROPIC_API_KEY is empty in that CI job — not a real failure, ignore it).
- PRs built outside the tracked issue/session flow land under `.claude/worktrees/agent-*` branches (not the usual `worktrees/<branch-name>` convention) — these have NO agent_sessions/issue_sessions row and no baton, so the watchdog/babysitter machinery can't see them. Check `git branch -a` + `git worktree list` for orphaned branches matching an open issue's nano when the issue shows no session activity.

## 2026-07-27 sweep findings
- Fleet: all sessions idle, no stale "running" corpses, no duplicates. Nothing mid-turn stuck.
- Board: most issues closed/done from the big #q5ia watchdog-protocol push (7 PRs merged 07-18/19: #f5io, #69iz, #5vp3, #7an8, #83ph, #l07u, #q9d9). Healthy.
- Found 3 orphaned green-CI PRs with no session tracking, stuck since 07-18/19 (9+ days): #133 (deploy-sync-f70a), #134 (behind-origin-indicator-f70a), #139 (files-sweep-push-fssz). All pass verify/coverage/smoke; only fail the (broken) advisory change-review check. Commented on #f70a and #fssz, handed off #f70a to OWNER (@crawnk) since nothing automatic will ever pick these up (no baton, no session).
- Also open on the board (not yet stuck, just unworked — normal open queue): #spgh (blank pane on client nav), #7u5b (issue CLI arg parsing), #cyj1 (commit-gate wrong cwd), #kp3e (bash tool cwd-deleted), #ljzh (pre-hydration form no-op), #6g2p (conflict-marker guard), #ppf1 (optimistic pending message bug). None had baton/session activity to nudge — just unstarted backlog, not watch's job to poke.

## Gotchas
- `npm run issue -- new "..." --body "..."` needs the `--` separator after `run issue` or npm eats flags (see #7u5b, open, not yet fixed as of 07-27).
- No DATABASE_URL in .env — uses local default (see src/hull/db/url.ts), Postgres via docker compose on 5432.
