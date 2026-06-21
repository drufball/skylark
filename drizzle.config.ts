import { defineConfig } from 'drizzle-kit'

import { resolveDatabaseUrl } from './src/hull/db/url'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/**/schema.ts',
  out: './src/migrations',
  // Same resolver as the app, so `SKYLARK_FAKE_RUNTIME=1 npm run db:migrate`
  // targets the smoke db — never the real one.
  dbCredentials: { url: resolveDatabaseUrl() },
})
