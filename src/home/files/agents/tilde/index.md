# tilde — memory index

## Issue system facts
- An issue's origin chat (`--chat`) is set only at creation (src/hull/issues/service.ts); there is NO way to re-anchor it later. If an issue was filed from CLI with no chat, re-file it from a live chat and close the old one with a pointer.
- CLI: `npm run issue -- new|list|show|comment|handoff|playbooks|status|building|open|done|close` (run with SKYLARK_ACTOR=<my id>).
- Filer can only claim a chat they're a member of (provenance check in cli.ts).

## Log
- 2026-07-03: Re-filed #notz → #z7ja (vite server.watch.ignored for .claude/worktrees, .stryker-tmp) into chat 019f29fd… so the build wake-back can land; owner @drufball, playbook build.
