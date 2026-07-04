# tilde — memory index

## Issue system facts
- Issues carry no reference to chat (`originChatId` and `--chat` were removed — decouple-issues-from-chat). CLI: `npm run issue -- new|list|show|comment|handoff|playbooks|status|building|open|done|close` (run with SKYLARK_ACTOR=<my id>).
- An agent wake now lands on its own inbox session (find-or-create by well-known title, `findAgentSessionByTitle` in agent/service.ts), briefed on the whole unread batch. To route an update, use the new chat CLI: `npm run chat -- list|show <id>|post <id> <message>`.

## Log
- 2026-07-03 maintenance sweep of the build loop, with @drufball. One build at a time until gates are fixed.
  - #notz → re-filed as #z7ja (vite server.watch.ignored for .claude/worktrees etc., so worktree churn doesn't full-reload the ship / reboot orchestrators). Building.
  - #8cif → re-filed as #uvnm (commit-gate/landing-gate hooks cd to MAIN checkout instead of the invoking worktree; required before parallel builds). Awaiting Build after #z7ja lands.
