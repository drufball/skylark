import { defineConfig } from 'vitest/config'

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
  },
})
