import type { Database } from '@hull/db/client'
import { emitEvent } from '@hull/events/bus'
import { PUBLIC_AUDIENCE } from '@hull/events/service'

import type { FilesRepo } from './git'

export type { FilesRepo }
import { fileTopic } from './topic'

/**
 * Shared files with git underneath, branch management abstracted away. The crew
 * (humans and agents) reads and writes documents; the service stages every
 * change on one staging branch (`files/staging`) so nothing commits straight to
 * main, and everyone reading through the service sees the same live staged
 * state. After a quiet period the sweep merges staging back into main — a real
 * merge on a clean, main-checked-out repo — and the docs become plain files on
 * disk, the interop surface for every other tool.
 *
 * No tables: git is the store. The database is here only to announce changes on
 * the ship's log (`file.changed` on `file:<path>`), which is what makes the
 * explorer and editors live.
 */

/** Event types this service emits (one name, used by emitters and subscribers). */
export const FILE_CHANGED = 'file.changed'
export const FILES_MERGED = 'files.staging_merged'

/** The topic the merge announcement rides (system event, not one file's). */
export const FILES_MERGE_TOPIC = 'files:staging'

/** How long the staging branch must sit quiet before the sweep merges it. */
export const FILES_IDLE_MS = 2 * 60_000

/**
 * Validate and normalize a file path: relative, no traversal, no empty
 * segments, no `:` (it would break the `file:<path>` topic grammar), no
 * control characters. Returns the path unchanged when valid — the service
 * stores exactly what the crew named.
 */
export function validateFilePath(path: string): string {
  if (path === '' || path.startsWith('/') || path.endsWith('/')) {
    throw new Error(`Invalid file path: "${path}"`)
  }
  // eslint-disable-next-line no-control-regex
  if (/[:\u0000-\u001f]/.test(path)) {
    throw new Error(`Invalid file path: "${path}"`)
  }
  const segments = path.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`Invalid file path: "${path}"`)
  }
  return path
}

/**
 * Should the sweep merge staging now? Quiet for the idle window since the
 * staging tip was committed. The clock is git's committer time, so it holds
 * across restarts and across processes (a CLI write elsewhere resets it too).
 */
export function shouldMergeStaging(input: {
  stagedAt: number
  now: number
}): boolean {
  return input.now - input.stagedAt >= FILES_IDLE_MS
}

/** What one sweep did — 'postponed' retries next tick, 'conflict' needs a human. */
export type SweepOutcome =
  | 'no-staging'
  | 'waiting'
  | 'postponed'
  | 'merged'
  | 'conflict'

export interface FilesServiceDeps {
  db: Database
  repo: FilesRepo
}

export interface FilesService {
  /** Every file path, from the staged view when one exists, else from disk. */
  list(): Promise<string[]>
  /** One file's content, from the staged view when one exists, else from disk. */
  read(path: string): Promise<string | null>
  write(input: {
    path: string
    content: string
    actor: { id: string; handle: string }
  }): Promise<void>
  remove(input: {
    path: string
    actor: { id: string; handle: string }
  }): Promise<void>
  /** Merge staging into main if it's been idle — called by the sweeper. */
  sweep(now: number): Promise<SweepOutcome>
}

export function createFilesService({
  db,
  repo,
}: FilesServiceDeps): FilesService {
  // All git mutations run one at a time: a promise-chain mutex, so two
  // concurrent saves can't race the staging ref's compare-and-swap.
  let chain: Promise<unknown> = Promise.resolve()
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  async function change(
    path: string,
    content: string | null,
    actor: { id: string; handle: string },
    action: 'write' | 'delete',
  ): Promise<void> {
    validateFilePath(path)
    await locked(() =>
      repo.commitToStaging(
        [{ path, content }],
        { name: actor.handle, email: `${actor.handle}@crew.skylark.local` },
        `${action} ${path}`,
      ),
    )
    await emitEvent(db, {
      type: FILE_CHANGED,
      source: 'files',
      topic: fileTopic(path),
      audience: PUBLIC_AUDIENCE,
      actorId: actor.id,
      payload: { path, action },
    })
  }

  return {
    async list() {
      if (await repo.stagingExists()) return repo.listStaged()
      return repo.listDisk()
    },

    async read(path) {
      validateFilePath(path)
      if (await repo.stagingExists()) return repo.readStaged(path)
      return repo.readDisk(path)
    },

    write({ path, content, actor }) {
      return change(path, content, actor, 'write')
    },

    remove({ path, actor }) {
      return change(path, null, actor, 'delete')
    },

    sweep(now) {
      return locked(async (): Promise<SweepOutcome> => {
        if (!(await repo.stagingExists())) return 'no-staging'
        const stagedAt = await repo.stagedAt()
        if (!shouldMergeStaging({ stagedAt, now })) return 'waiting'
        if ((await repo.mergeReadiness()) !== 'ready') return 'postponed'
        const outcome = await repo.mergeStaging()
        if (outcome === 'merged') {
          await emitEvent(db, {
            type: FILES_MERGED,
            source: 'files',
            topic: FILES_MERGE_TOPIC,
            audience: PUBLIC_AUDIENCE,
            payload: {},
          })
        }
        return outcome
      })
    },
  }
}
