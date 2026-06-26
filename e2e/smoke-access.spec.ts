import { uuidv7 } from '@earendil-works/pi-agent-core'
import { expect, test, type Page } from '@playwright/test'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

import { addMessage, chatTopic, createChat } from '../src/hull/chat/service'
import type { Database } from '../src/hull/db/client'
import { resolveDatabaseUrl } from '../src/hull/db/url'
import { FAKE_RUNTIME_ENV } from '../src/hull/lib/env'
import { createUser, getUserByHandle } from '../src/hull/users/service'

// Crew-access smoke: the connection-flip's end-to-end proof. The app now
// connects as the non-superuser `app_user`, so RLS gates the LIVE stream — not
// just the unit suite (asActor) or the in-code door checks. As the SUPERUSER
// (bypassing RLS) we plant a private chat that does NOT include drufball (the
// default web actor); then, over the running app, drufball must see none of its
// events while a member sees them. If the flip wired a path wrong this is what
// catches it: a leak (fail-open) here, or an empty member view (fail-closed).

interface Frame {
  type: string
}

/** Subscribe to `topic` in the page, collect frames for `ms`, return them. */
function collectFrames(
  page: Page,
  topic: string,
  ms: number,
): Promise<Frame[]> {
  return page.evaluate(
    ({ topic, ms }) =>
      new Promise<Frame[]>((resolve) => {
        const seen: Frame[] = []
        const es = new EventSource(`/api/stream?topics=${topic}`)
        es.addEventListener('message', (e: MessageEvent<string>) => {
          seen.push(JSON.parse(e.data) as Frame)
        })
        setTimeout(() => {
          es.close()
          resolve(seen)
        }, ms)
      }),
    { topic, ms },
  )
}

let privateChatTopic: string

test.beforeAll(async () => {
  // Plant the fixture as the superuser, on the same smoke db the app uses.
  const sql = postgres(
    resolveDatabaseUrl({ ...process.env, [FAKE_RUNTIME_ENV]: '1' }),
    { max: 1 },
  )
  const sysDb: Database = drizzle(sql)
  try {
    const sam = uuidv7()
    await createUser(sysDb, {
      id: sam,
      handle: 'sam',
      displayName: 'Sam',
      type: 'human',
    })
    const tilde = await getUserByHandle(sysDb, 'tilde')
    if (!tilde) throw new Error('tilde not seeded — global-setup should have')
    const chatId = uuidv7()
    // sam + an agent, deliberately WITHOUT drufball.
    await createChat(sysDb, { id: chatId, memberIds: [sam, tilde.id] })
    await addMessage(sysDb, {
      id: uuidv7(),
      chatId,
      authorId: sam,
      body: 'private to sam + tilde',
    })
    privateChatTopic = chatTopic(chatId)
  } finally {
    await sql.end()
  }
})

test('the live stream hides a private chat from a non-member', async ({
  browser,
}) => {
  // Default web actor is drufball, who is NOT in the chat.
  const page = await browser.newPage()
  await page.goto('/')
  const frames = await collectFrames(page, privateChatTopic, 2500)
  expect(frames).toHaveLength(0) // RLS, as app_user, hides every event
  await page.close()
})

test('the live stream delivers a private chat to a member', async ({
  browser,
}) => {
  // Act as sam (a member) via the dev actor cookie.
  const ctx = await browser.newContext()
  await ctx.addCookies([
    { name: 'skylark_actor', value: 'sam', domain: 'localhost', path: '/' },
  ])
  const page = await ctx.newPage()
  await page.goto('/')
  const frames = await collectFrames(page, privateChatTopic, 2500)
  expect(frames.some((f) => f.type === 'chat.message_posted')).toBe(true)
  await ctx.close()
})
