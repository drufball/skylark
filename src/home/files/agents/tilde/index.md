# tilde — memory index

## Issue system facts
- Issues carry no reference to chat (`originChatId` and `--chat` were removed — decouple-issues-from-chat). CLI: `npm run issue -- new|list|show|comment|handoff|playbooks|status|building|open|done|close` (run with SKYLARK_ACTOR=<my id>).
- An agent wake now lands on its own inbox session (find-or-create by well-known title, `findAgentSessionByTitle` in agent/service.ts), briefed on the whole unread batch. To route an update, use the new chat CLI: `npm run chat -- list|show <id>|post <id> <message>`.
- `npm run chat -- post <chatId> ...` requires the actor to be a member of that chat — use SKYLARK_ACTOR=<my id>.
- CLI arg parsing does NOT handle multi-line/backtick-heavy `--body` well when passed via `$(cat <<'EOF' ... EOF)` directly inline — angle brackets/backticks got eaten as shell redirection in one case even though quoted. Safer: write body to a tmp file first (`cat > /tmp/x.md <<'EOF' ... EOF`), inspect it, then pass `--body "$(cat /tmp/x.md)"`. If a title/body already got mangled, don't bother re-filing — just add a clean `issue comment <id> "$(cat /tmp/x.md)"` with the full text.
- `issue building <id>` kicks off the build playbook (@builder → @babysitter) immediately; multiple issues can build in parallel now (no longer "one build at a time" per the 2026-07-03 note — worth re-verifying gate status if things start colliding).
- When a build's PR shows red CI, don't just assume the code is broken — `gh pr checks <n>` / `gh run view <id> --log` (or `gh api .../actions/jobs/<id>/logs`) to read the actual failure before commenting. Sometimes it's infra (see npm version drift below), not the diff. After a fix lands, `gh pr checks <n>` takes several minutes to go green (~8min for coverage/verify) — poll with sleep rather than assuming instantly. Once merged, `issue done <id>` doesn't happen automatically — set it manually.

## Build/CI infra facts
- 2026-07-12: hit `npm ci` failing in CI (`EUSAGE ... Missing: lru-cache@x.y.z from lock file`) on an otherwise-trivial PR (#123, issue #3c5b). Root cause: nothing pins the *npm* binary version (only node via `.nvmrc`) — CI gets npm 10.9.8 (bundled with node 22.23.1 via actions/setup-node), but a builder's local/sandbox npm can be newer (e.g. 11.17.0) and produces a lockfile with subtly different optional-dep shape that npm 10.9.8's `npm ci` rejects as out-of-sync. Fix that worked: regenerate `package-lock.json` with `npx npm@10.9.8 install` (or whatever matches CI) before committing — @builder applied this on #3c5b/PR #123 and all checks went green, merged as 2a9ae78. Filed **#iv1t** (now building) to get npm pinned properly (packageManager/corepack) so it stops recurring on future PRs — check its status/PR before assuming future lockfile failures are code bugs.

## UI facts
- src/rigging/views/*.tsx (chat.tsx, agent-chat.tsx, files.tsx, issue-board.tsx, inbox.tsx) all use the list+content split-pane pattern with hardcoded-width `<aside className="w-64|w-72 shrink-0">` — zero responsive breakpoints (no md:/sm:/lg:) anywhere. components/ui only has card/button/input/textarea/scroll-area — no Sheet/Drawer primitive yet.
- src/rigging/views/dock.tsx is the app shell: h-screen flex row, w-16 left nav rail + flex-1 content. Same aside/content-scroll pinning question applies to the dock rail as to each view's own sidebar.
- TanStack Devtools floating widget in __root.tsx's RootDocument: REMOVED. Landed via #3c5b/PR #123 (merged 2a9ae78) — confirmed gone from src/routes/__root.tsx on main. Issue closed done.

## Log
- 2026-07-03 maintenance sweep of the build loop, with @drufball. One build at a time until gates are fixed.
  - #notz → re-filed as #z7ja (vite server.watch.ignored for .claude/worktrees etc.). NOTE 2026-07-12: `issue show z7ja`/`uvnm` now 404 — those ids are gone. Don't chase, re-check via `issue list` if it still matters.
- 2026-07-12 @drufball asked for mobile-friendly responsive UX for chat + other list+main-content views, plus two more layout bugs. Filed and started building all three (playbook build, parallel):
  - #osy7 — mobile responsive collapsible/floating drawer sidebar for chat/agent-chat/files/issue-board/inbox. Still building, no updates yet as of last check.
  - #3c5b — remove the TanStack devtools bottom-right widget in __root.tsx. DONE — PR #123 merged (2a9ae78) after fixing an npm-version-drift lockfile CI failure (see Build/CI infra facts). Closed done.
  - #en2b — sidebar/dock scrolls away with tall content instead of staying pinned; same files as #osy7 but distinct desktop bug. Still building, no updates yet as of last check.
  - #iv1t — follow-up filed from the #3c5b investigation: pin npm version (packageManager/corepack) so the lockfile-drift CI failure doesn't recur. Now building.
  - Posted summaries to chat 019f56f5-a950-706a-93d7-390812ea524e as each thing lands. Watch inbox for #osy7/#en2b/#iv1t progress.
