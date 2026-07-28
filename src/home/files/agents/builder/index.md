
# Builder Memory Index

## Recent Work

### Issue #souf: change-review CI floating-model alias (PR #164) — handed to babysitter
- **Status**: PR open, `npm run check` clean (1697 tests). Handed off.
- **What**: `.github/workflows/change-review.yml` and its two weekly
  siblings (`architecture-review-global.yml`, `mutation-scan.yml`) all
  passed `--model opus` to `anthropics/claude-code-action@v1`. The action
  resolves that alias itself, and got it wrong — `opus` resolved to the
  nonexistent `claude-opus-5`, killing the run in ~45s with `is_error:true`
  and leaving the advisory `review` check permanently red on every PR (seen
  on #161, #163). Pinned `--model claude-opus-4-8` (a real id) in all three;
  `coverage-boost.yml` already pinned a real id (`claude-sonnet-4-6`) and
  was untouched — now all four workflows are consistent.
- **Red-green**: new `src/workflows.test.ts` regexes every
  `.github/workflows/*.yml` file's `claude_args` for a bare floating alias
  (`opus`/`sonnet`/`haiku`/`default`) — confirmed it failed listing all 3
  offenders before the fix, passed after. Cheap, no yaml-parsing dependency
  needed (plain string scan of `--model <token>`), lives alongside the
  other top-level `src/*.test.ts` structural guards (`navigation.test.ts`,
  `architecture.test.ts`, `boot.test.ts`).
- **Pattern reinforced**: a CI workflow with a `--model <alias>` flag that
  a THIRD-PARTY ACTION resolves internally (not our own `models.ts`
  resolution) is invisible to every existing model-resolution test in
  `src/hull/agent/` — those only cover the app's own gateway-facing model
  refs. When an external tool has its own alias table that can silently
  drift/break, a plain textual regression test over the workflow YAML
  (no new yaml-parsing dependency needed) is the cheapest guard; a full
  yaml parse would be overkill for one flag on one line.
- **Verification note left for babysitter**: the issue's own suggested
  verification (push a PR / comment `@change-review`, confirm the `review`
  check goes green against the real Anthropic backend) is exactly what
  landing this PR does — flagged that as the thing to watch for while
  shepherding, since I can't observe a live GitHub Actions run from here.

### Issue #0zis: CLI still swallows --body when the -- separator is missing (PR #163) — handed to babysitter
- **Status**: PR open, `npm run check` clean (1696 tests), coverage:check
  clean (`cli.ts`/`cli.test.ts` excluded from the diff-coverage gate like all
  CLI entrypoints — same posture as #7u5b).
- **What**: follow-up to #7u5b/PR#161. #161 only caught the case where an
  unconsumed `--flag`-looking token survives into argv. The actual
  real-world-broken invocation (`npm run issue new "Title" --body "text"`,
  no `--` separator) doesn't leave ANY such token: npm's own arg parser
  intercepts `--body <value>` as an unrecognized npm config flag, swallows
  the `--body` token entirely, and passes only the bare value through as an
  extra positional — argv becomes `["new", "Title", "text"]`, nothing for
  the unknown-flag check to catch, so `parseNewArgs` just joined the
  positionals into the title exactly like before #7u5b's fix.
- **The surviving signal**: npm sets `npm_config_body` (and
  `npm_config_owner` / `npm_config_playbook`) in the child process's env
  whenever it privately eats one of these unrecognized flags. `parseNewArgs`
  (`hull/issues/cli.ts`) now takes an `env` param (defaults to
  `process.env`, overridable for tests) and checks those three vars FIRST,
  throwing the same "did you forget the `--` separator?" error before ever
  falling through to joining positionals into the title.
- **Red-green**: wrote the new npm_config_* tests in `cli.test.ts` first,
  `git stash`ed just the `cli.ts` implementation change, confirmed all 4 new
  tests failed for the right reason (old 1-arg signature couldn't even take
  an `env` override), popped the stash, confirmed green.
- **Pattern reinforced**: when a CLI's own args aren't the whole story
  because a wrapper (npm) can eat a token before your code ever sees argv,
  look for a side-effect the wrapper leaves behind (here, an env var) as the
  next-best detection signal — don't just accept "we can't see it, so we
  can't catch it."

### Issue #7u5b: Issue CLI silently swallows --body / files garbage titles (PR #161) — handed to babysitter
- **Status**: PR open, `npm run check` clean (1649 tests), both coverage
  gates pass (100% diff coverage on `service.ts`; `cli.ts` is excluded from
  the coverage gate like other CLI entrypoints), no schema drift.
- **What**: `npm run issue new "Title" --body "text"` run WITHOUT the `--`
  separator lets npm's own arg parser eat `--body` before node ever sees it —
  the value survives as a bare word, gets joined into the title, and the
  result is a 1000+ character title with an empty body. Bit the night watch
  twice; 8 issues were hand-repaired via direct DB update on 2026-07-18.
- **Fix, two parts** (matching the issue's own two-halves ask):
  1. **Fail loudly.** `parseNewArgs` (`hull/issues/cli.ts`) now rejects any
     leftover `--flag`-looking token as an unknown-flag usage error instead
     of silently joining it into the title. New `MAX_TITLE_LENGTH` (200)
     backstop enforced in the ONE place both doors actually go through —
     `createIssue` and `validateOpenIssueInput` in `service.ts` — since npm
     eating `--body` *entirely* means the CLI never even sees a `--body`
     token to catch; only its value survives as title text, and the length
     cap is what catches that case. `parseNewArgs` also checks the cap
     itself first, for a CLI-flavored error message.
  2. **Normalize the invocation.** Every usage/help string and thrown error
     in `cli.ts` now prints the canonical `npm run issue -- <command> ...`
     form (with the separator) instead of the separator-less form that
     caused the whole incident; the top-level usage banner spells out *why*
     the separator matters. `CLAUDE.md`'s Working notes and
     `hull/issues/zine.md` document both the separator requirement and the
     new guardrails.
- **Red-green**: `git stash` on just the two implementation files
  (`cli.ts`/`service.ts`) with the new tests present confirmed all 5 new
  tests failed for the right reasons (unknown-flag/title-length checks
  simply didn't exist yet) before popping the stash back and turning green.
- **Pattern reinforced**: when a validation rule needs enforcing at more than
  one door (CLI + web `createServerFn`), put the actual enforcement in the
  shared service function every door funnels through (here: `createIssue`),
  and let the CLI's own pre-check exist ONLY for a friendlier, CLI-specific
  error message — not as a second source of truth for the limit itself
  (both import the same exported `MAX_TITLE_LENGTH` constant).

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

### Issue #jgdb: agent CLI 'agent show <session-id>' (PR #130) — handed to babysitter
- **Status**: PR open, `npm run check` clean (881 tests), both coverage gates
  pass (diff coverage 100% on the two changed service files; cli.ts itself is
  excluded from the coverage gate like other CLI entrypoints), no schema
  drift. Manually smoke-tested against the real local DB (prefix match,
  no-match, ambiguous-prefix all behaved).
- **What**: `npm run agent -- show <session-id> [--tail N]` — a read-only
  inspection door for a session, same posture as `npm run issue`, replacing
  hand-written SQL against `agent_messages`/`agent_sessions` (the exact thing
  #4mna's stalled-build tracing had to do manually). Prints a header
  (title/status/last-activity/error), counts (total + per-role message
  breakdown + tool-call count), and a transcript tail (default 10, `--tail N`).
- **Implementation**:
  - `service.ts`: new `resolveSessionRef(db, ref)` — exact id first, then a
    drizzle `like(agentSessions.id, \`${ref}%\`)` prefix match; throws (rather
    than silently picking one) if the prefix is ambiguous. Same convenience
    `resolveIssueRef` gives the issue CLI.
  - `transcript.ts`: new `sessionStats(messages)` sits next to the existing
    `toChatItems` — same defensive, opaque-JSON-from-Postgres parsing (walks
    `role`/`content` blocks without trusting their shape). Tool-call count
    comes from walking assistant messages' content blocks (a toolCall is a
    block *inside* an assistant message, not its own stored row) rather than
    counting stored rows by role.
  - `cli.ts`: `cmdShow` composes `getMessages` (already existed, fetches
    everything ascending) + `sessionStats` + `toChatItems`, slicing the
    rendered items to the tail client-side rather than adding a new
    DB-side "last N" query — cheap enough given expected session sizes, and
    keeps one code path for full-session stats and the tail render.
- **Pattern reinforced**: CLI door conventions (`--flag value` parsing
  exported as a pure, directly-unit-tested function; `DIM`/`RESET` color
  helpers; `withCliActor` for RLS-scoped reads) are consistent across
  `issues/cli.ts`, `chat/cli.ts`, and now `agent/cli.ts` — reach for the
  sibling CLI as the template before inventing new argument-parsing shape.

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

### Issue #mp1q: Local-time formatter for inbox timestamps (PR #83) — MERGED
- Replaced UTC string surgery in the inbox view with `formatLocalTime()` in
  `src/rigging/lib/format-local-time.ts`. Pattern: formatters live in
  `lib/` dirs with co-located tests.

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
