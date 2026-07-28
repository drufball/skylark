import { uuidv7 } from '@earendil-works/pi-agent-core'
import { expect, test } from '@playwright/test'

import { createChat } from '../src/hull/chat/service'
import { listUsers } from '../src/hull/users/service'

import { loginAs, loginAsOperator, smokeSystemDb } from './auth'

// The front door moved in #cse8: `/` is the home canvas and chat is at `/chat`.
// The old `/?chat=<id>` shape did NOT go away — agents posted those links into
// conversations for months and the crew bookmarked them — so `index.tsx`'s
// `beforeLoad` forwards it with the parameter intact.
//
// That redirect's entire job is to keep working for years, and until now the
// only thing that had ever exercised it was a browser session somebody drove by
// hand. A unit test can't reach it: it is route wiring, and route wiring is what
// smoke exists for. `?new=true` is here for the same reason and one worse — it
// had never been driven in a browser at all, only read.

/** The seeded human, the way `loginAsOperator` finds them. */
async function operatorId(): Promise<string> {
  const { db, close } = smokeSystemDb()
  try {
    const operator = (await listUsers(db)).find((u) => u.type === 'human')
    if (!operator) throw new Error('operator not seeded')
    return operator.id
  } finally {
    await close()
  }
}

test('the old /?chat=<id> link still lands in that conversation', async ({
  page,
}) => {
  const me = await operatorId()
  const chatId = uuidv7()
  const { db, close } = smokeSystemDb()
  try {
    await createChat(db, {
      id: chatId,
      title: 'A link from last year',
      memberIds: [me],
    })
  } finally {
    await close()
  }

  await loginAs(page, me)
  await page.goto(`/?chat=${chatId}`)

  // Forwarded, with the parameter carried across — not swallowed onto a home
  // canvas that would have looked like the link simply stopped working.
  await expect(page).toHaveURL(`/chat?chat=${chatId}`)
  await expect(page.getByText('A link from last year').first()).toBeVisible()
})

test('the old /?new=true link still opens the new-chat composer', async ({
  page,
}) => {
  await loginAsOperator(page)
  await page.goto('/?new=true')

  await expect(page).toHaveURL('/chat?new=true')
  await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible()
})

test('a plain / is the home canvas, and is never redirected', async ({
  page,
}) => {
  // The other half of the claim: the forward fires on the legacy parameters and
  // on nothing else, or the front door would have moved right back to chat.
  await loginAsOperator(page)
  await page.goto('/')

  await expect(page).toHaveURL('/')
  await expect(page.getByTestId('home-canvas')).toBeVisible()
})
