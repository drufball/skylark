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

- **ship-feature** — the build loop: red-green TDD → `npm run check` → commit →
  push → shepherd the PR through CI and reviews → merge. **Follow it whenever
  you build or change a feature.**
- **architecture-review** — review structure & boundaries of a diff, module, or
  the whole ship (also run per-PR and weekly in CI).
- **create-service** — adding a service: folder shape, which deck, wiring,
  tests.
- **author-zine** — writing or updating a zine: sections + principles.

`ship-feature` and `architecture-review` live in `.claude/skills/`; the
service-tree skills live under `src/.claude/skills/` and surface when you work
in the source tree.

## Testing

Vitest. Service logic is database-agnostic, so DB tests run against in-memory
PGlite — no external database (example: `src/hull/health/service.test.ts`). Work
**red-green TDD**: write a failing test first then make it pass.

Two coverage gates (`npm run coverage`, `npm run coverage:diff`) and mutation
testing (`npm run mutate:diff`) run both locally and in CI — scope and rationale
live in `vitest.config.ts` and `stryker.config.mjs`. Every PR also draws
advisory **agentic reviews** (architecture + mutation); the weekly sweeps and
their secrets are documented in `.github/workflows/`.

## Working notes

- Start dev servers in the background so they don't block the session; check UI
  with the Playwright CLI.
- `npm run dev` serves on port 3000, or the next free port if 3000 is taken (so
  parallel worktrees coexist) — it prints the URL on boot. Use the printed port.
- The SessionStart hook (`.claude/settings.json` → `scripts/setup`) prepares
  every session, local and cloud; the agent starts `npm run dev` when it needs
  the UI. Two more hooks guard the build loop: the **commit-gate** runs
  `npm run check` before any `git add`/`git commit` (blocks on failure), and the
  **landing-gate** won't let you finish with committed work that isn't pushed
  and PR'd.
- The app degrades to "database: down" when Postgres is asleep rather than
  crashing.

## The crew

Three reviewers in [`.claude/agents/`](.claude/agents/) — **Tilde**
(architecture), **Dot** (crew experience & copy), **Bix** (edge cases & data
safety). Hand them work for an outside opinion.
