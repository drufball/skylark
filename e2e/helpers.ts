import { expect, type Page } from '@playwright/test'

/**
 * Open an issue through the real composer. Retries the open-click until the
 * Title field appears: the page is server-rendered, so an early click can land
 * before React has hydrated the button's handler (and the app holds an
 * EventSource open, so we can't wait on network-idle). `toPass` re-clicks until
 * the composer actually opens, then fills and submits.
 */
export async function openIssue(page: Page, title: string): Promise<void> {
  await expect(async () => {
    await page.getByRole('button', { name: 'New issue' }).click()
    await expect(page.getByPlaceholder('Title')).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 15_000 })

  await page.getByPlaceholder('Title').fill(title)
  await page.getByRole('button', { name: 'Open issue' }).click()
}

/**
 * Comment on an issue from the board: open its thread, then post. A comment
 * emits a durable `issue.commented` event on the issue's topic — a hermetic
 * event trigger (unlike a build transition, which would touch real git). Same
 * hydration-safe retry as opening the composer.
 */
export async function commentOnIssue(
  page: Page,
  issueTitle: string,
  body: string,
): Promise<void> {
  await expect(async () => {
    await page.getByText(issueTitle).click() // board card → thread
    await expect(page.getByPlaceholder(/Comment/)).toBeVisible({
      timeout: 1000,
    })
  }).toPass({ timeout: 15_000 })

  await page.getByPlaceholder(/Comment/).fill(body)
  await page.getByRole('button', { name: 'Add comment' }).click()
}
