import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { asActor, defined, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import {
  addMessage,
  addWidget,
  answerWidget,
  createCanvasPage,
  createChat,
  createSchedule,
  ensureChatVisible,
  getCanvasPage,
  getChat,
  getSchedule,
  getViewPage,
  getWidget,
  listCanvasPages,
  listChatSummaries,
  listMembers,
  listMessages,
  listOpenWidgets,
  listSchedules,
  setViewPage,
} from './service'

// Proves the migration 0007 RLS policies actually filter chat reads/writes by
// membership — the by-construction half of "membership is visibility". Fixtures
// are arranged as the PGlite superuser (RLS bypassed); every assertion runs
// through `asActor`, which drops to app_user + sets app.actor, so RLS bites.

describe('chat access (RLS)', () => {
  let db: Database
  let close: () => Promise<void>
  let alice: string
  let bob: string
  let c1: string // alice + bob
  let c2: string // bob only

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    alice = uuidv7()
    bob = uuidv7()
    await createUser(db, {
      id: alice,
      handle: 'alice',
      displayName: 'Alice',
      type: 'human',
    })
    await createUser(db, {
      id: bob,
      handle: 'bob',
      displayName: 'Bob',
      type: 'human',
    })
    c1 = uuidv7()
    c2 = uuidv7()
    await createChat(db, { id: c1, memberIds: [alice, bob] })
    await createChat(db, { id: c2, memberIds: [bob] })
    await addMessage(db, {
      id: uuidv7(),
      chatId: c1,
      authorId: alice,
      body: 'in c1',
    })
    await addMessage(db, {
      id: uuidv7(),
      chatId: c2,
      authorId: bob,
      body: 'in c2',
    })
  })
  afterEach(() => close())

  it('a crew member can CREATE a chat they are in — under RLS, like the web door', async () => {
    // Regression: insert-with-RETURNING needs SELECT visibility, but the
    // membership rows that grant it land after the chat row. The door path
    // (withCurrentActor → createChat) must work as a plain crew member.
    const chatId = uuidv7()
    const created = await asActor(db, alice, (tx) =>
      createChat(tx, { id: chatId, memberIds: [alice, bob] }),
    )
    expect(created.id).toBe(chatId)
    // And the creator can immediately read it back.
    const seen = await asActor(db, alice, (tx) => getChat(tx, chatId))
    expect(seen?.id).toBe(chatId)
  })

  it('refuses to create a chat the creator is not in — the row would be invisible', async () => {
    await expect(
      asActor(db, alice, (tx) =>
        createChat(tx, { id: uuidv7(), memberIds: [bob] }),
      ),
    ).rejects.toThrow(/creator must be one of memberIds/)
  })

  it('hides a non-member chat’s messages and reveals a member’s', async () => {
    const aliceSeesC2 = await asActor(db, alice, (tx) => listMessages(tx, c2))
    expect(aliceSeesC2).toEqual([]) // alice is not in c2

    const bobSeesC2 = await asActor(db, bob, (tx) => listMessages(tx, c2))
    expect(bobSeesC2.map((m) => m.body)).toEqual(['in c2'])

    const aliceSeesC1 = await asActor(db, alice, (tx) => listMessages(tx, c1))
    expect(aliceSeesC1.map((m) => m.body)).toEqual(['in c1'])
  })

  it('ensureChatVisible resolves for a member, refuses a non-member', async () => {
    // alice is in c1 but not c2.
    await expect(
      asActor(db, alice, (tx) => ensureChatVisible(tx, c1)),
    ).resolves.toBeUndefined()
    await expect(
      asActor(db, alice, (tx) => ensureChatVisible(tx, c2)),
    ).rejects.toThrow('not a member')
  })

  it('hides a non-member chat row entirely', async () => {
    expect(await asActor(db, alice, (tx) => getChat(tx, c2))).toBeUndefined()
    expect(await asActor(db, bob, (tx) => getChat(tx, c2))).toBeDefined()
  })

  it('shows the full roster of a chat you’re in (no RLS recursion)', async () => {
    const roster = await asActor(db, alice, (tx) => listMembers(tx, c1))
    expect(roster.map((m) => m.handle).sort()).toEqual(['alice', 'bob'])
  })

  it('lists only the chats the actor is a member of', async () => {
    const aliceChats = await asActor(db, alice, (tx) =>
      listChatSummaries(tx, alice),
    )
    expect(aliceChats.map((c) => c.id)).toEqual([c1])

    const bobChats = await asActor(db, bob, (tx) => listChatSummaries(tx, bob))
    expect(bobChats.map((c) => c.id).sort()).toEqual([c1, c2].sort())
  })

  it('lets a member post, and blocks a non-member from posting', async () => {
    await asActor(db, alice, (tx) =>
      addMessage(tx, { id: uuidv7(), chatId: c1, authorId: alice, body: 'ok' }),
    )
    const c1msgs = await asActor(db, alice, (tx) => listMessages(tx, c1))
    expect(c1msgs.map((m) => m.body)).toContain('ok')

    // alice is not in c2 → the WITH CHECK policy rejects the insert.
    await expect(
      asActor(db, alice, (tx) =>
        addMessage(tx, {
          id: uuidv7(),
          chatId: c2,
          authorId: alice,
          body: 'sneak',
        }),
      ),
    ).rejects.toThrow()
  })

  it('schedules ride membership: a member creates + reads, a non-member is blocked', async () => {
    const timing = {
      fireAt: new Date(),
      intervalMinutes: null,
      nextFireAt: null,
    }
    // alice is in c1 → may create a schedule there and read it back.
    const created = await asActor(db, alice, (tx) =>
      createSchedule(tx, {
        id: uuidv7(),
        chatId: c1,
        authorId: alice,
        body: 'standup',
        createdById: alice,
        ...timing,
      }),
    )
    const seen = await asActor(db, alice, (tx) => listSchedules(tx, c1))
    expect(seen.map((s) => s.id)).toEqual([created.id])

    // alice is NOT in c2 → the WITH CHECK policy rejects the insert.
    await expect(
      asActor(db, alice, (tx) =>
        createSchedule(tx, {
          id: uuidv7(),
          chatId: c2,
          authorId: alice,
          body: 'sneak',
          createdById: alice,
          ...timing,
        }),
      ),
    ).rejects.toThrow()
  })

  it('widgets ride membership: a member raises + reads, a non-member is blocked', async () => {
    // alice is in c1 → may raise a widget there and see it in the stack.
    const raised = await asActor(db, alice, (tx) =>
      addWidget(tx, {
        id: uuidv7(),
        chatId: c1,
        kind: 'choice',
        props: { question: 'Ship it?', options: ['Yes', 'No'] },
        createdById: alice,
      }),
    )
    const seen = await asActor(db, alice, (tx) => listOpenWidgets(tx, c1))
    expect(seen.map((w) => w.id)).toEqual([raised.id])

    // alice is NOT in c2 → the WITH CHECK policy rejects the insert.
    await expect(
      asActor(db, alice, (tx) =>
        addWidget(tx, {
          id: uuidv7(),
          chatId: c2,
          kind: 'choice',
          props: { question: 'sneak', options: ['Yes'] },
          createdById: alice,
        }),
      ),
    ).rejects.toThrow()
  })

  it('hides a non-member chat’s widgets entirely, and refuses to answer one', async () => {
    const id = uuidv7()
    // Arrange as superuser (RLS bypassed): a widget on bob-only c2.
    await addWidget(db, {
      id,
      chatId: c2,
      kind: 'choice',
      props: { question: 'Private?', options: ['Yes', 'No'] },
      createdById: bob,
    })
    // alice is not in c2 → sees neither the stack nor the row…
    expect(await asActor(db, alice, (tx) => listOpenWidgets(tx, c2))).toEqual(
      [],
    )
    expect(await asActor(db, alice, (tx) => getWidget(tx, id))).toBeUndefined()
    expect(await asActor(db, bob, (tx) => getWidget(tx, id))).toBeDefined()

    // …so answering it is a clean refusal, and puts no message in bob's chat.
    await expect(
      asActor(db, alice, (tx) =>
        answerWidget(tx, { widgetId: id, actorId: alice, value: 'Yes' }),
      ),
    ).rejects.toThrow(/no such widget/)
    expect(await listMessages(db, c2)).toHaveLength(1) // just bob's original
    expect(defined(await getWidget(db, id)).dismissedAt).toBeNull()
  })

  it('lets a member answer a widget in their own chat', async () => {
    const id = uuidv7()
    await addWidget(db, {
      id,
      chatId: c1,
      kind: 'choice',
      props: { question: 'Ship it?', options: ['Yes', 'No'] },
      createdById: bob,
    })
    const message = await asActor(db, alice, (tx) =>
      answerWidget(tx, { widgetId: id, actorId: alice, value: 'Yes' }),
    )
    expect(message.authorId).toBe(alice)
    expect(await asActor(db, alice, (tx) => listOpenWidgets(tx, c1))).toEqual(
      [],
    )
  })

  it('hides a non-member chat’s schedules entirely', async () => {
    const id = uuidv7()
    // Arrange as superuser (RLS bypassed): a schedule on bob-only c2.
    await createSchedule(db, {
      id,
      chatId: c2,
      authorId: bob,
      body: 'private',
      createdById: bob,
      fireAt: new Date(),
      intervalMinutes: null,
      nextFireAt: null,
    })
    // alice is not in c2 → sees neither the list nor the row.
    expect(await asActor(db, alice, (tx) => listSchedules(tx, c2))).toEqual([])
    expect(
      await asActor(db, alice, (tx) => getSchedule(tx, id)),
    ).toBeUndefined()
    expect(await asActor(db, bob, (tx) => getSchedule(tx, id))).toBeDefined()
  })
  it('canvas pages ride membership: a member creates + reads, a non-member is blocked', async () => {
    // The canvas is a piece of the conversation, so it defers to exactly the
    // policy chat_messages and chat_widgets do (migration 0034 → 0007's helper).
    const created = await asActor(db, alice, (tx) =>
      createCanvasPage(tx, {
        id: uuidv7(),
        chatId: c1,
        title: 'Ops',
        actorId: alice,
      }),
    )
    expect(
      (await asActor(db, alice, (tx) => listCanvasPages(tx, c1))).map(
        (p) => p.id,
      ),
    ).toEqual([created.id])

    // alice is NOT in c2 → the WITH CHECK policy rejects the insert.
    await expect(
      asActor(db, alice, (tx) =>
        createCanvasPage(tx, {
          id: uuidv7(),
          chatId: c2,
          title: 'sneak',
          actorId: alice,
        }),
      ),
    ).rejects.toThrow()
  })

  it('hides a non-member chat’s canvas pages entirely', async () => {
    const id = uuidv7()
    // Arrange as superuser (RLS bypassed): a page on bob-only c2.
    await createCanvasPage(db, {
      id,
      chatId: c2,
      title: 'Private',
      actorId: bob,
    })
    expect(await asActor(db, alice, (tx) => listCanvasPages(tx, c2))).toEqual(
      [],
    )
    expect(
      await asActor(db, alice, (tx) => getCanvasPage(tx, id)),
    ).toBeUndefined()
    expect(await asActor(db, bob, (tx) => getCanvasPage(tx, id))).toBeDefined()
  })

  it('view state is YOURS: you may write your own row, never another member’s', async () => {
    // The load-bearing half of "per person, not per chat". An agent is a member
    // with its own actor, so nothing but the policy stands between it and
    // dragging somebody's view somewhere they didn't ask to be.
    const pageId = uuidv7()
    await createCanvasPage(db, {
      id: pageId,
      chatId: c1,
      title: 'Ops',
      actorId: alice,
    })
    await asActor(db, alice, (tx) =>
      setViewPage(tx, { chatId: c1, userId: alice, pageId }),
    )
    expect(await asActor(db, alice, (tx) => getViewPage(tx, c1, alice))).toBe(
      pageId,
    )

    await expect(
      asActor(db, alice, (tx) =>
        setViewPage(tx, { chatId: c1, userId: bob, pageId }),
      ),
    ).rejects.toThrow()
    expect(await getViewPage(db, c1, bob)).toBeNull()
  })

  it('keeps one member’s view unreadable to another', async () => {
    const pageId = uuidv7()
    await createCanvasPage(db, {
      id: pageId,
      chatId: c1,
      title: 'Ops',
      actorId: bob,
    })
    await setViewPage(db, { chatId: c1, userId: bob, pageId })
    // Same chat, both members — and alice still sees nothing of bob's view.
    expect(
      await asActor(db, alice, (tx) => getViewPage(tx, c1, bob)),
    ).toBeNull()
    expect(await asActor(db, bob, (tx) => getViewPage(tx, c1, bob))).toBe(
      pageId,
    )
  })
})
