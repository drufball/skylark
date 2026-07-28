import { uuidv7 } from '@earendil-works/pi-agent-core'
import { createServerFn } from '@tanstack/react-start'

import { withCurrentActor } from '@hull/users/actor'

import {
  createHomePage,
  moveHomeTile,
  pinHomeTile,
  readHomeCanvas,
  removeHomePage,
  renameHomePage,
  unpinHomeTile,
} from './service'

// The web doors onto the home canvas. Every one runs under `withCurrentActor`,
// so the owner is resolved from the session and never taken from the caller —
// there is no `ownerId` parameter anywhere below, and the RLS policy
// (migration 0036) wouldn't accept one if there were.
//
// **The read is the access boundary.** `getHomeCanvas` resolves each pointer by
// asking the chat service on this same actor-scoped connection, so what comes
// back is decided by chat's own membership policies at read time. A tile pinned
// last week by somebody since removed from the chat resolves to nothing, without
// this file containing a single membership check.
//
// Notably absent: an answer door. Answering a widget from home posts an ordinary
// chat message through chat's OWN `answerChatWidget` — the same door the stack
// and the canvas use. A parallel path here would be a second place for the
// answer rules to drift.

/**
 * The whole home canvas in one read: your pages, your tiles with each pointer
 * resolved against your CURRENT chat membership, and the ship-log topics the
 * live half needs.
 */
export const getHomeCanvas = createServerFn({ method: 'GET' }).handler(() =>
  withCurrentActor((tx, me) => readHomeCanvas(tx, me.id)),
)

/** Add a page to your home — it lands at the end of the strip. */
export const createHomeCanvasPage = createServerFn({ method: 'POST' })
  .validator((input: { title: string }) => input)
  .handler(({ data }) =>
    withCurrentActor(async (tx, me) => {
      const row = await createHomePage(tx, {
        id: uuidv7(),
        ownerId: me.id,
        title: data.title,
      })
      return { id: row.id }
    }),
  )

export const renameHomeCanvasPage = createServerFn({ method: 'POST' })
  .validator((input: { pageId: string; title: string }) => input)
  .handler(({ data }) =>
    withCurrentActor(async (tx) => {
      await renameHomePage(tx, data)
      return { ok: true }
    }),
  )

/** Remove an EMPTY page. One still holding tiles is refused, never cascaded. */
export const removeHomeCanvasPage = createServerFn({ method: 'POST' })
  .validator((input: { pageId: string }) => input)
  .handler(({ data }) =>
    withCurrentActor(async (tx) => {
      await removeHomePage(tx, data)
      return { ok: true }
    }),
  )

/**
 * Pin a pointer: at a chat (live — whatever is on top of its stack) or at one
 * specific widget. Refused unless you can currently see the target. With no
 * `pageId` it lands on your first page, made for you if this is your first pin
 * — which is what lets a chat's canvas tile offer "pin to home" without knowing
 * anything about your home.
 */
export const pinHomeCanvasTile = createServerFn({ method: 'POST' })
  .validator(
    (input: { pageId?: string; chatId?: string; widgetId?: string }) => input,
  )
  .handler(({ data }) =>
    withCurrentActor(async (tx, me) => {
      const row = await pinHomeTile(tx, {
        id: uuidv7(),
        ownerId: me.id,
        ...data,
      })
      return { id: row.id }
    }),
  )

/** Move or resize a tile — the write behind a drag or an arrow-key nudge. */
export const moveHomeCanvasTile = createServerFn({ method: 'POST' })
  .validator(
    (input: {
      tileId: string
      pageId: string
      gridX?: number
      gridY?: number
      gridW?: number
      gridH?: number
    }) => input,
  )
  .handler(({ data }) =>
    withCurrentActor(async (tx) => {
      await moveHomeTile(tx, data)
      return { ok: true }
    }),
  )

/** Take a tile off your home. The widget it pointed at goes on living in its chat. */
export const unpinHomeCanvasTile = createServerFn({ method: 'POST' })
  .validator((input: { tileId: string }) => input)
  .handler(({ data }) =>
    withCurrentActor(async (tx) => {
      await unpinHomeTile(tx, data)
      return { ok: true }
    }),
  )
