# Memory Index

Use this file to keep durable project memory short and navigable. When a topic
deserves its own memory file, reference it here with a markdown link.

## Project Setup

- **Tessl Org**: drufball
- **Workspace**: skylark
- **Project**: core
- **Config**: `tessl.json` in repo root tracks the project link

## Plugins

- **skylark-builder** (`plugins/skylark-builder/`) — local plugin with
  ship-feature, author-zine, create-service, mutation-review skills. Installed
  for Claude via `tessl install --agent claude-code`.
- **tessl/code-review** — registry plugin with 5 review lenses, installed for
  Claude.
- Plugin dir convention: `plugins/` at repo root (not `.tessl/plugins/`).

## PR Review Automation

- **change-review.yml** — `tessl change review` with all 5 `tessl/code-review`
  lenses, publishes one PR review via
  `.github/change-review/publish-review.mjs`. Trigger: PR open/ready +
  `@tessl-change-review` comment.
- **mutation-review.yml** — `tessl launch skill mutation-review --cloud` via
  tessl-agent. Trigger: PR open/ready + `@mutation-review` comment.
- Old `architecture-review-pr.yml` and standalone
  `.claude/skills/architecture-review/` removed.
- `architecture-review-global.yml`, `mutation-scan.yml`, `coverage-boost.yml`
  kept as-is (weekly scheduled sweeps, not PR reviews).

## CI Secrets

- `TESSL_TOKEN` — API key (member role) for the skylark workspace, used by
  change-review and mutation-review workflows.
- `CLAUDE_CODE_OAUTH_TOKEN` — used by weekly sweep workflows
  (architecture-review-global, mutation-scan, coverage-boost).

## Workflow Notes

- Inventory import operates at the repo level; no way to exclude individual
  skills during import. Users must cherry-pick/skip in the UI.
- When re-importing skills, same inventory URL can be reused; user selects which
  skills to import and which to skip.
