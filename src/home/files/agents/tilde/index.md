# tilde — memory index

## Issue system facts
- Issues carry no reference to chat (`originChatId` and `--chat` were removed — decouple-issues-from-chat). CLI: `npm run issue -- new|list|show|comment|handoff|playbooks|status|building|open|done|close` (run with SKYLARK_ACTOR=<my id>).
- An agent wake now lands on its own inbox session (find-or-create by well-known title, `findAgentSessionByTitle` in agent/service.ts), briefed on the whole unread batch. To route an update, use the new chat CLI: `npm run chat -- list|show <id>|post <id> <message>`.
- `npm run chat -- post <chatId> ...` requires the actor to be a member of that chat — use SKYLARK_ACTOR=<my id>.
- CLI arg parsing does NOT handle multi-line/backtick-heavy `--body` well when passed via `$(cat <<'EOF' ... EOF)` directly inline — angle brackets/backticks got eaten as shell redirection in one case even though quoted. Safer: write body to a tmp file first (`cat > /tmp/x.md <<'EOF' ... EOF`), inspect it, then pass `--body "$(cat /tmp/x.md)"`. If a title/body already got mangled, don't bother re-filing — just add a clean `issue comment <id> "$(cat /tmp/x.md)"` with the full text.
- `issue building <id>` kicks off the build playbook (@builder → @babysitter) immediately; multiple issues can build in parallel now (no longer "one build at a time" per the 2026-07-03 note — worth re-verifying gate status if things start colliding).

## UI facts
- src/rigging/views/*.tsx (chat.tsx, agent-chat.tsx, files.tsx, issue-board.tsx, inbox.tsx) all use the list+content split-pane pattern with hardcoded-width `<aside className="w-64|w-72 shrink-0">` — zero responsive breakpoints (no md:/sm:/lg:) anywhere. components/ui only has card/button/input/textarea/scroll-area — no Sheet/Drawer primitive yet.
- src/rigging/views/dock.tsx is the app shell: h-screen flex row, w-16 left nav rail + flex-1 content. Same aside/content-scroll pinning question applies to the dock rail as to each view's own sidebar.
- TanStack Devtools floating widget (bottom-right corner) comes from src/routes/__root.tsx's RootDocument — `<TanStackDevtools config={{position: 'bottom-right'}} .../>`, always rendered, not gated by dev/prod.

## Log
- 2026-07-03 maintenance sweep of the build loop, with @drufball. One build at a time until gates are fixed.
  - #notz → re-filed as #z7ja (vite server.watch.ignored for .claude/worktrees etc., so worktree churn doesn't full-reload the ship / reboot orchestrators). Building.
  - #8cif → re-filed as #uvnm (commit-gate/landing-gate hooks cd to MAIN checkout instead of the invoking worktree; required before parallel builds). Awaiting Build after #z7ja lands.
  - NOTE 2026-07-12: `issue show z7ja`/`uvnm` now 404 — those ids are gone (renamed on land, or db reset?). Don't chase these ids again; if that work still matters, re-check via `issue list`/history instead of assuming these are still in flight.
- 2026-07-12 @drufball asked for mobile-friendly responsive UX for chat + other list+main-content views, plus two more layout bugs. Filed and started building all three (playbook build, parallel):
  - #osy7 — mobile responsive collapsible/floating drawer sidebar for chat/agent-chat/files/issue-board/inbox.
  - #3c5b — remove/gate the TanStack devtools bottom-right widget in __root.tsx.
  - #en2b — sidebar/dock scrolls away with tall content instead of staying pinned (needs independent per-pane scroll containment, min-h-0/overflow fix); same files as #osy7 but distinct desktop bug.
  - Posted summary to chat 019f56f5-a950-706a-93d7-390812ea524e. Watch inbox for build progress/PRs on all three.
