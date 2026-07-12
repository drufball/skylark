# Builder Memory Index

## Recent Work

### Issue #3c5b: Remove TanStack devtools logo (PR #123)
- **Status**: PR open, handed to @babysitter
- **What**: Removed the always-rendered `TanStackDevtools` panel (bottom-right
  floating widget) from `RootDocument` in `src/routes/__root.tsx`; dropped the
  now-unused `@tanstack/react-devtools` + `@tanstack/react-router-devtools`
  packages. Kept `@tanstack/devtools-vite` (separate Vite plugin, dev-only by
  its own default, wired in `vite.config.ts` — unrelated to the UI widget).
- **Red-green test**: added a Playwright smoke assertion in
  `e2e/smoke-boot.spec.ts` that `#tanstack_devtools` (the panel's real mount-
  point id, found by reading `@tanstack/react-devtools`'s source in
  node_modules) never appears on a real page. Confirmed it failed against the
  old code, passed after the fix.
- **Env/tooling gotcha**: in this sandbox, `git push`/`gh pr create` initially
  failed ("could not read Username", "not logged into any GitHub hosts") even
  though a `gh` keyring credential existed (`security dump-keychain` showed
  `svce="gh:github.com"`, `gh auth status` succeeded). Fix: run
  `gh auth setup-git` once per session/worktree to wire gh's credential into
  git's credential helper — then `git push` and `gh pr create` both work.
  `gh pr create --body "$(cat <<'EOF' ...)"` heredoc-in-substitution can choke
  bash quoting; write the body to a temp file and use `--body-file` instead.
- **Playwright note**: smoke tests need browsers installed once per box —
  `npx playwright install chromium --with-deps` (~170MB download) before
  `npm run smoke` or `npx playwright test e2e/...` will work.

### Issue #mp1q: Local-time formatter for inbox timestamps (PR #83)
- **Status**: PR open, handed to @babysitter
- **What**: Replaced UTC string surgery in inbox view with a proper formatter
- **Implementation**: 
  - Created `src/rigging/lib/format-local-time.ts` with `formatLocalTime()` function
  - Added comprehensive tests in `format-local-time.test.ts`
  - Updated `src/rigging/views/inbox.tsx` to use the formatter
- **Pattern**: Formatters live in `src/rigging/lib/` with co-located tests
- **Testing note**: Local .env with ANTHROPIC_API_KEY causes some agent runtime tests to fail (test isolation issue). Run tests with `ANTHROPIC_API_KEY= npm run check` to avoid this.

## Ship Knowledge

### Testing
- Follow red-green TDD: write failing test first, then implement
- Tests run on PGlite (in-memory), no external DB needed
- Coverage gates: global threshold + diff coverage on PRs
- Run `npm run check` before committing (format, lint, knip, typecheck, test)
- Smoke tests (`npm run smoke` / Playwright) need a real local Postgres
  (`npm run db:up`) and browsers installed once per box
  (`npx playwright install chromium --with-deps`). Good for red-green testing
  UI-shell-level things (root document, always-on widgets) that don't have a
  natural unit-test home.

### Structure
- **Rigging layer** (`src/rigging/`): UI components, views, formatters
- **Hull layer** (`src/hull/`): Core services, business logic
- **Home layer** (`src/home/`): Routes, pages, glue code
- Utilities go in `lib/` directories within each layer
- `src/routes/__root.tsx`'s `RootDocument` is the actual HTML shell
  (`<html>/<head>/<body>`) every route renders into — the right place to
  remove/gate anything "on every page" (widgets, scripts, devtools).

### Build Loop (build-feature skill)
1. Red-green TDD: test first, then implementation
2. `npm run check` clean
3. Commit (commit-gate auto-runs check)
4. Push
5. Open PR via `gh pr create`
6. Hand off via issue CLI: `SKYLARK_ACTOR=<id> npm run issue -- handoff <issue> babysitter "<message>"`
7. Stop (babysitter shepherds CI and merge)

### Environment gotchas (this sandbox)
- If `git push`/`gh pr create` fail with credential errors despite `gh auth
  status` succeeding, run `gh auth setup-git` first — it wires the gh keyring
  credential into git's credential helper.
- `gh pr create --body "$(cat <<'EOF' ... EOF)"` can trip bash's heredoc
  parsing when passed through certain shells/tools; write the PR body to a
  temp file and use `--body-file /tmp/whatever.md` instead — more reliable.
