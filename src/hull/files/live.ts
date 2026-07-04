import { db } from '@hull/db/client'
import { errorMessage } from '@hull/lib/errors'

import { createFilesService, type FilesService } from './service'

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
    throw new Error(
      'liveFilesService: not initialized. Call ensureLiveFilesService() first (boot.ts does this).',
    )
  }
  return singleton
}

/**
 * Initialize the live files service asynchronously. Called by boot.ts.
 * Subsequent sync calls to liveFilesService() will return the initialized instance.
 */
export async function ensureLiveFilesService(): Promise<FilesService> {
  if (!singleton) {
    // Lazy import git module to keep node builtins out of client bundle
    const { createFilesRepo } = await import('./git')
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
    setInterval(() => {
      void service.sweep(Date.now()).catch((err: unknown) => {
        console.error(`files: sweep failed: ${errorMessage(err)}`)
      })
    }, SWEEP_INTERVAL_MS).unref()
    singleton = service
  }
  return singleton
}
/* v8 ignore stop */
