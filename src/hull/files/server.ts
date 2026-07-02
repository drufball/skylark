import { createServerFn } from '@tanstack/react-start'

import { currentActor } from '@hull/users/actor'

import { liveFilesService } from './live'
import { validateFilePath } from './service'

// The web doors onto the files service. Reads and writes go through the live
// service, which routes them to the staging branch when one exists — so every
// crew member (and every editor tab) sees the same live state. Writes attribute
// to currentActor(): the staged commit's author is whoever saved.

/** Parse an untrusted request payload into a valid file path. */
function parsePath(input: unknown): string {
  if (typeof input !== 'string') throw new Error('path must be a string')
  return validateFilePath(input)
}

/** Parse an untrusted request payload into a valid save input. */
function parseSave(input: unknown): { path: string; content: string } {
  const record = input as { path?: unknown; content?: unknown }
  if (typeof record.content !== 'string')
    throw new Error('content must be a string')
  return { path: parsePath(record.path), content: record.content }
}

/** Every shared file's path, sorted. */
export const listFiles = createServerFn({ method: 'GET' }).handler(() =>
  liveFilesService().list(),
)

/** One file's content, or null when it doesn't exist. */
export const readFile = createServerFn({ method: 'GET' })
  .validator(parsePath)
  .handler(({ data: path }) => liveFilesService().read(path))

/** Create or update a file as the current actor. */
export const saveFile = createServerFn({ method: 'POST' })
  .validator(parseSave)
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
  .validator((input: unknown) => ({
    path: parsePath((input as { path?: unknown }).path),
  }))
  .handler(async ({ data }) => {
    const actor = await currentActor()
    await liveFilesService().remove({
      path: data.path,
      actor: { id: actor.id, handle: actor.handle },
    })
    return { ok: true }
  })
