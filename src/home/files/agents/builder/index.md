# Builder Memory Index

## Recent Work

### Issue #en2b: Sidebar/dock sticky positioning fix (PR #125)
- **Status**: PR open (mergeable, CI running), baton with @babysitter
- **What**: Fixed desktop layout bug where the sidebar/dock scrolled away with
  tall content instead of staying pinned to the viewport.
- **Pattern**: outer shell `h-full`/`h-screen` + `overflow-hidden` on the row;
  every flex child that could grow past its share gets `min-h-0` so its own
  `ScrollArea` (or Dock's `overflow-y-auto` fallback for scroll-less surfaces
  like Models) is what scrolls — never the row.
- **Gotcha — race with a concurrently-merging PR**: while this branch was in
  flight, PR #124 (mobile collapsible sidebar, `CollapsibleSidebar` component)
  merged to main first, touching the same three files (chat.tsx,
  agent-chat.tsx, files.tsx). Rebasing onto main after that conflicted in
  exactly those files — mechanical, not conceptual: just reapply the
  min-h-0/overflow-hidden classes onto the CollapsibleSidebar-wrapped markup.
  Lesson: before opening a PR (or if one sits pushed for a while), check
  `git fetch && git rebase origin/main` early to catch this while it's still
  fresh in context, rather than after the fact.
- **Gotcha — flaky test timeouts under system load**: `npm run check` failed
  with 251 failed tests / Hook-timed-out errors once — turned out to be stray
  concurrent `vitest` processes from earlier session attempts (and other
  worktrees' dev servers) competing for the same PGlite/CPU resources on a
  heavily loaded machine (load avg 20+ on 12 cores). Killed stray `vitest`/`npm
  run test` processes (`ps aux | grep vitest`, `pkill -9 -f
  <worktree>/node_modules/.bin/vitest`) and reran clean — all 830 passed.
  Always check `ps aux | grep vitest` for leftover runs before trusting a
  failing `npm run check`.

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
- On a shared/loaded machine, stray `vitest` processes from earlier attempts
  can cause spurious timeouts — check `ps aux | grep vitest` and kill leftovers
  before trusting a failing run.

### Structure
- **Rigging layer** (`src/rigging/`): UI components, views, formatters
- **Hull layer** (`src/hull/`): Core services, business logic
- **Home layer** (`src/home/`): Routes, pages, glue code
- Utilities go in `lib/` directories within each layer
- Shared UI components (e.g. `CollapsibleSidebar`) live in
  `src/rigging/components/`, imported by multiple views.

### Build Loop (build-feature skill)
1. Red-green TDD: test first, then implementation
2. `npm run check` clean
3. Commit (commit-gate auto-runs check)
4. Push
5. Open PR via `gh pr create`
6. Before/while a PR sits open, `git fetch && git rebase origin/main`
   periodically — another PR touching the same files may land first and cause
   a conflicting rebase later; catching it early is cheaper.
7. Hand off via issue CLI: `SKYLARK_ACTOR=<id> npm run issue -- handoff <issue> babysitter "<message>"`
8. Stop (babysitter shepherds CI and merge)
