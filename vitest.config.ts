import { defineConfig } from 'vitest/config'

import { SHARED_EXCLUDES } from './test-excludes.mjs'

// Tests run against the decks directly, with no app framework in the way —
// just Vite's tsconfig path resolution (@hull/* etc.) and a node environment.
// Database tests use in-memory PGlite (see hull/health/service.test.ts), so the
// whole suite runs anywhere — your laptop, a Claude Code session, CI — with no
// Postgres, no Docker, no network.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // PGlite spins up a fresh WASM Postgres (+ migrations) in each DB test's
    // setup hook. That's ~1-2s idle, but on a busy shared machine — several
    // worktrees running their suites at once — CPU contention pushes it well
    // past vitest's 5s/10s defaults, so honest tests flake on timeout alone.
    // Generous ceilings absorb that contention while still catching a genuine
    // hang.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // text for the terminal, lcov for diff-cover (the PR diff gate),
      // json-summary for tooling, html for a browsable report.
      reporter: ['text', 'text-summary', 'lcov', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      // Measure every deck's source, then carve out what shouldn't be gated.
      include: ['src/**/*.{ts,tsx}'],
      // The ignore list keeps the global threshold ambitious by excluding code
      // that isn't ours to test or carries no logic. Logic lives in service.ts
      // files and views — those stay measured. Shared with Stryker's mutate
      // glob (see test-excludes.mjs) so the two gates can't drift on scope.
      exclude: [...SHARED_EXCLUDES],
      // The global gate. Ambitious on purpose — see the ignore list above.
      // Diff coverage (changed lines) is enforced separately by scripts/coverage-diff.
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
})
