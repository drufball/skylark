# Builder Memory Index

## Recent Work

<<<<<<< HEAD
### Issue #4mna: Stalled-vs-busy build status (PR #129) — handed to babysitter
- **Status**: PR open, `npm run check` clean (867 tests), both coverage gates
  pass, no migration drift. Handed off.
- **Note**: found substantial WIP already present in the worktree at session
  start (activity.ts/test, use-now.ts/test, schema/service/orchestrator/server
  edits, view + test updates) — reviewed it end-to-end rather than redoing it;
  it was solid. Only had to fix one lint error (`@typescript-eslint/no-
  unnecessary-type-assertion` in progress.ts's `backgroundToolLabel`) and
  apply the new migration to the local dev DB (`npm run db:migrate`) before
  the issue CLI's handoff command could read the new `status_line_at`/
  `awaiting_background` columns — a fresh migration file doesn't get applied
  to the dev Postgres automatically; if a CLI query fails with an
  "unrecognized column" style error right after adding a migration, run
  `npm run db:migrate` first.
- **What**: `hull/issues/activity.ts`'s `computeBuildActivity` — pure
  classifier of `sessionRunning` (resolved per-issue from `agent_sessions` via
  a new `runningSessionIds` lookup, the one *direct* "is it actually running
  right now, in this process" signal) + `statusLine`/`statusLineAt` (new
  durable "last real activity" clock, bumped on every `setStatusLine` write)
  + `awaitingBackground` (new durable flag, true only when the last tick was
  a turn ending on purpose via the `background` tool — `progress.ts`'s new
  `backgroundToolLabel()`) into one of three states: busy (hammer/amber),
  waiting on a background job for up to a 10-minute trust window (clock/blue),
  or stalled (`⚠ stalled 12m`, warning-triangle/red/bold — deliberately NOT
  another shade of the amber ellipsis that hid the original incident).
  `rigging/lib/use-now.ts` (30s-tick clock hook) lets the board/thread flip to
  "stalled" on their own over time without a new server push, since a truly
  stalled session emits nothing further by definition.
- **Documented limitation**: background-job liveness isn't tracked durably
  (`background.ts`'s jobs are an in-process `Set`, no DB row) — "waiting" vs
  "job died, orphaned" is only inferred from elapsed time
  (`STALL_AFTER_BACKGROUND_MS`), not truly known. Written into `activity.ts`'s
  module comment as a deliberate, bounded tradeoff rather than solved with a
  bigger schema change.
- **Pattern reinforced**: pure classifiers (`computeBuildActivity`,
  `formatStallDuration`) live in `hull/`, colocated tests; view components in
  `rigging/views/` just call them and render — same shape as chat's
  `workingFromMembers` (#zo3a below).

=======
>>>>>>> origin/main
### npm-version-drift saga — fully closed
- Chain: #3c5b (devtools removal) hit CI-only lockfile failure →
  #59vb (immediate unblock: regenerate lockfile with npm 10.9.8) →
  #iv1t (systemic fix: pin `packageManager: "npm@10.9.8"` in
  package.json, PR #127, merged c7414e3). All three done. If `npm
  run check` is clean locally but CI's verify/coverage/smoke all fail
  identically at the `npm ci`/setup step, this class of bug should now
  be prevented by the packageManager pin — but if it recurs, check
  corepack is actually enabled/respected in the environment.

### Issue #zo3a: Chat thinking bubbles lost on page navigation (PR #128) — MERGED
- **Status**: Merged. CI green, no unresolved review comments.
- **What**: Chat's live agent "working…" bubble was purely ephemeral —
  pushed over SSE via `notifyOnly`, never persisted — so navigating away from
  a chat and back showed nothing even though the agent was still mid-turn.
  Mirrored the pattern issues already uses (`issues.statusLine`, a durable
  column updated live and rendered straight from the loader).
- **Implementation**:
  - `chat_members` gains a `progressLine` column (migration 0023).
  - `orchestrator.ts`'s `driveTurn`: new `setProgress` helper writes the line
    durably (`setMemberProgress`) AND still emits ephemerally (kept, for a tab
    open live — avoids waiting a round trip). Clears to `null` in a `finally`
    once the *owning* turn ends (success/silent/thrown) — but a call whose
    prompt got folded into an already-in-flight turn (`queued: true`) must
    NOT clear it, since that other turn (not this call) still owns the
    bubble. Tracked with an `ownsTurn` flag defaulting `true` (so a thrown
    turn still self-clears) and flipped `false` only on `queued`.
  - `getChatThread` (server.ts) now returns each member's `progressLine`.
  - Route (`routes/index.tsx`) seeds its `working` state from the loaded
    thread's members on every `activeId` change (a `seededFor` render-time
    comparison, not an effect — avoids `react-hooks/set-state-in-effect` and
    shows the bubble on the very first paint after a switch). The derivation
    itself (`workingFromMembers`) is a new pure, exported, unit-tested
    function in `chat.tsx` — logic lives in the testable view module, not the
    untested route.
- **Red-green tests**: `service.test.ts` (persist/clear `setMemberProgress`),
  `orchestrator.test.ts` (persist-then-clear across success/silent/thrown
  turns, plus the queued-must-not-clear-another-turn's-bubble edge case),
  `chat.test.tsx` (`workingFromMembers` directly).
- **Rebase needed mid-build**: branched off an older `main`; by the time I
  went to land, `main` had moved (npm-pin fix #127, mobile-collapsible-sidebar
  #124/#125) and `chat.tsx`/`routes/index.tsx` had diverged upstream. Ran
  `git stash`, `git rebase origin/main` (one trivial conflict, a shared
  memory-notes file `agents/tilde/index.md` — resolved `--ours`, unrelated to
  code), `git stash pop` (auto-merged cleanly, no conflicts) — then re-ran
  `npm run db:generate` (confirmed no drift) and the full check/coverage
  gates before committing. Lesson: if a build session runs long, check
  `git fetch && git log origin/main --oneline` before the final `npm run
  check`/commit — landing on a stale base risks silent merge damage or a
  redundant lockfile diff (see #3c5b/#iv1t history below) even when your own
  diff is clean.
- **Backgrounding gotcha this session**: the `background` tool for `npm run
  check`/`coverage:check` reported "backgrounded" but the resume callback was
  lost twice in a row (per the harness's own message) — ran both in the
  foreground instead and they completed normally in ~60-75s. If a background
  job's resume seems to go missing, just re-run the same command in the
  foreground rather than re-backgrounding it again.

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
  review)**: `npm install`/commit-gate's `npm run check` on this box run
  under whatever ambient `npm` is on PATH (was 11.17.0, from `node@26` via
  brew) — but CI's `.nvmrc`-pinned node 22 setup bundles **npm 10.9.8**, and
  the two versions resolve nitro's optional peer `lru-cache` dep differently:
  npm 11 omits an explicit `node_modules/nitro/node_modules/lru-cache` lock
  entry and adds `libc` fields to some optional platform packages that npm
  10.9.8 doesn't write. A lockfile generated/updated with npm 11 makes CI's
  `npm ci` (on npm 10.9.8) fail with `Missing: lru-cache@11.5.2 from lock
  file` — verify/coverage/smoke all red, with NO app-code problem. Local
  `npm run check` looks totally clean because it uses the newer npm, so this
  is invisible until CI runs.
  - **Fix**: regenerate the lockfile with the SAME npm CI uses:
    `npx -y npm@10.9.8 install --package-lock-only`, then commit just the
    lockfile diff. Verify by running `npm ci` under both npm versions (or at
    least npm 10.9.8) against the new lockfile before pushing.
  - **General lesson**: if a PR is green in `npm run check` locally but CI's
    verify/coverage/smoke jobs all fail identically at the `npm ci`/setup
    step (not in the actual test/lint output), suspect a lockfile/npm-version
    mismatch first — check `.nvmrc` and compare against `npm -v` locally.
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
- If CI's verify/coverage/smoke jobs all fail at `npm ci` with a lockfile
  "out of sync" error but everything is clean locally, it's almost certainly
  an npm-version mismatch (see #3c5b above) — check `.nvmrc` vs your local
  `npm -v`, and regenerate the lockfile with `npx -y npm@<ci-version> install
  --package-lock-only` rather than debugging app code.

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
8. If the babysitter/reviewer hands a fix brief back (e.g. a lockfile/CI
   mismatch), fix on the same branch, verify, commit, push, then hand off
   again with a short note on what was wrong and how it was verified.

### Environment gotchas (this sandbox)
- If `git push`/`gh pr create` fail with credential errors despite `gh auth
  status` succeeding, run `gh auth setup-git` first — it wires the gh keyring
  credential into git's credential helper.
- `gh pr create --body "$(cat <<'EOF' ... EOF)"` can trip bash's heredoc
  parsing when passed through certain shells/tools; write the PR body to a
  temp file and use `--body-file /tmp/whatever.md` instead — more reliable.
- Worktrees can be shared with other concurrently-running agents/sessions —
  avoid destructive operations (`rm -rf node_modules`) on shared state; prefer
  targeted fixes (`--package-lock-only`) or verify in a `/tmp` scratch clone.
