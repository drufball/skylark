// The single list of "not ours to test", shared by both quality gates so they
// can never drift. Vitest's coverage `exclude` and Stryker's `mutate` glob both
// derive from here: the same knowledge, declared once.
//
// Why a standalone `.mjs`: `vitest.config.ts` is transpiled by Vite (so it can
// import this), and `stryker.config.mjs` is loaded by plain Node (so it can't
// import a `.ts`). A `.mjs` is the one format both loaders accept; the sibling
// `test-excludes.d.mts` gives tsc the types when `vitest.config.ts` imports it.

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
]

/**
 * Excluded from MUTATION only, two reasons:
 *
 * 1. Whole-file `v8 ignore`d live wiring (real git/exec/fs, the pi.dev
 *    extension bridge). Coverage skips these via the in-file pragma, so they
 *    aren't in SHARED_EXCLUDES — but Stryker can't read `v8 ignore` pragmas,
 *    so it has to be told by path. Only files ignored in their ENTIRETY
 *    belong here; partially ignored files (runtime.ts, events/bus.ts,
 *    users/actor.ts, agent/background.ts, rigging/lib/use-ship-log.ts) keep
 *    real tested logic and stay in the mutate set.
 *
 * 2. Tested code whose mutants would run real subprocesses with corrupted
 *    arguments. files/git.ts is covered by tests against a throwaway repo,
 *    but Stryker's sandbox is a directory copy, not a process jail: a mutant
 *    that breaks repoRoot resolution makes `git` discover the ENCLOSING repo
 *    — this actual repository — and commit/merge/branch-delete against it
 *    (observed: a sweep committed to the real files/staging branch). git.ts
 *    also fails closed at runtime (assertOwnRepo), but a mutant can delete
 *    that guard too, so the file stays out of the mutation set.
 */
export const STRYKER_ONLY_EXCLUDES = [
  'src/hull/issues/orchestrator-live.ts',
  'src/hull/chat/orchestrator-live.ts',
  'src/hull/files/live.ts',
  'src/hull/files/git.ts',
  'src/hull/notifications/live.ts',
  'src/hull/agent/extensions/build-gates/index.ts',
]
