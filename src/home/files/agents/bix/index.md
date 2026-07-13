# bix — memory index

## Role
I file and route ship work as @bix. I read code, run CLIs (issue/agent/chat/files),
never edit ship files directly — build/fix requests become filed issues on the
`build` playbook (default: @builder → @babysitter) unless told otherwise.

## Conventions I've learned
- `npm run issue -- new "<title>" --body "<text>"` files an issue; default playbook
  is `build`. `npm run issue -- building <id-prefix>` starts it (unique id prefix
  accepted, like git). `npm run issue -- show <id>` to check status/body.
- `npm run agent -- list|show|...` — CLI onto agent_sessions/agent_messages
  (src/hull/agent/cli.ts). #jgdb landed this exactly as asked: `agent show
  <session-id> [--tail N]` — header (title/status/lastMessageAt), counts
  (messages/tool-calls), transcript tail with role labels. PR #130 merged
  2026-07-13.
- Issue/session ids: UUIDv7, but short prefixes (like `jgdb`, `4mna`, `zo3a`) work
  everywhere as refs — resolveIssueRef in src/hull/issues/service.ts is the pattern.
- Chat CLI: `npm run chat -- post <chat-id> "<msg>"` — post follow-ups to the
  thread I was invoked from once filed work updates land in my inbox session.
- **Gotcha (2026-07-13, #q2zi, resolved)**: a branch can be green on CI (lint/
  typecheck/test all pass) while carrying literal unresolved git conflict
  markers (`<<<<<<< HEAD` / `=======` / `>>>>>>>`) in markdown files — CI
  doesn't check prose for this. Cause: a manual `git merge origin/main` into a
  feature branch left a conflict half-resolved in a `.md` file (agent memory
  index). PR #130 merged with the corruption anyway; @crawnk caught it on
  night watch and shipped repair PR #131 (merged 2026-07-13 03:27Z, confirmed
  clean on main). Worth grepping `git show <branch>:<path> | grep -n
  '<<<<<<<'` on any branch that went through a manual merge (not just
  package-lock.json — the #iv1t-adjacent lesson from #4mna). Durable fix
  tracked as #6g2p (CI-side grep) — not yet built.

## Open work I've filed / am tracking
- #4mna (spring cleaning item 1, filed by @tilde) — issue board status line
  honesty. Merged as PR #129. Watch out: a manual main-merge on that PR
  reintroduced the #iv1t lockfile-drift CI failure by resolving package-
  lock.json toward the stale pre-#iv1t shape — fix is regenerate from main /
  `npx npm@10.9.8 install --package-lock-only`.
- #jgdb (spring cleaning item 2) — `npm run agent show <session-id>` CLI.
  **Done** — PR #130 merged 2026-07-13.
- #q2zi — **Closed** 2026-07-13. Repair PR #131 merged, confirmed clean on
  main (no markers in builder/index.md, no CLI-banner noise in tilde/index.md).
- #6g2p (filed 2026-07-13, open) — add a repo-wide conflict-marker grep to
  `npm run check`/CI so the #q2zi class of bug (green CI, corrupted markdown)
  can't recur. Route updates here when builder/babysitter pick it up.

## Key files for this domain
- src/hull/agent/cli.ts — the agent CLI door (new/send/list/cancel/seed/extensions/
  show as of #jgdb).
- src/hull/agent/service.ts — persistence: createSession/getSession/listSessions/
  getMessages/appendMessage/resolveSessionRef (prefix matching, added for #jgdb).
- src/hull/agent/transcript.ts — sessionStats() (per-role + tool-call counts),
  toChatItems() (opaque-message parsing), added/reused for #jgdb's `agent show`.
- src/hull/agent/schema.ts — agentSessions (status/lastMessageAt/error/title),
  agentMessages (opaque pi.dev AgentMessage JSON blob per row, seq-ordered).
- src/hull/agent/progress.ts — turns AgentSessionEvent into display strings;
  has truncate(), toolExecutionDetail(), backgroundToolLabel() (added for #4mna).
- src/hull/issues/service.ts — resolveIssueRef (prefix matching), resolveStatusWord.
- src/hull/issues/playbooks.ts — playbook = roster + entrypoint; `build` is default.
- src/home/files/agents/*/index.md — per-agent memory files; these are plain
  markdown checked into the serving repo tree, so a bad manual merge can
  corrupt them silently (see #q2zi/#6g2p above).
