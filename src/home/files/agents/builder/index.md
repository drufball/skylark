# Builder Memory Index

## Recent Work

### Issue #iv1t: Pin npm version to match CI (PR #127)
- **Status**: PR open, handed to @babysitter
- **What**: This is the permanent fix for the lockfile/npm-version drift bug
  hit in #3c5b/PR #123 (see below). Added `"packageManager": "npm@10.9.8"` to
  `package.json` (10.9.8 is what node 22 — `.nvmrc` — bundles, and what
  `actions/setup-node` hands CI). Added `scripts/npm-cmd`, a small script that
  decides per-install whether to use bare `npm` (ambient already matches the
  pin — ~free, the CI case) or `npx --yes corepack npm` (ambient differs —
  transparently runs the pinned version regardless of what's on PATH).
  `scripts/setup` and `scripts/commit-gate`'s defensive install both route
  through it now.
- **Red-green test**: `src/hull/agent/extensions/build-gates/npm-cmd.test.ts`
  drives `scripts/npm-cmd`'s decision logic via a 2-arg (pinned, ambient) test
  hook — so it's unit-tested without touching the real npm or package.json.
  `scripts/npm-cmd` with 0 args reads the real pin/ambient for actual use.
- **Verified the mechanism, not just the symptom**: reproduced in a scratch
  dir that `npm install` under ambient npm 11.17.0 vs `npx corepack
  npm@10.9.8` on the SAME `nitro` dependency produces exactly the lockfile
  diff described in #3c5b (nested `node_modules/nitro/node_modules/lru-cache`
  entry present under 10.9.8/absent under 11.x; `libc` fields absent/present
  the same way). Then ran `./scripts/setup` for real on this ambient-11.17.0
  box and confirmed `package-lock.json` came out byte-identical to the
  committed one.
- **corepack gotcha learned this session**: `corepack enable` (no args, or
  with a bare package/`--install-directory`) OVERWRITES the global `npm`/`npx`
  binaries on PATH with corepack shims — a global, persistent, surprising
  side effect if you're just trying to test what a pinned version resolves
  to. Don't use `corepack enable` for anything except a deliberate, permanent
  environment change. `npx --yes corepack npm <args>` (or `corepack npm
  <args>` if corepack is already on PATH) runs the *pinned* npm for ONE
  invocation without touching any global state — that's the safe primitive,
  and what this fix uses. (Also: `corepack enable` with no explicit package
  name installs pnpm/yarn shims too, not just npm — `corepack enable npm`
  scopes it, but still touches global symlinks.)
- **Node/corepack packaging note**: node <25 bundles corepack (e.g. node 22 →
  corepack 0.34.x at `$(dirname node)/corepack`); node ≥25 stopped shipping it
  (upstream removed the bundle). Either way `npx --yes corepack npm ...`
  works — npx fetches corepack from the registry on demand if it's not
  already resolvable, so the fix doesn't depend on which node version a
  builder happens to have.
- **`engines.npm` + `engine-strict=true` was considered and rejected**: it
  only *fails loudly* on a version mismatch (`EBADENGINE`), it doesn't fix the
  ambient npm — still needs a human to notice and re-run with the right npm.
  The `packageManager` + corepack-routing approach actually makes the right
  npm run automatically, which is what the issue asked for ("prefer (1)").

### Issue #3c5b: Remove TanStack devtools logo (PR #123)
- **Status**: PR open, handed to @babysitter (second round — fixed a lockfile
  CI failure after the first handoff)
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
- **Lockfile/npm-version gotcha (important, bit me and @tilde caught it in
  review — now permanently fixed by #iv1t/PR #127, see above)**: `npm
  install`/commit-gate's `npm run check` on this box run under whatever
  ambient `npm` is on PATH (was 11.17.0, from `node@26` via brew) — but CI's
  `.nvmrc`-pinned node 22 setup bundles **npm 10.9.8**, and the two versions
  resolve nitro's optional peer `lru-cache` dep differently: npm 11 omits an
  explicit `node_modules/nitro/node_modules/lru-cache` lock entry and adds
  `libc` fields to some optional platform packages that npm 10.9.8 doesn't
  write. A lockfile generated/updated with npm 11 makes CI's `npm ci` (on npm
  10.9.8) fail with `Missing: lru-cache@11.5.2 from lock file` — verify/
  coverage/smoke all red, with NO app-code problem. Local `npm run check`
  looks totally clean because it uses the newer npm, so this is invisible
  until CI runs.
  - **One-off fix at the time**: regenerate the lockfile with the SAME npm CI
    uses: `npx -y npm@10.9.8 install --package-lock-only`, then commit just
    the lockfile diff.
  - **Permanent fix**: #iv1t/PR #127 — `packageManager` pin + `scripts/npm-cmd`
    auto-routes every `scripts/setup`/`scripts/commit-gate` install through
    the pinned npm when ambient drifts, so this class of bug can't recur
    silently.
- **Env/tooling gotcha**: in this sandbox, `git push`/`gh pr create` initially
  failed ("could not read Username", "not logged into any GitHub hosts") even
  though a `gh` keyring credential existed (`security dump-keychain` showed
  `svce="gh:github.com"`, `gh auth status` succeeded). Fix: run
  `gh auth setup-git` once per session/worktree to wire gh's credential into
  git's credential helper — then `git push` and `gh pr create` both work.
  (Not needed every session — a later session's plain `git push` worked
  without it, so try plain push first.)
  `gh pr create --body "$(cat <<'EOF' ...)"` heredoc-in-substitution can choke
  bash quoting; write the body to a temp file and use `--body-file` instead.
- **Playwright note**: smoke tests need browsers installed once per box —
  `npx playwright install chromium --with-deps` (~170MB download) before
  `npm run smoke` or `npx playwright test e2e/...` will work.
- **Shared-worktree caution**: this worktree can have OTHER agents/sessions
  running concurrently (saw a second actor's `npm run issue`/`npm run files`
  calls and background `npm ci`/`npm run check` runs interleaved with mine).
  Avoid `rm -rf node_modules` here — it races with anyone else's install/test
  run and throws spurious `ENOTEMPTY`/`ENOENT` errors that look like real
  breakage but are just concurrent writers. Prefer non-destructive fixes
  (`npm install --package-lock-only`, or verify in a throwaway `/tmp` clone)
  over nuking shared state.

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
- Shell scripts (`scripts/*`, no extension) aren't unit-testable directly by
  vitest — the pattern (see `gate-workdir.test.ts`, `npm-cmd.test.ts`) is to
  `execFile('bash', [path/to/script, ...args])` and assert on stdout. Give the
  script an optional argv-driven "test mode" (extra args) alongside its real
  zero-arg behavior (reads live env/files) so the logic is exercised without
  touching the real environment.
- If CI's verify/coverage/smoke jobs all fail at `npm ci` with a lockfile
  "out of sync"/`Missing: X from lock file` error but everything is clean
  locally, it's almost certainly an npm-version mismatch (see #3c5b/#iv1t
  above) — check `.nvmrc` vs your local `npm -v`. As of #iv1t/PR #127,
  `package.json`'s `packageManager` field pins the version and
  `scripts/setup`/`scripts/commit-gate` auto-route through `npx --yes
  corepack npm` when ambient npm doesn't match it, so this should now be
  self-healing rather than something to debug — but if it recurs (e.g. the
  pin itself drifts from what `.nvmrc`'s node actually bundles), regenerate
  with `npx -y npm@<ci-version> install --package-lock-only` and update the
  `packageManager` field to match.

### Structure
- **Rigging layer** (`src/rigging/`): UI components, views, formatters
- **Hull layer** (`src/hull/`): Core services, business logic
- **Home layer** (`src/home/`): Routes, pages, glue code
- Utilities go in `lib/` directories within each layer
- `src/routes/__root.tsx`'s `RootDocument` is the actual HTML shell
  (`<html>/<head>/<body>`) every route renders into — the right place to
  remove/gate anything "on every page" (widgets, scripts, devtools).
- `scripts/npm-cmd`, `scripts/gate-workdir`, `scripts/commit-gate`,
  `scripts/landing-gate`, `scripts/setup` are the shell-level bootstrap/gate
  scripts; their decision logic gets unit tests in
  `src/hull/agent/extensions/build-gates/` (the pi.dev-side mirror of the
  same gates) even though the scripts themselves live under `scripts/`.

### Build Loop (build-feature skill)
1. Red-green TDD: test first, then implementation
2. `npm run check` clean
3. Commit (commit-gate auto-runs check)
4. Push
5. Open PR via `gh pr create`
6. Hand off via issue CLI: `SKYLARK_ACTOR=<id> npm run issue -- handoff <issue> babysitter "<message>"`
7. Stop (babysitter shepherds CI and merge)
8. If the babysitter/reviewer hands a fix brief back (e.g. a lockfile/CI
   mismatch), fix on the same branch, verify, commit, push, then hand off
   again with a short note on what was wrong and how it was verified.

### Environment gotchas (this sandbox)
- If `git push`/`gh pr create` fail with credential errors despite `gh auth
  status` succeeding, run `gh auth setup-git` first — it wires the gh keyring
  credential into git's credential helper. Try a plain `git push` first
  though — it has worked without this step in later sessions.
- `gh pr create --body "$(cat <<'EOF' ... EOF)"` can trip bash's heredoc
  parsing when passed through certain shells/tools; write the PR body to a
  temp file and use `--body-file /tmp/whatever.md` instead — more reliable.
- Worktrees can be shared with other concurrently-running agents/sessions —
  avoid destructive operations (`rm -rf node_modules`) on shared state; prefer
  targeted fixes (`--package-lock-only`) or verify in a `/tmp` scratch clone.
- **`corepack enable` mutates global state** (overwrites `/opt/homebrew/bin/
  npm`+`npx` — or wherever `which corepack` resolves — with corepack shims,
  persistently, across all shells/dirs, plus adds pnpm/yarn shims). Never run
  it just to "check" something; use `npx --yes corepack npm <args>` (or
  `corepack npm <args>` if already on PATH) for a one-off pinned-version
  invocation that touches nothing global. If you ever do run `corepack
  enable` by accident, restore with: `rm -f <bindir>/npm <bindir>/npx
  <bindir>/pnpm <bindir>/pnpx <bindir>/yarn <bindir>/yarnpkg; ln -s
  <real-node-cellar>/bin/npm <bindir>/npm; ln -s <real-node-cellar>/bin/npx
  <bindir>/npx` (find `<real-node-cellar>` via `brew --prefix node` or
  checking `Cellar/node*/`), then `npm uninstall -g corepack` if you installed
  it just for testing.
