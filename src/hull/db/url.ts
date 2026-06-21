import { FAKE_RUNTIME_ENV } from '@hull/lib/env'

// Which Postgres the process connects to. One resolver so every entry point —
// the query client, the LISTEN connection, drizzle-kit, the CLIs — agrees, and
// so the smoke/test switch lives in exactly one place.

/** Local default. Override with DATABASE_URL (see .env / .env.example). */
export const DEFAULT_DATABASE_URL =
  'postgres://postgres:postgres@localhost:5432/skylark'

/** The dedicated database smoke/test runs use — never the real one. */
export const SMOKE_DB_NAME = 'skylark_smoke'

/** Swap the database name in a connection URL, keeping host/port/credentials. */
export function withDbName(url: string, name: string): string {
  const u = new URL(url)
  u.pathname = `/${name}`
  return u.toString()
}

/** The non-superuser role the app connects as, so RLS applies by default. */
export const APP_ROLE = 'app_user'

/** Swap the credentials in a connection URL, keeping host/port/database. */
export function withCredentials(
  url: string,
  user: string,
  password: string,
): string {
  const u = new URL(url)
  u.username = user
  u.password = password
  return u.toString()
}

/**
 * The URL the APP connects on — the same server/database as
 * `resolveDatabaseUrl`, but as the non-superuser `app_user` so Row-Level
 * Security applies to every query by default (a forgotten `withActor` sees
 * nothing, not everything). `APP_DATABASE_URL` overrides it outright for a
 * deployment with rotated credentials; otherwise the superuser URL is reused
 * with the app_user credential (`app_user` / `app_user` — see migration 0009).
 * The smoke-db swap rides along, so a smoke run connects as app_user too.
 */
export function resolveAppUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.APP_DATABASE_URL) {
    return env[FAKE_RUNTIME_ENV]
      ? withDbName(env.APP_DATABASE_URL, SMOKE_DB_NAME)
      : env.APP_DATABASE_URL
  }
  return withCredentials(resolveDatabaseUrl(env), APP_ROLE, APP_ROLE)
}

/**
 * Smoke/test mode (`SKYLARK_FAKE_RUNTIME` set) is FORCED onto a dedicated
 * `skylark_smoke` database — same server as DATABASE_URL/default, never the base
 * db itself — so a smoke run (which boots the REAL server) can't write to your
 * dev data even if DATABASE_URL points there. This is the same flag that swaps
 * the live agent for the fake: one switch means "this is a test context", and it
 * isolates both the model AND the data.
 *
 * Otherwise: DATABASE_URL if set, else the local default.
 */
export function resolveDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const base = env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  return env[FAKE_RUNTIME_ENV] ? withDbName(base, SMOKE_DB_NAME) : base
}
