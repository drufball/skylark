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
 * Smoke/test mode (`SKYLARK_FAKE_RUNTIME` set) FORCES the connection onto a
 * dedicated `skylark_smoke` database — same server, never the base db — so a
 * smoke run (which boots the REAL server) can't touch your dev data even if
 * DATABASE_URL points there. The one place that rule lives; both resolvers
 * apply it so the superuser and app connections never split across databases.
 */
function withSmoke(
  url: string,
  env: Record<string, string | undefined>,
): string {
  return env[FAKE_RUNTIME_ENV] ? withDbName(url, SMOKE_DB_NAME) : url
}

/**
 * The SUPERUSER connection: DATABASE_URL if set, else the local default (with
 * the smoke-db swap). Used by migrations and the fixed system plumbing
 * (`systemDb`) — never by a request path.
 */
export function resolveDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return withSmoke(env.DATABASE_URL ?? DEFAULT_DATABASE_URL, env)
}

/**
 * The URL the APP connects on — the same database as `resolveDatabaseUrl` but as
 * the non-superuser `app_user`, so Row-Level Security applies to every query by
 * default (a forgotten `withActor` sees nothing, not everything). Honors
 * `APP_DATABASE_URL` for a deployment with rotated credentials; otherwise reuses
 * the superuser URL with the app_user credential (`app_user` / `app_user` — see
 * migration 0009). The smoke-db swap rides along, so a smoke run is app_user too.
 */
export function resolveAppUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const base =
    env.APP_DATABASE_URL ??
    withCredentials(
      env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
      APP_ROLE,
      APP_ROLE,
    )
  return withSmoke(base, env)
}
