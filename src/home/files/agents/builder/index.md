# Builder Memory Index

## Recent Work

### Issue #osy7: Mobile-friendly responsive list+content layout (PR #124)
- **Status**: PR open, handed to @babysitter
- **What**: chat.tsx, agent-chat.tsx, files.tsx each split the screen with a
  hardcoded-width `<aside className="w-64|w-72 shrink-0">` and zero responsive
  handling — squeezed/overflowed on mobile, no way to hide the list.
- **Shared pieces** (so it's not 3 reimplementations):
  - `src/rigging/lib/use-is-mobile.ts` — `useIsMobile()` tracks
    `window.innerWidth` against Tailwind's `md` breakpoint (768px) live via
    `resize`. Starts `false` during TanStack Start's SSR pass (no `window`
    yet) and corrects itself in an effect right after mount — reading
    `window` directly during render would crash SSR.
  - `src/rigging/components/collapsible-sidebar.tsx` — `CollapsibleSidebar`:
    docked `<aside>` above the breakpoint (unchanged desktop behaviour);
    below it, same children render inside an off-canvas shadcn `Sheet`
    (added via `npx shadcn@latest add sheet` — radix `Dialog` under the
    hood, already a dependency via the `radix-ui` package). Owns its own
    hamburger trigger button; caller wires `open`/`onOpenChange` (local
    `useState`) and resets to `false` on item selection so picking a
    chat/session/file auto-closes the drawer and lands on content.
- **Wired into**: chat.tsx (chat list), agent-chat.tsx (session list),
  files.tsx (file explorer).
- **Audited, not touched**: issue-board.tsx and inbox.tsx were in the issue's
  nominal scope but don't have this pattern — both are single-column,
  forum-style pages where selecting an item navigates to a separate route
  (`/issues/$id`) rather than splitting a pane in place. Confirmed via
  `grep -rn aside src/rigging/views` — no other `<aside>` split-pane exists.
- **Red-green**: `use-is-mobile.test.tsx` / `collapsible-sidebar.test.tsx` are
  new, pinning the breakpoint/drawer behavior directly. Added mobile-viewport
  cases to chat/agent-chat/files view tests (trigger absent + list docked at
  desktop width; list hidden behind trigger, opens as drawer, auto-closes on
  selection below the breakpoint) — confirmed these fail against the old
  always-rendered `<aside>` markup and pass after.
- **shadcn add gotcha**: `npx shadcn@latest add sheet` also touches
  `package-lock.json` with unrelated metadata churn (npm re-resolving
  optional-dep `libc` fields) even though no new dependency is added — `git
  checkout -- package-lock.json` after, no `npm install` needed since Sheet
  is built entirely on the already-installed `radix-ui` package.
- **Design note**: chose `window.innerWidth` + `resize` over `matchMedia`
  for `useIsMobile` — matchMedia's `MediaQueryList` needed an injectable
  factory (mirroring `useShipLog`'s `EventSourceFactory` pattern) to be
  testable and to fake in SSR (no `window.matchMedia` at all server-side,
  not just no match); `innerWidth`+`resize` behaves identically in jsdom and
  a real browser with no injection needed, so it's less machinery for the
  same behavior.

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
- Under heavy machine load (several worktrees + dev servers + Docker running
  at once), `npm run check`'s hull DB tests (PGlite `freshDb()`) can fail with
  "Hook timed out in 10000ms" — flaky from contention, not a real failure.
  Rerun the specific failing test file(s) alone, or rerun `npm run check`
  once load drops, before assuming your change broke something in hull.

### Structure
- **Rigging layer** (`src/rigging/`): UI components, views, formatters
- **Hull layer** (`src/hull/`): Core services, business logic
- **Home layer** (`src/home/`): Routes, pages, glue code
- Utilities go in `lib/` directories within each layer
- `src/routes/__root.tsx`'s `RootDocument` is the actual HTML shell
  (`<html>/<head>/<body>`) every route renders into — the right place to
  remove/gate anything "on every page" (widgets, scripts, devtools).
- Shared cross-view UI components (not single-view-specific) live in
  `src/rigging/components/` directly (e.g. `composer.tsx`,
  `collapsible-sidebar.tsx`), with shadcn primitives one level down in
  `src/rigging/components/ui/` (e.g. `sheet.tsx`, added via
  `npx shadcn@latest add <name>` — check `components.json` for aliases).
- Hooks belonging to one deck live in that deck's `lib/` (e.g.
  `src/rigging/lib/use-is-mobile.ts`, `use-ship-log.ts`) even though
  `components.json` declares a `@rigging/hooks` alias — no `hooks/` dir
  exists yet in practice, `lib/` is where they actually land.

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
- `npx shadcn@latest add <component>` touches `package-lock.json` with
  unrelated metadata-only churn (e.g. re-resolved optional-dep `libc`
  fields) even when no new dependency is actually added — diff it after and
  `git checkout -- package-lock.json` if it's just noise.
