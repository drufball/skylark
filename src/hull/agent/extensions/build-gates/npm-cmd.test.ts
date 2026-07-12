import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

/**
 * scripts/npm-cmd answers one question: which npm invocation should
 * scripts/setup and scripts/commit-gate use to install dependencies? Plain
 * `npm` when the ambient npm already matches package.json's pinned
 * `packageManager` version (the common case — CI, and any machine whose npm
 * happens to line up: zero overhead, no network); otherwise `npx --yes
 * corepack npm`, which transparently runs the pinned version.
 *
 * Why this matters (#iv1t): CI's node (pinned by .nvmrc) bundles a specific
 * npm. A builder's local/sandbox npm can drift ahead of or behind that
 * (independently upgraded, a different node install, etc). `npm
 * install`/`npm ci` under a DIFFERENT npm than CI's can write
 * package-lock.json in a subtly different shape (optional/peer dep
 * resolution) that CI's `npm ci` then rejects with `EUSAGE ... Missing: X
 * from lock file` — even though the app code is fine. Always installing
 * through the pinned npm keeps every environment's lockfile shape identical
 * to CI's.
 *
 * Pinned/ambient versions are passed as args so the decision is testable
 * without touching this machine's real npm or package.json — see
 * scripts/npm-cmd's fallback to real `npm -v`/package.json when called with
 * no args (used in practice by setup/commit-gate).
 */
const exec = promisify(execFile)
const script = resolve(__dirname, '../../../../../scripts/npm-cmd')

async function npmCmd(pinned: string, ambient: string): Promise<string> {
  const { stdout } = await exec('bash', [script, pinned, ambient])
  return stdout.trim()
}

describe('npm-cmd', () => {
  it('prints bare npm when ambient matches the pin', async () => {
    expect(await npmCmd('10.9.8', '10.9.8')).toBe('npm')
  })

  it('routes through corepack when ambient is newer than the pin', async () => {
    expect(await npmCmd('10.9.8', '11.17.0')).toBe('npx --yes corepack npm')
  })

  it('routes through corepack when ambient is older than the pin', async () => {
    expect(await npmCmd('10.9.8', '9.8.1')).toBe('npx --yes corepack npm')
  })

  it('routes through corepack for any string mismatch, not just semver', async () => {
    expect(await npmCmd('10.9.8', 'not-a-version')).toBe(
      'npx --yes corepack npm',
    )
  })
})
