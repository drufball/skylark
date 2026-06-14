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
    // (declarative table defs), doors (server.ts — createServerFn), the DB
    // client (driver setup), routes/router (thin routing), generated code, and
    // vendored shadcn. What's left — services, lib, views — is where the logic
    // and the tests actually live, so that's where a mutation score means
    // something.
    '!src/**/schema.ts',
    '!src/**/server.ts',
    '!src/hull/db/client.ts',
    '!src/router.tsx',
    '!src/routes/**',
    '!src/routeTree.gen.ts',
    '!src/rigging/components/ui/**',
  ],

  // Advisory only. high/low colour the report; break is null so Stryker never
  // fails a build over a low score — the crew (and the PR review agent) judge.
  thresholds: { high: 80, low: 60, break: null },
  tempDirName: '.stryker-tmp',
}
