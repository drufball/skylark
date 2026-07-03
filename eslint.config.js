import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

// `systemDb` (hull/db/client) is the RLS-BYPASSING superuser handle. Crew
// access is fail-closed by construction only as long as request/agent paths go
// through `db` + `withActor`; handing them `systemDb` silently reopens the
// whole leak. Import-banned everywhere (hoisted so the per-deck overrides
// below can add their own restrictions without dropping this one — a scoped
// `no-restricted-imports` config REPLACES the global one, it doesn't merge).
const systemDbBan = {
  name: '@hull/db/client',
  importNames: ['systemDb'],
  message:
    'systemDb bypasses RLS — use `db` + `withActor` (or `withCurrentActor`). Only fixed system plumbing may use it; if this file genuinely needs every row, add it to the allowlist override in eslint.config.js.',
}

// Lint = correctness only. Formatting belongs to Prettier, and `prettier` (last)
// switches off every rule that would overlap, so the two never fight.
export default defineConfig(
  {
    ignores: [
      'node_modules',
      '.output',
      '.nitro',
      '.pgdata',
      '.stryker-tmp', // transient mutation-test sandbox (gitignored); never lint its instrumented copies
      '.claude/worktrees', // scratch git worktrees from agentic reviews
      'src/routeTree.gen.ts', // generated
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Plain-JS config files (this file): syntactic linting only, no type-aware rules.
  {
    files: ['**/*.{js,cjs,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // Node scripts outside the app (CI publishers, repo tooling).
  {
    files: ['.github/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', fetch: 'readonly' },
    },
  },
  {
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs['recommended-latest'].rules,
  },
  // The systemDb ban, everywhere…
  {
    rules: {
      'no-restricted-imports': ['error', { paths: [systemDbBan] }],
    },
  },
  // …plus the deck direction (src/zine.md): imports flow home → rigging →
  // hull, never the other way. Only the src/ serving layer (routes/router)
  // crosses all three. The `**/…/**` patterns catch relative paths that dodge
  // the aliases.
  {
    files: ['src/hull/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [systemDbBan],
          patterns: [
            {
              group: ['@rigging/*', '@home/*', '**/rigging/**', '**/home/**'],
              message:
                'The hull imports nothing above it (home → rigging → hull) — a hull that reaches upward breaks every ship that clones it.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/rigging/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [systemDbBan],
          patterns: [
            {
              group: ['@home/*', '**/home/**'],
              message:
                'Rigging must not import home — home is sovereign, the stdlib cannot depend on it.',
            },
          ],
        },
      ],
    },
  },
  // …except the fixed system plumbing that legitimately needs all rows: the
  // agent runtime (persists transcripts) and the orchestrators (reconcile +
  // drive the runtime). The agent CLI drives that same runtime (new/send/cancel
  // a turn) and so runs it on systemDb too — its discrete queries still go
  // through `db` + `withCliActor`. A further importer has to consciously join.
  {
    files: [
      'src/hull/agent/server.ts',
      'src/hull/agent/cli.ts',
      'src/hull/chat/orchestrator-live.ts',
      'src/hull/issues/orchestrator-live.ts',
      // The notifications reactor fans out inbox rows ACROSS users — plumbing
      // no single actor's RLS context could run.
      'src/hull/notifications/live.ts',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  prettier,
)
