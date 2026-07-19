import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'

import { behindOrigin } from './behind-origin'
import { shipHealth } from './service'

/**
 * The server door onto shipHealth. Always runs on the server; called from
 * routes like a local function, with the result fully typed across the wire.
 */
export const getShipHealth = createServerFn({ method: 'GET' }).handler(() =>
  shipHealth(db),
)

const execFileAsync = promisify(execFile)

/* v8 ignore start -- real git/network exec against the live repo, not exercised in tests */
/** The exec edge for `behindOrigin`: the actual `git fetch` + `rev-list`. */
async function fetchBehindCount(): Promise<number> {
  await execFileAsync('git', ['fetch', 'origin', 'main'])
  const { stdout } = await execFileAsync('git', [
    'rev-list',
    '--count',
    'HEAD..origin/main',
  ])
  const count = Number.parseInt(stdout.trim(), 10)
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`unexpected git rev-list output: ${stdout.trim()}`)
  }
  return count
}
/* v8 ignore stop */

/**
 * The server door onto behindOrigin — issue #f70a's "ship is N commits behind
 * origin" signal. Rate-limited and failure-tolerant inside behindOrigin.ts;
 * this door just wires the real clock and the real git exec to it.
 */
export const getBehindOrigin = createServerFn({ method: 'GET' }).handler(() =>
  behindOrigin({ now: () => Date.now(), fetchBehindCount }),
)
