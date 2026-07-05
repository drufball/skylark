import { expect, test } from '@playwright/test'

import { loginAsOperator } from './auth'

// Boot smoke: the real app serves its routes, the loader-backed health door
// answers, and the database is reachable. If the server, the route wiring, or
// the DB client regressed, this fails before any feature test runs.

test('the status route renders and reports the database up', async ({
  page,
}) => {
  await loginAsOperator(page)
  await page.goto('/status')

  // The shell rendered (route + view).
  await expect(page.getByText('Skylark')).toBeVisible()

  // The health loader ran server-side and the DB is reachable — "database: up".
  // (If Postgres were down the app degrades to "down" rather than crashing, so
  // this also asserts the smoke environment is wired correctly.)
  await expect(page.getByText('database:')).toBeVisible()
  await expect(page.getByText('up', { exact: true })).toBeVisible()
})

test('the issues board route loads', async ({ page }) => {
  // A second route to prove routing + a data loader door work, not just /status.
  await loginAsOperator(page)
  await page.goto('/issues')
  await expect(page.getByText('New issue')).toBeVisible()
})

test('an unauthenticated visit to any route redirects to /login', async ({
  page,
}) => {
  // No loginAsOperator — this is the whole point of the root beforeLoad guard.
  await page.goto('/issues')
  await expect(page).toHaveURL(/\/login$/)
})
