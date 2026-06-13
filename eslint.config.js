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
  prettier,
)
