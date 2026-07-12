# Builder Memory Index

## Recent Work

### Issue #osy7: Mobile-friendly responsive list+content layout (PR #124)
- **Status**: PR open, handed to @babysitter
- **What**: chat.tsx, agent-chat.tsx, files.tsx used a hardcoded-width `<aside>`
  with zero responsive handling. Added shared primitives instead of
  reimplementing per view:
  - `src/rigging/lib/use-is-mobile.ts` — `useIsMobile()` tracks
    `window.innerWidth` vs Tailwind's `md` breakpoint (768px) live via
    `resize`. Starts `false` for TanStack Start's SSR pass (no `window` yet),
    corrects in an effect after mount. jsdom has no `matchMedia`, so this
    reads `innerWidth`/`resize` directly rather than `matchMedia` — keeps
    tests and browsers on the same code path.
  - `src/rigging/components/collapsible-sidebar.tsx` — `CollapsibleSidebar`:
    docked `<aside>` above the breakpoint (unchanged desktop), off-canvas
    shadcn `Sheet` drawer below it (own hamburger trigger). Caller wires
    `open`/`onOpenChange` (local `useState`), resets to `false` on selection
    so picking an item auto-closes the drawer.
  - Added shadcn's `sheet.tsx` via `npx shadcn@latest add sheet` (radix
    `Dialog` under the hood, already a dependency via `radix-ui`).
  - issue-board.tsx and inbox.tsx audited — both are single-column
    forum-style pages that navigate to a separate route per item (no
    aside/split pane), so nothing to fix there.
- **Gotcha hit this session**: found partially-written work already present
  in the worktree from what looked like a prior/concurrent session (chat.tsx,
  agent-chat.tsx, files.tsx already patched, collapsible-sidebar.tsx already
  written) — worktrees can apparently have stray background processes/state
  from earlier turns. Also saw file-write races (a just-written test file
  read back with different content moments later) and stray leftover vitest
  watch-mode workers pinning CPU — `pkill -9 -f "<worktree-path>/node_modules/.bin/vitest"`
  cleaned them up. High system load (many parallel worktrees + dev servers,
  loadavg 25-30) caused transient PGlite test timeouts unrelated to the
  change — always re-run failing DB tests in isolation before concluding
  they're real failures.

### Issue #mp1q: Local-time formatter for inbox timestamps (PR #83)
- **Status**: PR open, handed to @babysitter (as of last session)
- **What**: Replaced UTC string surgery in inbox view with a proper formatter
- **Implementation**:
  - Created `src/rigging/lib/format-local-time.ts` with `formatLocalTime()` function
  - Added comprehensive tests in `format-local-time.test.ts`
  - Updated `src/rigging/views/inbox.tsx` to use the formatter
- **Pattern**: Formatters live in `src/rigging/lib/` with co-located tests

## Ship Knowledge

### Testing
- Follow red-green TDD: write failing test first, then implement
- Tests run on PGlite (in-memory), no external DB needed
- Coverage gates: global threshold + diff coverage on PRs
- Run `npm run check` before committing (format, lint, knip, typecheck, test)
- Local .env with ANTHROPIC_API_KEY causes some agent runtime tests to fail
  (test isolation issue) — run with `ANTHROPIC_API_KEY= npm run check`.
- jsdom has NO `matchMedia` and no real layout engine — prefer
  `window.innerWidth` + `resize` events (or an injected fake) over
  `matchMedia` for responsive hooks so tests can drive them directly.
- Under heavy parallel load (many worktrees/dev servers running), PGlite
  `beforeEach`/test hooks can time out spuriously — re-run the specific
  failing file alone before treating it as a real regression.

### Structure
- **Rigging layer** (`src/rigging/`): UI components, views, formatters,
  `lib/` hooks, `components/ui/` (shadcn primitives — add via
  `npx shadcn@latest add <x>`, aliases configured in `components.json`)
- **Hull layer** (`src/hull/`): Core services, business logic
- **Home layer** (`src/home/`): Routes, pages, glue code
- Utilities go in `lib/` directories within each layer
- Shared cross-view UI patterns (e.g. responsive sidebar) belong in
  `src/rigging/components/`, not duplicated per view

### Build Loop (build-feature skill)
1. Red-green TDD: test first, then implementation
2. `npm run check` clean (use `ANTHROPIC_API_KEY=` prefix locally)
3. Commit (commit-gate auto-runs check)
4. Push
5. Open PR via `gh pr create`
6. Hand off via issue CLI: `SKYLARK_ACTOR=<id> npm run issue -- handoff <issue> babysitter "<message>"`
7. Stop (babysitter shepherds CI and merge)
