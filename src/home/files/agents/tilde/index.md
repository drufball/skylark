# tilde — memory index

## Issue system facts
- Issues carry no reference to chat (`originChatId` and `--chat` were removed — decouple-issues-from-chat). CLI: `npm run issue -- new|list|show|comment|handoff|playbooks|status|building|open|done|close` (run with SKYLARK_ACTOR=<my id>).
- An agent wake now lands on its own inbox session (find-or-create by well-known title, `findAgentSessionByTitle` in agent/service.ts), briefed on the whole unread batch. To route an update, use the new chat CLI: `npm run chat -- list|show <id>|post <id> <message>`.
- `npm run chat -- post <chatId> ...` requires the actor to be a member of that chat — use SKYLARK_ACTOR=<my id> and if "not a member" comes back, that's the tell, not a hard blocker (still posted fine once actor env was set correctly).

## UI facts
- src/rigging/views/*.tsx (chat.tsx, agent-chat.tsx, files.tsx, issue-board.tsx, inbox.tsx) all use the list+content split-pane pattern with hardcoded-width `<aside className="w-64|w-72 shrink-0">` — zero responsive breakpoints (no md:/sm:/lg:) anywhere. components/ui only has card/button/input/textarea/scroll-area — no Sheet/Drawer primitive yet.

## Log
- 2026-07-03 maintenance sweep of the build loop, with @drufball. One build at a time until gates are fixed.
  - #notz → re-filed as #z7ja (vite server.watch.ignored for .claude/worktrees etc., so worktree churn doesn't full-reload the ship / reboot orchestrators). Building.
  - #8cif → re-filed as #uvnm (commit-gate/landing-gate hooks cd to MAIN checkout instead of the invoking worktree; required before parallel builds). Awaiting Build after #z7ja lands.
- 2026-07-12 @drufball asked for mobile-friendly responsive UX for chat + other list+main-content views. Filed #osy7 (collapsible/floating drawer sidebar below md breakpoint, shared component/hook across chat/agent-chat/files/issue-board/inbox). Posted summary to chat 019f56f5-a950-706a-93d7-390812ea524e. Watch for it landing on Build.
