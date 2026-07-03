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

import {
  MUTATE_SOURCES,
  SHARED_EXCLUDES,
  STRYKER_ONLY_EXCLUDES,
} from './test-excludes.mjs'

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  packageManager: 'npm',
  // Reuses vitest.config.ts as-is, so the suite runs on in-memory PGlite —
  // mutation testing needs no Postgres, no Docker, no network, same as `npm test`.
  testRunner: 'vitest',
  reporters: ['html', 'json', 'clear-text', 'progress'],
  coverageAnalysis: 'perTest',

  // What's left after the excludes — services, lib, views — is where the logic
  // and the tests live, so that's where a mutation score means something. The
  // exclude list is shared with vitest.config.ts (see test-excludes.mjs) so the
  // two gates can't drift; the `!`-prefix is the only transform. Note this only
  // mirrors coverage for files ignored in their ENTIRETY — partially `v8
  // ignore`d files still have their ignored regions mutated here, since Stryker
  // can't read the pragma.
  mutate: [
    ...MUTATE_SOURCES,
    ...SHARED_EXCLUDES.map((p) => `!${p}`),
    ...STRYKER_ONLY_EXCLUDES.map((p) => `!${p}`),
  ],

  // Advisory only. high/low colour the report; break is null so Stryker never
  // fails a build over a low score — the crew (and the PR review agent) judge.
  thresholds: { high: 80, low: 60, break: null },
  tempDirName: '.stryker-tmp',

  // Keep tool state out of the sandbox copy: the tests never touch it, and the
  // `tessl install` symlinks under .claude/skills and .agents/skills abort the
  // copy (ENOTSUP).
  ignorePatterns: ['/.claude', '/.agents', '/.tessl', '/plugins', '/reports'],
}
