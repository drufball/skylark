// Stryker — mutation testing. It changes your source in small ways (a `<`
// becomes `<=`, a `true` becomes `false`) and checks whether a test fails. A
// surviving mutant is a behaviour your tests don't actually pin down.
//
// `npm run mutate`       — full sweep (periodic; the weekly scan runs this).
// `npm run mutate:diff`  — only the files this branch changed (PR-quality check).
//
// No build-breaking threshold: results inform, they don't gate (see the agentic
// PR review in .github/workflows/mutation-review.yml). Reports land in reports/
// and are gitignored.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  // Reuses vitest.config.ts as-is, so the suite runs on in-memory PGlite —
  // mutation testing needs no Postgres, no Docker, no network, same as `npm test`.
  testRunner: 'vitest',
  reporters: ['html', 'json', 'clear-text', 'progress'],
  coverageAnalysis: 'perTest',

  mutate: [
    'src/**/*.ts',
    'src/**/*.tsx',
    '!src/**/*.test.ts',
    '!src/**/*.test.tsx',

    // Skip the thin wiring the zine calls deliberately untested: schemas
    // (declarative table defs), doors (server.ts — createServerFn — and cli.ts,
    // the CLI entrypoints), the DB client (driver setup) and test-db harness,
    // routes/router (thin routing), generated code, configs, vendored shadcn,
    // and the skill tree. What's left — services, lib, views — is where the
    // logic and the tests actually live, so that's where a mutation score means
    // something.
    //
    // This list is kept in lockstep with vitest.config.ts's coverage `exclude`:
    // the two gates must agree on what isn't ours to test, or the mutation
    // report fills with no-coverage "survivors" from code that was never meant
    // to be unit-tested and the headline score becomes meaningless.
    '!src/**/schema.ts',
    '!src/**/server.ts',
    '!src/**/cli.ts',
    '!src/**/test-db.ts',
    '!src/hull/db/client.ts',
    '!src/router.tsx',
    '!src/routes/**',
    '!src/routeTree.gen.ts',
    '!src/rigging/components/ui/**',
    '!src/rigging/lib/utils.ts',
    '!src/**/*.config.{ts,js}',
    '!src/.claude/**',

    // Live-wiring files that are entirely `v8 ignore`d for the same reason
    // (real git/exec/fs, the pi.dev extension bridge) — Stryker doesn't read
    // those coverage pragmas, so exclude the files here too.
    '!src/hull/issues/orchestrator-live.ts',
    '!src/hull/agent/extensions/build-gates/index.ts',
  ],

  // Advisory only. high/low colour the report; break is null so Stryker never
  // fails a build over a low score — the crew (and the PR review agent) judge.
  thresholds: { high: 80, low: 60, break: null },
  tempDirName: '.stryker-tmp',
}
