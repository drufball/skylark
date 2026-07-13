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
  (src/hull/agent/cli.ts). As of #jgdb (filed 2026-07-13), asked for
  `agent show <session-id> [--tail N]` to inspect a session without raw SQL —
  header (title/status/lastMessageAt), counts (messages/tool-calls), transcript
  tail with role labels. Check issue status before re-filing similar asks.
- Issue/session ids: UUIDv7, but short prefixes (like `jgdb`, `4mna`, `zo3a`) work
  everywhere as refs — resolveIssueRef in src/hull/issues/service.ts is the pattern.
- Chat CLI: `npm run chat -- post <chat-id> "<msg>"` — post follow-ups to the
  thread I was invoked from once filed work updates land in my inbox session.

## Open work I've filed / am tracking
- #4mna (spring cleaning item 1, filed by @tilde) — issue board status line
  honesty (busy/waiting-on-background/stalled). Merged as PR #129 (root cause:
  progress.ts's issuesProgressLine flattened turn_end/agent_end to "thinking…").
  Watch out: a manual main-merge on that PR reintroduced the #iv1t lockfile-drift
  CI failure by resolving package-lock.json toward the stale pre-#iv1t shape
  instead of main's — fix is regenerate from main / `npx npm@10.9.8 install
  --package-lock-only`. If I see that failure pattern again, that's the fix.
- #jgdb (spring cleaning item 2, filed 2026-07-13) — `npm run agent show
  <session-id>` CLI for fleet triage. Started with build playbook. Route updates
  here when builder/babysitter post progress.

## Key files for this domain
- src/hull/agent/cli.ts — the agent CLI door (new/send/list/cancel/seed/extensions).
- src/hull/agent/service.ts — persistence: createSession/getSession/listSessions/
  getMessages/appendMessage. getMessages returns ALL messages ascending by seq
  (no tail-limit query existed as of #jgdb).
- src/hull/agent/schema.ts — agentSessions (status/lastMessageAt/error/title),
  agentMessages (opaque pi.dev AgentMessage JSON blob per row, seq-ordered).
- src/hull/agent/progress.ts — turns AgentSessionEvent into display strings;
  has truncate(), toolExecutionDetail(), backgroundToolLabel() (added for #4mna).
- src/hull/issues/service.ts — resolveIssueRef (prefix matching), resolveStatusWord.
- src/hull/issues/playbooks.ts — playbook = roster + entrypoint; `build` is default.
