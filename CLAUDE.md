# CLAUDE.md

Skylark is an operating system for personal software — built for a crew, not a
market. Small scale is the point; `npm run dev` is production.

Start here:

- [`README.md`](README.md) — the bet.
- [`src/zine.md`](src/zine.md) — how the codebase works: the `src/` serving
  layer, the three decks (hull/rigging/home), and the structural rules.

**The stack is settled — don't re-litigate it.**

## Stack

- **TanStack Start (v1) + Vite** — one server serves UX _and_ services; cross
  the client/server line with `createServerFn`.
- **Drizzle** + **Postgres** (live, in Docker) / **PGlite** (tests).
- **Tailwind v4 + shadcn/ui** — components are our code in
  `src/rigging/components/ui` (`npx shadcn@latest add <x>`); a theme is CSS
  variables in `src/rigging/styles.css`.
- **One package**; aliases `@/*`, `@hull/*`, `@rigging/*`, `@home/*`.
- **ESLint** (type-checked, strict) lints; **Prettier** formats. They don't
  overlap — ESLint owns correctness, Prettier owns style.

## Commands

```
./scripts/setup          bootstrap a fresh clone/worktree/session (idempotent)
./scripts/hoist          setup + Postgres + dev — the "go live" one move
npm run dev              start the ship (port 3000)
npm run check            format:check + lint + typecheck + test — "is the ship sound"
npm test                 vitest — runs on PGlite, needs no database
npm run coverage         vitest --coverage — global gate (threshold in vitest.config.ts)
npm run coverage:diff    diff-cover (via uvx): are the lines you changed vs main tested?
npm run coverage:check   coverage + coverage:diff — both gates, what the agent runs
npm run lint             eslint .            (lint:fix to autofix)
npm run format           prettier --write .  (format:check to verify)
npm run typecheck        tsc --noEmit
npm run db:up            start local Postgres (Docker)
npm run db:generate      drizzle-kit: migration from src/schema.ts  (· db:migrate to apply)
npm run generate-routes  regenerate src/routeTree.gen.ts (gitignored)
npm run mutate           Stryker mutation test, whole project (periodic sweep)
npm run mutate:diff      mutation-test only the files this branch changed vs main
```

Ollama and pi.dev run **natively** (Docker can't reach the Mac GPU); only
Postgres is containerized.

## Skills

- **create-service** — adding a service: folder shape, which deck, wiring,
  tests.
- **author-zine** — writing or updating a zine: sections + principles.

They live under `src/.claude/skills/` and surface when you work in the source
tree.

## Testing

Vitest. Service logic is database-agnostic, so DB tests run against in-memory
PGlite — no external database (example: `src/hull/health/service.test.ts`). Work
**red-green TDD**: write a failing test first then make it pass.

### Coverage

Two gates, both runnable locally and enforced in CI:

- **Global** — `npm run coverage`. A project-wide threshold (`vitest.config.ts`
  → `test.coverage`). Kept ambitious by an **ignore list** that excludes code
  that isn't ours to test or carries no logic: vendored shadcn (`components/ui`,
  `lib/utils`), framework doors (`server.ts`, `router.tsx`, `routes/`), the live
  DB wiring (`db/client.ts`), and drizzle declarations (`schema.ts`). Logic
  lives in `service.ts` files and views — keep those covered. To exempt a new
  file, add it to `coverage.exclude` rather than lowering the threshold.
- **Diff** — `npm run coverage:diff`. Uses `diff-cover` (run via `uvx`, nothing
  to install) to check that the lines you **changed** versus `main` are tested —
  this is the PR-review question ("is your new code covered"), independent of
  the global number. `npm run coverage:check` runs both.

A weekly GitHub Action (`.github/workflows/coverage-boost.yml`) has an agent
read the report, write tests for the biggest gaps, and open a PR — which then
faces the same two gates. It needs a `CLAUDE_CODE_OAUTH_TOKEN` repo secret (or
swap in `ANTHROPIC_API_KEY`).

### Mutation testing

**Mutation testing** (Stryker) measures whether those tests actually pin down
behaviour. Run `npm run mutate:diff` to check your own work before pushing — it
mutates only the files you changed. Every PR also gets a one-time **agentic**
mutation review in CI (`.github/workflows/mutation-review.yml`): it's advisory,
not a gate — it leaves comments and you decide. Comment `@mutation-review` on a
PR to run it again. A weekly scan (`mutation-scan.yml`) sweeps the whole project
and opens a PR strengthening the weakest tests. Scope and rationale live in
`stryker.config.mjs`.

## Working notes

- Start dev servers in the background so they don't block the session; check UI
  with the Playwright CLI.
- `npm run dev` serves on port 3000, or the next free port if 3000 is taken (so
  parallel worktrees coexist) — it prints the URL on boot. Use the printed port.
- The SessionStart hook (`.claude/settings.json` → `scripts/setup`) prepares
  every session, local and cloud; the agent starts `npm run dev` when it needs
  the UI.
- The app degrades to "database: down" when Postgres is asleep rather than
  crashing.

## The crew

Three reviewers in [`.claude/agents/`](.claude/agents/) — **Tilde**
(architecture), **Dot** (crew experience & copy), **Bix** (edge cases & data
safety). Hand them work for an outside opinion.
