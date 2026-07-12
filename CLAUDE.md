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
./scripts/setup          bootstrap a fresh clone/worktree/session (idempotent, fast — every session runs this)
./scripts/hoist          the full "go live" move on a fresh machine: system deps, machine secrets, then a
                         persistent service (macOS: launchd; elsewhere: foreground) — see Working notes
./scripts/setup-tunnel   expose the ship publicly via Cloudflare Tunnel (manual, one-time, macOS)
npm run dev              start the ship (port 3000)
npm run agent            the agent service CLI (sessions, seed, extensions)
npm run users            the users service CLI (seed, list, whoami)
npm run issue            the issues service CLI (new, list, show, comment, handoff, …)
npm run files            the files service CLI (list, read, write, rm)
npm run check            format:check + lint + knip + typecheck + test — "is the ship sound"
npm test                 vitest — runs on PGlite, needs no database
npm run smoke            playwright — boots the REAL server on the fake runtime + smoke db
npm run coverage         vitest --coverage — global gate (threshold in vitest.config.ts)
npm run coverage:diff    diff-cover (via uvx): are the lines you changed vs main tested?
npm run coverage:check   coverage + coverage:diff — both gates, what the agent runs
npm run knip             knip — dead-code gate: unused files/exports/deps (config in knip.json)
npm run lint             eslint .            (lint:fix to autofix)
npm run format           prettier --write .  (format:check to verify)
npm run typecheck        tsc --noEmit
npm run db:up            start local Postgres (Docker)
npm run gateway:up       start the LiteLLM gateway (Docker)
npm run db:generate      drizzle-kit: migration from every src/**/schema.ts  (· db:migrate to apply)
npm run generate-routes  regenerate src/routeTree.gen.ts (gitignored)
npm run mutate           Stryker mutation test, whole project (periodic sweep)
npm run mutate:diff      mutation-test only the files this branch changed vs main
```

The app and pi.dev run **natively**; Postgres and the **LiteLLM gateway** run in
Docker (`npm run gateway:up`, which hoist/serve do). Every model call goes
through the gateway. Models and provider keys are managed in the gateway's admin
UI (`http://localhost:4000/ui`, log in as `admin` with the `LITELLM_MASTER_KEY`
from `.env`) and stored encrypted in the gateway's own `litellm` database — any
provider, hosted or local, without touching code or `.env`;
`litellm.config.yaml` only carries gateway-wide settings. The default model is
`SKYLARK_DEFAULT_MODEL`, a gateway model name (unset → `claude-sonnet-5` — a
fresh gateway needs a model by that name added in the UI).

## Skills

- **build-feature** — the build loop: red-green TDD → `npm run check` → commit →
  push → open a PR. **Follow it whenever you build or change a feature.** Ends
  by handing off to **babysit-pr** (or running it directly if there's no one to
  hand off to) — a feature isn't shipped until its PR is merged.
- **babysit-pr** — shepherd an open PR through CI and reviews to a merge: watch
  checks, weigh the agentic reviews, resolve conflicts, merge.
- **create-service** — adding a service: folder shape, which deck, wiring,
  tests.
- **author-zine** — writing or updating a zine: sections + principles.
- **mutation-review** — reviews a PR's test quality via mutation testing (a CI
  workflow via `tessl launch skill --cloud`; currently disabled).

All skills live in the `skylark-builder` plugin (`plugins/skylark-builder/`) and
are installed via `tessl install`.

## Testing

Vitest. Service logic is database-agnostic, so DB tests run against in-memory
PGlite — no external database (example: `src/hull/health/service.test.ts`). Work
**red-green TDD**: write a failing test first then make it pass.

Two coverage gates (`npm run coverage`, `npm run coverage:diff`) run both
locally and in per-PR CI; mutation testing runs locally (`npm run mutate:diff`)
and as a weekly full-project sweep (`npm run mutate`), not per PR — scope and
rationale live in `vitest.config.ts` and `stryker.config.mjs`. Every PR also
draws an advisory **change review** (five review lenses via
`anthropics/claude-code-action`); comment `@change-review` on a PR to re-run it.
The **mutation review** workflow (via `tessl launch skill --cloud`) is currently
disabled. The weekly sweeps and their secrets are documented in
`.github/workflows/`.

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
- **Home-server provisioning** (macOS-only for now) lives in `scripts/`,
  orchestrated by `hoist`, never by `setup` — `setup` runs on every session
  (worktrees, CI, this one) and has to stay instant and non-interactive:
  - `install-system-deps` — installs Homebrew (if missing), then Node, `gh`,
    `cloudflared`, and Docker Desktop via `brew`; idempotent, checks before
    installing each.
  - `configure-env` — mints the machine secrets `.env` needs, prompt-free:
    `LITELLM_MASTER_KEY` (gateway API auth + UI login), `LITELLM_SALT_KEY`
    (encrypts stored provider keys — never rotate it), and the
    `SKYLARK_INVITE_CODE` real signups need. LLM provider keys are NOT gathered
    here — they're added in the gateway UI. Skips itself in CI; never touches an
    already-set value. `serve` also runs it, so secrets exist before the
    gateway's first boot.
  - `install-launchd` — installs a per-user LaunchAgent
    (`~/Library/LaunchAgents/com.skylark.serve.plist`) running `scripts/serve`
    (Postgres + gateway + migrate + seed + `npm run dev`), so the ship survives
    reboots and restarts itself if it crashes. `KeepAlive` only acts on an
    actual process exit — it doesn't fight Vite's hot-reload, which never exits
    the process for an ordinary file change.
  - `setup-tunnel` — the only manual, human-run step: logs into Cloudflare
    (`cloudflared tunnel login`), creates a named tunnel, routes DNS to a
    hostname you choose, and installs `cloudflared` as its own system service.
    Not part of `hoist` since it needs your own Cloudflare account/domain.

## The crew

Three reviewers in [`.claude/agents/`](.claude/agents/) — **Tilde**
(architecture), **Dot** (crew experience & copy), **Bix** (edge cases & data
safety). Hand them work for an outside opinion.
