import { db } from '@hull/db/client'
import { errorMessage } from '@hull/lib/errors'
import { startIntervalSweep } from '@hull/lib/interval-sweep'

import { createFilesRepo } from './git'
import {
  createFilesService,
  createSweepReporter,
  type FilesService,
} from './service'

/* v8 ignore start -- live wiring: the real repo config, the process singleton,
   and the sweep timer. The service's decisions and git behaviour are tested in
   service.test.ts against a throwaway repo; this file only connects them to the
   running ship. */

/** Where the crew's shared files live: the home deck's files folder. */
export const FILES_DIR = 'src/home/files'

/** The staging branch every service edit accumulates on until the sweep. */
export const FILES_STAGING_BRANCH = 'files/staging'

/** How often the sweeper checks whether staging has gone idle. */
const SWEEP_INTERVAL_MS = 30_000

let singleton: FilesService | undefined

/**
 * The one files service for this process, over the repo the server runs in.
 * First call ensures the files dir exists and starts the sweep timer (unref'd,
 * so a CLI invocation still exits; a CLI write is merged by the server's
 * sweeper, whose idle clock reads the staging tip's commit time).
 */
export function liveFilesService(): FilesService {
  if (!singleton) {
    const repo = createFilesRepo({
      repoRoot: process.cwd(),
      filesDir: FILES_DIR,
      mainBranch: 'main',
      stagingBranch: FILES_STAGING_BRANCH,
    })
    void repo.ensureFilesDir().catch((err: unknown) => {
      console.error(`files: ensure dir failed: ${errorMessage(err)}`)
    })
    const service = createFilesService({ db, repo })
    // The shared recurring-sweep helper (unref'd interval, injected clock,
    // errors swallowed + logged) — the same one chat's schedule sweep rides.
    // The helper only sees THROWN errors, so the tick reports the OUTCOME too:
    // a sweep that keeps failing to reach origin must not look like an idle one
    // (#p5as was invisible for 25 minutes because this value was discarded).
    const report = createSweepReporter()
    startIntervalSweep({
      intervalMs: SWEEP_INTERVAL_MS,
      label: 'files',
      tick: async (now) => {
        const line = report(await service.sweep(now))
        if (line !== null) console.warn(`files: ${line}`)
      },
    })
    singleton = service
  }
  return singleton
}
/* v8 ignore stop */
