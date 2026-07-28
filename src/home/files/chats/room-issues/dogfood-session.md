# Dogfood session — 2026-07-28

Three issues run today in this chat (room-issues), start to finish:

## 1. #7u5b / #0zis — issue CLI silently swallows `--body`
- #7u5b (PR #161) fixed the case where an unconsumed `--flag` token survives
  into the CLI's argv: now fails loudly instead of joining it into the title.
- @skip found the real-world case still broke: without the `--` separator,
  npm itself swallows `--body <value>` before it ever reaches our argv,
  leaving no `--flag` token to catch — just two bare positionals. Traced it
  to a reliable signal (`process.env.npm_config_body`) and filed #0zis
  (PR #163) to catch that case too. Verified fixed by @skip.
- Along the way, closed junk issues filed while dogfooding: #ihue, #gcaa,
  #tc68, #pexb.

## 2. #souf — change-review CI red on every PR
- The advisory `change-review` workflow passed `--model opus`, which resolved
  to a nonexistent model id and died in ~45s on every PR. Fixed by pinning a
  real model id (PR #163... build merged, see issue for the actual PR number).
- Later noted: the check went red again for an unrelated reason — an expired/
  missing `CLAUDE_CODE_OAUTH_TOKEN` secret, an infra issue the operator is
  handling directly, not a regression of the #souf fix.

## 3. #q6xm — sessions logging crew out too often, especially on mobile
- Traced two real causes: no sliding renewal on the 30-day session TTL, and
  a possible tunnel/LAN origin split (the cookie's `Secure` flag depends on
  `x-forwarded-proto`, and Skylark is reachable both via the https tunnel and
  plain-http LAN). Shipped renewal; @skip verified sessions feel solid now.

## Bonus: #wkh8 — per-chat files (this folder!)
- Filed after the three above: give each chat its own docs subfolder
  (`chats/<chatId>/`) and let a `files` widget default to just that folder,
  without siloing the shared library or losing the ability to point a widget
  at any path. Landed as PR #166 — this file is the first thing written into
  this chat's own folder (`chats/room-issues/`), and a `files` widget pinned
  to it is going up on this chat's canvas right after this.
