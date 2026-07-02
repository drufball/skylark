import { createServerFn } from '@tanstack/react-start'

import { currentActor } from '@hull/users/actor'

import { liveFilesService } from './live'

// The web doors onto the files service. Reads and writes go through the live
// service, which routes them to the staging branch when one exists — so every
// crew member (and every editor tab) sees the same live state. Writes attribute
// to currentActor(): the staged commit's author is whoever saved.

/** Every shared file's path, sorted. */
export const listFiles = createServerFn({ method: 'GET' }).handler(() =>
  liveFilesService().list(),
)

/** One file's content, or null when it doesn't exist. */
export const readFile = createServerFn({ method: 'GET' })
  .validator((path: string) => path)
  .handler(({ data: path }) => liveFilesService().read(path))

/** Create or update a file as the current actor. */
export const saveFile = createServerFn({ method: 'POST' })
  .validator((input: { path: string; content: string }) => input)
  .handler(async ({ data }) => {
    const actor = await currentActor()
    await liveFilesService().write({
      path: data.path,
      content: data.content,
      actor: { id: actor.id, handle: actor.handle },
    })
    return { ok: true }
  })

/** Delete a file as the current actor. */
export const deleteFile = createServerFn({ method: 'POST' })
  .validator((input: { path: string }) => input)
  .handler(async ({ data }) => {
    const actor = await currentActor()
    await liveFilesService().remove({
      path: data.path,
      actor: { id: actor.id, handle: actor.handle },
    })
    return { ok: true }
  })
