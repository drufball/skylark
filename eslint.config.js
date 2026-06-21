import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

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
  {
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs['recommended-latest'].rules,
  },
  // `systemDb` (hull/db/client) is the RLS-BYPASSING superuser handle. Crew
  // access is fail-closed by construction only as long as request/agent paths
  // go through `db` + `withActor`; handing them `systemDb` silently reopens the
  // whole leak. So it's import-banned everywhere…
  {
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@hull/db/client',
              importNames: ['systemDb'],
              message:
                'systemDb bypasses RLS — use `db` + `withActor` (or `withCurrentActor`). Only fixed system plumbing may use it; if this file genuinely needs every row, add it to the allowlist override in eslint.config.js.',
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
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  prettier,
)
