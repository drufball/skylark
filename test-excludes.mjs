// The single list of "not ours to test", shared by both quality gates so they
// can never drift. Vitest's coverage `exclude` and Stryker's `mutate` glob both
// derive from here: the same knowledge, declared once.
//
// Why a standalone `.mjs`: `vitest.config.ts` is transpiled by Vite (so it can
// import this), and `stryker.config.mjs` is loaded by plain Node (so it can't
// import a `.ts`). A `.mjs` is the one format both loaders accept; the sibling
// `test-excludes.d.ts` gives tsc the types when `vitest.config.ts` imports it.

/**
 * Code excluded from BOTH gates: it isn't ours to test, or carries no logic —
 * schemas (declarative tables), doors (server.ts/cli.ts), the DB client + test
 * harness, routes/router (thin routing), generated code, configs, vendored
 * shadcn, and the skill tree.
 */
export const SHARED_EXCLUDES = [
  'src/**/*.test.{ts,tsx}',
  'src/**/*.d.ts',
  'src/**/schema.ts',
  'src/**/server.ts',
  'src/**/cli.ts',
  'src/**/test-db.ts',
  'src/**/test-support.ts',
  'src/hull/db/client.ts',
  'src/router.tsx',
  'src/routes/**',
  'src/routeTree.gen.ts',
  'src/rigging/components/ui/**',
  'src/rigging/lib/utils.ts',
  'src/**/*.config.{ts,js}',
  'src/.claude/**',
]

/**
 * Whole-file `v8 ignore`d live wiring (real git/exec/fs, the pi.dev extension
 * bridge). Coverage skips these via the in-file pragma, so they aren't in
 * SHARED_EXCLUDES — but Stryker can't read `v8 ignore` pragmas, so it has to be
 * told by path. Only files ignored in their ENTIRETY belong here; partially
 * ignored files (runtime.ts, events/bus.ts, users/actor.ts, agent/background.ts,
 * rigging/lib/use-ship-log.ts) keep real tested logic and stay in the mutate set.
 */
export const STRYKER_ONLY_EXCLUDES = [
  'src/hull/issues/orchestrator-live.ts',
  'src/hull/files/live.ts',
  'src/hull/agent/extensions/build-gates/index.ts',
]
