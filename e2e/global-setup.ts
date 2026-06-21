import { execSync } from 'node:child_process'

import postgres from 'postgres'

import {
  resolveDatabaseUrl,
  SMOKE_DB_NAME,
  withDbName,
} from '../src/hull/db/url'

// Stand up a clean, ISOLATED database for the smoke run. Everything here is
// keyed off SKYLARK_FAKE_RUNTIME=1, the same flag the dev server boots with —
// so the resolver (src/hull/db/url.ts) points the app, migrations, and the seed
// at `skylark_smoke`, never the real `skylark` the dev server uses. A smoke run
// can't touch your dev data.
//
// Steps: ensure the smoke db exists → migrate it → truncate (clean slate) →
// seed the crew (currentActor would otherwise refuse the stream).
export default async function globalSetup(): Promise<void> {
  const smokeEnv = { ...process.env, SKYLARK_FAKE_RUNTIME: '1' }
  const smokeUrl = resolveDatabaseUrl(smokeEnv)

  // 1. Ensure the smoke database exists. CREATE DATABASE can't run from inside
  //    the target db, so connect to the `postgres` maintenance db on the same
  //    server. Idempotent: skip if it's already there.
  const admin = postgres(withDbName(smokeUrl, 'postgres'), { max: 1 })
  try {
    const rows = await admin<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${SMOKE_DB_NAME}) AS exists`
    if (!rows[0].exists)
      await admin.unsafe(`CREATE DATABASE "${SMOKE_DB_NAME}"`)
  } finally {
    await admin.end()
  }

  // 2. Migrate it (drizzle-kit honors the same flag → smoke db).
  execSync('npm run db:migrate', { stdio: 'inherit', env: smokeEnv })

  // 3. Clean slate: truncate any data left by a previous run.
  const dbc = postgres(smokeUrl, { max: 1 })
  try {
    const tables = await dbc<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE 'drizzle%'`
    if (tables.length > 0) {
      const list = tables.map((t) => `"${t.tablename}"`).join(', ')
      await dbc.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`)
    }
  } finally {
    await dbc.end()
  }

  // 4. Seed the crew into the smoke db (the CLI's client honors the flag too).
  execSync('npm run users seed', { stdio: 'inherit', env: smokeEnv })
}
