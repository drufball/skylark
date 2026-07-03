import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * scripts/gate-workdir answers one question for the commit/landing gates:
 * given the hook payload's cwd, WHICH tree is being committed? A worktree
 * build must be gated on its own state — not the main checkout's — so the
 * script resolves the invoking cwd's git toplevel, and only falls back to
 * this project when the cwd is missing or outside any repository (#uvnm).
 */
const exec = promisify(execFile)
const script = resolve(__dirname, '../../../../../scripts/gate-workdir')
const projectDir = resolve(__dirname, '../../../../..')

async function gateWorkdir(cwdArg: string): Promise<string> {
  const { stdout } = await exec('bash', [script, cwdArg])
  return stdout.trim()
}

describe('gate-workdir', () => {
  let repo: string
  let plain: string

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'gate-repo-'))
    plain = await mkdtemp(join(tmpdir(), 'gate-plain-'))
    await exec('git', ['init', '--quiet', repo])
  })

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true })
    await rm(plain, { recursive: true, force: true })
  })

  it('resolves the toplevel of the git repo the hook ran in', async () => {
    const { stdout } = await exec('git', [
      '-C',
      repo,
      'rev-parse',
      '--show-toplevel',
    ])
    expect(await gateWorkdir(repo)).toBe(stdout.trim())
  })

  it('resolves the toplevel from a subdirectory of that repo', async () => {
    const sub = join(repo, 'deep', 'inside')
    await exec('mkdir', ['-p', sub])
    const { stdout } = await exec('git', [
      '-C',
      repo,
      'rev-parse',
      '--show-toplevel',
    ])
    expect(await gateWorkdir(sub)).toBe(stdout.trim())
  })

  it('falls back to the project dir when the cwd is empty', async () => {
    expect(await gateWorkdir('')).toBe(projectDir)
  })

  it('falls back to the project dir outside any git repository', async () => {
    expect(await gateWorkdir(plain)).toBe(projectDir)
  })

  it('falls back to the project dir when the cwd does not exist', async () => {
    expect(await gateWorkdir('/no/such/dir')).toBe(projectDir)
  })
})
