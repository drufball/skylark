import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type { Page } from '@playwright/test'

import { createSession, SESSION_COOKIE } from '../src/hull/auth/service'
import type { Database } from '../src/hull/db/client'
import { resolveDatabaseUrl } from '../src/hull/db/url'
import { FAKE_RUNTIME_ENV } from '../src/hull/lib/env'
import { listUsers } from '../src/hull/users/service'

// Real login replaced the `skylark_actor` dev cookie everywhere, smoke tests
// included: every route now redirects to /login without a session, and
// /api/stream refuses without one. Smoke already has a superuser db handle on
// the same (smoke) database the app uses for planting fixtures — this reuses
// that access to mint a real session directly, the fast equivalent of driving
// the login form, so a test can call `await loginAs(page, userId)` and then
// `page.goto(...)` as that user.

function smokeSystemDb(): { db: Database; close: () => Promise<void> } {
  const sql = postgres(
    resolveDatabaseUrl({ ...process.env, [FAKE_RUNTIME_ENV]: '1' }),
    { max: 1 },
  )
  const db: Database = drizzle(sql)
  return { db, close: () => sql.end() }
}

/** Log `page`'s browser context in as `userId` by planting a real session and
 * handing it the resulting cookie. */
export async function loginAs(page: Page, userId: string): Promise<void> {
  const { db, close } = smokeSystemDb()
  try {
    const { token, expiresAt } = await createSession(db, userId)
    await page.context().addCookies([
      {
        name: SESSION_COOKIE,
        value: token,
        domain: 'localhost',
        path: '/',
        expires: Math.floor(expiresAt.getTime() / 1000),
      },
    ])
  } finally {
    await close()
  }
}

/** Log in as whichever human `global-setup`'s `npm run users seed` created —
 * the default actor for smoke tests that don't care which crew member they're
 * acting as. Found by `type`, not by guessing a handle: `npm run users seed`
 * honors a local `.env`'s `SKYLARK_OPERATOR` (its script loads it explicitly),
 * but this test process doesn't, so the two would disagree on the handle
 * whenever a developer's own `.env` overrides it — `seedCrew` only ever seeds
 * one human, so `type` finds it regardless. */
export async function loginAsOperator(page: Page): Promise<void> {
  const { db, close } = smokeSystemDb()
  try {
    const operator = (await listUsers(db)).find((u) => u.type === 'human')
    if (!operator)
      throw new Error('operator not seeded — global-setup should have')
    await loginAs(page, operator.id)
  } finally {
    await close()
  }
}
