import { expect, test, type Page } from '@playwright/test'

import { commentOnIssue, openIssue } from './helpers'

// SSE smoke: the highest-value wiring check. Proves the EventSource ↔
// /api/stream path works end to end against the real server — actor resolution,
// the subscribe/replay/live coordination, and the in-process bus fan-out —
// none of which the unit suite can exercise (it stops at runShipLogStream with
// fakes). A real issue created through the composer must surface as a live
// event on a stream that's already past replay.

interface StreamEvent {
  id: string
  type: string
  topic?: string
}

// The stream events are stashed on the page's window so we can snapshot the
// count across separate evaluate() calls (open the stream, act, then read).
type Win = Window & { __smokeSSE?: StreamEvent[] }

/** Open an issue:* stream in the page and stash every event it delivers. */
async function openIssueStream(page: Page) {
  await page.evaluate(() => {
    const events: StreamEvent[] = []
    ;(window as Win).__smokeSSE = events
    const es = new EventSource('/api/stream?topics=issue:*')
    es.addEventListener('message', (e: MessageEvent<string>) => {
      events.push(JSON.parse(e.data) as StreamEvent)
    })
  })
}

const eventCount = (page: Page) =>
  page.evaluate(() => (window as Win).__smokeSSE?.length ?? 0)

const lastEvent = (page: Page) =>
  page.evaluate(() => {
    const events = (window as Win).__smokeSSE ?? []
    return events[events.length - 1]
  })

test('an event is delivered live to a separately connected client', async ({
  browser,
}) => {
  // The real "replaces polling" promise: one client's action reaches another's
  // already-open stream live (no reload). watcher holds the stream; actor acts.
  const watcher = await browser.newPage()
  await watcher.goto('/issues')
  await openIssueStream(watcher)

  // Let the watcher's connection open and drain replay, then snapshot — anything
  // beyond this count is a genuinely live push, not replayed history.
  await watcher.waitForTimeout(1500)
  const before = await eventCount(watcher)

  // A second client opens an issue and comments on it. The comment emits a
  // durable issue.commented event → pg_notify → the in-process bus → every open
  // stream, including the watcher's.
  const actor = await browser.newPage()
  await actor.goto('/issues')
  const title = `smoke-live-${String(Date.now())}`
  await openIssue(actor, title)
  await commentOnIssue(actor, title, 'live ping')

  // The watcher receives it live, on an issue topic.
  await expect
    .poll(() => eventCount(watcher), { timeout: 15_000 })
    .toBeGreaterThan(before)
  const event = await lastEvent(watcher)
  expect(event.topic).toMatch(/^issue:/)

  await actor.close()
  await watcher.close()
})

test('reconnecting with Last-Event-ID does not re-deliver what was already seen', async ({
  page,
}) => {
  await page.goto('/issues')

  // Seed one issue so the stream has at least one durable event to replay.
  await openIssue(page, `smoke-replay-${String(Date.now())}`)

  // Read the current head of the log, then reconnect FROM that id. Replay must
  // deliver only events strictly newer — so the id we resumed from is absent.
  const headId = await page.evaluate(async () => {
    const events: { id: string }[] = await new Promise((resolve) => {
      const seen: { id: string }[] = []
      const es = new EventSource('/api/stream?topics=issue:*')
      es.addEventListener('message', (e: MessageEvent<string>) => {
        seen.push(JSON.parse(e.data) as { id: string })
      })
      setTimeout(() => {
        es.close()
        resolve(seen)
      }, 1500)
    })
    return events.at(-1)?.id ?? ''
  })
  expect(headId).not.toBe('')

  const replayedIds = await page.evaluate(async (lastId) => {
    const ids: string[] = await new Promise((resolve) => {
      const seen: string[] = []
      const es = new EventSource(
        `/api/stream?topics=issue:*&lastEventId=${lastId}`,
      )
      es.addEventListener('message', (e: MessageEvent<string>) => {
        seen.push((JSON.parse(e.data) as { id: string }).id)
      })
      setTimeout(() => {
        es.close()
        resolve(seen)
      }, 1500)
    })
    return ids
  }, headId)

  // The resume point itself is not replayed (dedup against the cursor).
  expect(replayedIds).not.toContain(headId)
})
