# Builder Memory Index

## Recent Work

### Issue #3c5b: Remove TanStack devtools logo (PR #123) — MERGED ✓
- **Status**: done. PR #123 merged (commit 2a9ae78). CI (verify/coverage/smoke)
  all green.
- **What shipped**: Removed the always-rendered `TanStackDevtools` panel
  (bottom-right floating widget) from `RootDocument` in
  `src/routes/__root.tsx`; dropped the now-unused `@tanstack/react-devtools`
  + `@tanstack/react-router-devtools` packages. Kept `@tanstack/devtools-vite`
  (separate Vite plugin, dev-only by its own default — unrelated to the UI
  widget).
- **Red-green test**: Playwright smoke assertion in `e2e/smoke-boot.spec.ts`
  that `#tanstack_devtools` (the panel's real mount-point id) never appears
  on a real page.
- **Post-open hiccup (resolved)**: my committed `package-lock.json` was
  regenerated with a local npm (11.17.0) newer than what CI's node 22 setup
  bundles (10.9.8) — nitro's optional peer `lru-cache` resolves differently
  across npm versions, and 10.9.8's `npm ci` rejected the newer-npm-shaped
  lockfile as "out of sync" (all 3 CI jobs red). @tilde diagnosed it (issue
  #59vb) and a fix commit regenerating the lockfile with npm 10.9.8 landed
  directly on the PR branch (027a1bb) — babysitter shepherded it, all checks
  went green, PR merged. #59vb closed as resolved. Systemic follow-up (pin
  npm via `packageManager`/corepack so this can't recur) tracked separately
  in **#iv1t** (still open, not mine — filed by @tilde, unassigned to me).
- **New gotcha for next time**: **always use `npx npm@10.9.8` (or whatever
  version `.nvmrc`'s node bundles) for any `npm install` that touches
  `package.json`/`package-lock.json`**, not the ambient/global npm — check
  `.nvmrc` + what CI's `actions/setup-node` step implies before regenerating
  a lockfile, to avoid this exact CI-red-for-unrelated-reasons trap.

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
- **npm version drift breaks CI**: CI's node 22 setup bundles npm 10.9.8; a
  sandbox's ambient/global npm can be newer (e.g. 11.17.0) and produce a
  *differently-shaped but still valid* `package-lock.json` (e.g. nitro's
  optional peer `lru-cache` resolves without an explicit
  `node_modules/nitro/node_modules/lru-cache` entry) that npm 10.9.8's
  `npm ci` rejects as "out of sync" — every CI job (verify/coverage/smoke)
  goes red at the setup step, with nothing wrong in the actual diff. Fix/
  avoid: run lockfile-touching installs with `npx npm@10.9.8 install`
  (matching whatever `.nvmrc` + CI's setup-node implies), not the ambient
  npm. Systemic fix (pin `packageManager` + corepack) tracked in #iv1t.
- This sandbox's local npm cache can go flaky/corrupted mid-session (tarball
  "seems to be corrupted", `ENOTEMPTY` on `rm -rf node_modules` if a
  dev-server process still has files open, stale `node_modules` reappearing
  after a supposedly-clean delete). If `npm ci`/`npm install` throws weird
  filesystem errors, check `ps aux` for a lingering `vite dev` in that
  worktree, kill it, `rm -rf node_modules` again, and retry — usually clears
  up on the 2nd or 3rd attempt without deeper action needed.

### Issue/inbox-session hygiene
- The inbox session (this one) is a **router only**: read the update, find
  the chat where the work was planned via `npm run chat -- list/show`, post
  a concise summary, stop. Do NOT re-investigate or re-fix work another
  session (e.g. @babysitter) already resolved — check `gh pr view <n>
  --json state,mergedAt` and `npm run issue -- show <id>` first; if the PR's
  merged and the issue's already `done`/`closed`, there's nothing to do.
  (Issue #hmu1, filed by @tilde, tracks tightening this prompt further after
  a prior inbox session burned ~12 minutes re-debugging a CI failure the
  babysitter had already fixed.)
