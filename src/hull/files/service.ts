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
export const FILES_SWEEP_WEDGED = 'files.sweep_wedged'

/** The topic the merge announcement rides (system event, not one file's). */
export const FILES_MERGE_TOPIC = 'files:staging'

/** The topic the sweep's own health rides — not any one file's business. */
export const FILES_SWEEP_TOPIC = 'files:sweep'

/** How long the staging branch must sit quiet before the sweep merges it. */
export const FILES_IDLE_MS = 2 * 60_000

/**
 * How many consecutive failed sweeps before the sweep stops trying every tick.
 * A wedged sweep that keeps re-running the same doomed git command every 30s
 * (#p5as ran one for 25 minutes) helps nobody: past this many, it latches.
 */
export const SWEEP_FAILURE_LIMIT = 5

/**
 * Once latched, how many ticks to skip before probing again — a cause that
 * clears itself (origin moved on, a human resolved it) still recovers without
 * a restart, at ~10 minutes instead of 30 seconds.
 */
export const SWEEP_WEDGED_PROBE_EVERY = 20

/** How many identical noisy outcomes in a row before the log repeats itself. */
export const SWEEP_LOG_REPEAT_EVERY = 10

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
 * npm's two-line script banner, as `npm run files -- read x` prints it:
 *
 *     > files
 *     > node --env-file-if-exists=.env --import tsx src/hull/files/cli.ts read x
 *
 * An agent that round-trips that output back into a write buries the banner in
 * the document (#q2zi repaired exactly that damage in the crew's memory files,
 * and it recurred — #p5as). The PAIR is the signature and the reason this can
 * stay narrow: a lone `> word` is an ordinary blockquote, and a sentence in a
 * blockquote is prose, but a one-token line followed by a line whose second
 * token is a flag or a script file is npm talking, not a person writing.
 */
const BANNER_SCRIPT_LINE = /^>[ \t]+(?:\S+@\S+[ \t]+)?[\w:@./-]+[ \t]*$/
const BANNER_COMMAND_LINE =
  /^>[ \t]+\S+[ \t]+(?:--?[\w-]+|[\w./-]+\.[cm]?[jt]sx?\b)/

/**
 * The captured-banner block in this content, or null if there is none. Returns
 * the offending lines so the error can show the caller exactly what it saw.
 */
export function findCapturedCommandBanner(content: string): string | null {
  const lines = content.split('\n')
  for (let i = 0; i + 1 < lines.length; i++) {
    if (
      BANNER_SCRIPT_LINE.test(lines[i]) &&
      BANNER_COMMAND_LINE.test(lines[i + 1])
    ) {
      return `${lines[i]}\n${lines[i + 1]}`
    }
  }
  return null
}

/** Refuse a write whose content is really captured command output. */
function assertNoCapturedCommandBanner(path: string, content: string): void {
  const banner = findCapturedCommandBanner(content)
  if (banner === null) return
  throw new Error(
    `Refusing to write "${path}": the content looks like captured command output, not document text — it carries npm's script banner:\n${banner}\n` +
      `Write the document's own content. To quote a command on purpose, put it in a fenced code block instead of a blockquote.`,
  )
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

/**
 * What one sweep did — 'postponed' and 'push-rejected' retry next tick,
 * 'conflict' needs a human. 'pushed' is a sweep that had no staging to merge
 * but landed a push a previous sweep couldn't. 'wedged' is a tick that didn't
 * even try: the same failure has repeated past SWEEP_FAILURE_LIMIT, so the
 * sweep has stopped hammering git and is only probing occasionally.
 */
export type SweepOutcome =
  | 'no-staging'
  | 'waiting'
  | 'postponed'
  | 'merged'
  | 'pushed'
  | 'conflict'
  | 'push-rejected'
  | 'wedged'

/** Outcomes where git ran and did not get the work done. */
function isSweepFailure(outcome: SweepOutcome): boolean {
  return outcome === 'conflict' || outcome === 'push-rejected'
}

/**
 * Should this tick actually run the sweep, or skip it? Under the failure limit,
 * always probe. At or past it the sweep is wedged: skip until
 * SWEEP_WEDGED_PROBE_EVERY ticks have gone by, then probe once.
 */
export function sweepGate(input: {
  failures: number
  skipped: number
}): 'probe' | 'skip' {
  if (input.failures < SWEEP_FAILURE_LIMIT) return 'probe'
  return input.skipped >= SWEEP_WEDGED_PROBE_EVERY ? 'probe' : 'skip'
}

/** What a not-done outcome should say out loud, in the crew's own words. */
const SWEEP_COMPLAINTS: Partial<Record<SweepOutcome, string>> = {
  postponed:
    'postponed — the repo is not on a clean main (another branch checked out, or the files dir has uncommitted edits)',
  conflict:
    'conflict — a document merge could not be settled automatically; the docs are safe but main is not moving until a human looks',
  'push-rejected':
    'push-rejected — origin moved between the fetch and the push; retrying on the next sweep',
  wedged:
    'wedged — the same failure keeps repeating, so the sweep has stopped retrying every tick and is only probing occasionally; docs are staged but not reaching origin',
}

/**
 * A console reporter for sweep outcomes, with just enough memory not to flood
 * the log. An idle or successful sweep says nothing — so a quiet log really does
 * mean a healthy sweep, which is exactly what #p5as could not tell. A sweep that
 * didn't get its work done speaks the first time and then once every
 * SWEEP_LOG_REPEAT_EVERY repeats, so it never goes quiet enough to look fine.
 *
 * Returns the line to log, or null for silence; `live.ts` owns the console.
 */
export function createSweepReporter(): (
  outcome: SweepOutcome,
) => string | null {
  let last: SweepOutcome | undefined
  let streak = 0
  return (outcome) => {
    streak = outcome === last ? streak + 1 : 1
    last = outcome
    const complaint = SWEEP_COMPLAINTS[outcome]
    if (complaint === undefined) return null
    if (streak !== 1 && streak % SWEEP_LOG_REPEAT_EVERY !== 0) return null
    return `sweep ${complaint}`
  }
}

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

  // The wedge guard: consecutive failed sweeps, and how many ticks have been
  // skipped since the last probe. Per service instance — a restart starts fresh,
  // which is the right call: a restart is a human doing something.
  let failures = 0
  let skipped = 0
  let announcedWedge = false

  /**
   * Make local main pushable: fetch, then converge ONLY if origin genuinely
   * advanced past us. When origin/main is already an ancestor of local main —
   * the overwhelmingly common case, including a fat backlog of unpushed doc
   * commits — a plain push fast-forwards and there is nothing to converge.
   * Syncing unconditionally is what wedged the sweep in #p5as: it replayed 56
   * historical doc commits onto a moved origin and conflicted on the first.
   */
  async function readyToPush(): Promise<'ready' | 'conflict'> {
    await repo.fetchOrigin()
    if ((await repo.behindOrigin()) === 0) return 'ready'
    return (await repo.convergeWithOrigin()) === 'conflict'
      ? 'conflict'
      : 'ready'
  }

  /**
   * Nothing staged, so the only work a sweep could owe is a push a previous
   * sweep couldn't land (origin moved between its fetch and its push, or the
   * ship has been offline): local main still carries commits origin lacks. Push
   * it, under the same clean-main guard as a merge. When nothing is ahead — the
   * steady state — this touches no git at all.
   */
  async function retryPendingPush(): Promise<SweepOutcome> {
    if (!(await repo.hasOrigin())) return 'no-staging'
    if ((await repo.aheadOfOrigin()) === 0) return 'no-staging'
    if ((await repo.mergeReadiness()) !== 'ready') return 'postponed'
    if ((await readyToPush()) === 'conflict') return 'conflict'
    if ((await repo.pushMain()) === 'rejected') return 'push-rejected'
    return 'pushed'
  }

  /** One sweep's actual work, before the wedge guard's bookkeeping. */
  async function runSweep(now: number): Promise<SweepOutcome> {
    if (!(await repo.stagingExists())) return retryPendingPush()
    const stagedAt = await repo.stagedAt()
    if (!shouldMergeStaging({ stagedAt, now })) return 'waiting'
    if ((await repo.mergeReadiness()) !== 'ready') return 'postponed'
    // Converge BEFORE merging, so the docs land on a main that already carries
    // origin's latest — and the push afterwards fast-forwards.
    const origin = await repo.hasOrigin()
    if (origin && (await readyToPush()) === 'conflict') return 'conflict'
    const outcome = await repo.mergeStaging()
    if (outcome === 'conflict') return 'conflict'
    await emitEvent(db, {
      type: FILES_MERGED,
      source: 'files',
      topic: FILES_MERGE_TOPIC,
      audience: PUBLIC_AUDIENCE,
      payload: {},
    })
    if (origin && (await repo.pushMain()) === 'rejected') return 'push-rejected'
    return 'merged'
  }

  async function change(
    path: string,
    content: string | null,
    actor: { id: string; handle: string },
    action: 'write' | 'delete',
  ): Promise<void> {
    validateFilePath(path)
    if (content !== null) assertNoCapturedCommandBanner(path, content)
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
        if (sweepGate({ failures, skipped }) === 'skip') {
          skipped++
          return 'wedged'
        }
        skipped = 0
        const outcome = await runSweep(now)
        if (!isSweepFailure(outcome)) {
          failures = 0
          announcedWedge = false
          return outcome
        }
        failures++
        if (failures >= SWEEP_FAILURE_LIMIT && !announcedWedge) {
          announcedWedge = true
          // Say it on the ship's log too, once per wedge: the console scrolls
          // away, and a sweep that cannot reach origin is crew news.
          await emitEvent(db, {
            type: FILES_SWEEP_WEDGED,
            source: 'files',
            topic: FILES_SWEEP_TOPIC,
            audience: PUBLIC_AUDIENCE,
            payload: { outcome, consecutiveFailures: failures },
          })
        }
        return outcome
      })
    },
  }
}
