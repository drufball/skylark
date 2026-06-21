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
  return env.SKYLARK_FAKE_RUNTIME ? withDbName(base, SMOKE_DB_NAME) : base
}
