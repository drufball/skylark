import { defineConfig } from '@playwright/test'

import { FAKE_RUNTIME_ENV } from './src/hull/lib/env'

// Smoke tests — Phase 1. A handful of critical happy paths driven through the
// REAL running app (the boot + the live SSE stream), catching wiring regressions
// the PGlite unit suite structurally can't: the routes, the createServerFn
// doors, actor resolution, and the EventSource ↔ /api/stream path end to end.
//
// Deliberately small and hermetic. The server boots with SKYLARK_FAKE_RUNTIME=1,
// the single switch that makes a smoke run safe on two axes:
//   - no model: the agent runtime is the deterministic fake (hull/agent/
//     fake-session.ts), so no pi.dev/Claude call ever fires.
//   - no real data: the resolver (hull/db/url.ts) points the app at a dedicated
//     `skylark_smoke` database, so the run can't touch the `skylark` db the dev
//     server uses — even if DATABASE_URL names it. global-setup creates,
//     migrates, truncates, and seeds that db before the tests.
//
// It needs a local Postgres (npm run db:up) — npm run dev IS production, so smoke
// runs against the real driver, not PGlite. Not wired into `npm run check` (too
// slow); run with `npm run smoke`.

const PORT = '3210'

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // Smoke paths should be quick; a generous-but-bounded ceiling catches hangs.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // Serial + single worker: these share one server and one database.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    // Direct vite invocation on a dedicated port so parallel worktrees (and a
    // dev server already on 3000) never collide.
    command: `npx vite dev --port ${PORT}`,
    url: `http://localhost:${PORT}/status`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { [FAKE_RUNTIME_ENV]: '1' },
  },
})
