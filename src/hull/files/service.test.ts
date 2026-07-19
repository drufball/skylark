import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { uuidv7 } from '@earendil-works/pi-agent-core'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { listEventsSince } from '@hull/events/service'
import { createUser } from '@hull/users/service'

import { createFilesRepo, type FilesRepo } from './git'
import {
  createFilesService,
  FILE_CHANGED,
  FILES_IDLE_MS,
  FILES_MERGED,
  shouldMergeStaging,
  validateFilePath,
  type FilesService,
} from './service'
import { fileTopic } from './topic'

const run = promisify(execFile)

/**
 * A real throwaway git repo, `main` checked out, with the files dir committed —
 * the service's git behaviour is the logic here, so it's tested against actual
 * git, not a fake. Each test gets a fresh repo; PGlite carries the events.
 */
async function tempRepo(): Promise<{ repoRoot: string; git: GitRunner }> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'skylark-files-'))
  const git = (...args: string[]) => run('git', args, { cwd: repoRoot })
  await git('init', '-b', 'main')
  await git('config', 'user.name', 'fixture')
  await git('config', 'user.email', 'fixture@test')
  await mkdir(join(repoRoot, 'files'), { recursive: true })
  await writeFile(join(repoRoot, 'files', 'seed.md'), '# seed\n')
  await git('add', '.')
  await git('commit', '-m', 'seed')
  return { repoRoot, git }
}
type GitRunner = (...args: string[]) => Promise<{ stdout: string }>

/**
 * Give a temp repo a bare `origin` remote holding the same main — the shape of
 * the serving checkout. Fetched once so refs/remotes/origin/main exists.
 */
async function addOrigin(git: GitRunner): Promise<string> {
  const originDir = await mkdtemp(join(tmpdir(), 'skylark-origin-'))
  await run('git', ['init', '--bare', '-b', 'main'], { cwd: originDir })
  await git('remote', 'add', 'origin', originDir)
  await git('push', 'origin', 'main')
  await git('fetch', 'origin')
  return originDir
}

/** Move origin's main from elsewhere — a PR merged on GitHub, in miniature. */
async function commitToOrigin(
  originDir: string,
  path: string,
  content: string,
): Promise<void> {
  const cloneDir = await mkdtemp(join(tmpdir(), 'skylark-clone-'))
  try {
    await run('git', ['clone', originDir, cloneDir])
    const git = (...args: string[]) => run('git', args, { cwd: cloneDir })
    await git('config', 'user.name', 'elsewhere')
    await git('config', 'user.email', 'elsewhere@test')
    await mkdir(join(cloneDir, 'files'), { recursive: true })
    await writeFile(join(cloneDir, path), content)
    await git('add', '.')
    await git('commit', '-m', `origin-side ${path}`)
    await git('push', 'origin', 'main')
  } finally {
    await rm(cloneDir, { recursive: true, force: true })
  }
}

let AUTHOR: { id: string; handle: string }

describe('validateFilePath', () => {
  it('accepts plain and nested relative paths, returning them normalized', () => {
    expect(validateFilePath('notes.md')).toBe('notes.md')
    expect(validateFilePath('agents/tilde/index.md')).toBe(
      'agents/tilde/index.md',
    )
  })

  it('rejects traversal, absolute paths, and empty segments', () => {
    expect(() => validateFilePath('../escape.md')).toThrow(/path/i)
    expect(() => validateFilePath('a/../../b.md')).toThrow(/path/i)
    expect(() => validateFilePath('/etc/passwd')).toThrow(/path/i)
    expect(() => validateFilePath('')).toThrow(/path/i)
    expect(() => validateFilePath('a//b.md')).toThrow(/path/i)
    expect(() => validateFilePath('a/')).toThrow(/path/i)
  })

  it('rejects a colon (it would break the file topic) and control chars', () => {
    expect(() => validateFilePath('a:b.md')).toThrow(/path/i)
    expect(() => validateFilePath('a\0b')).toThrow(/path/i)
  })
})

describe('shouldMergeStaging', () => {
  it('merges once the idle window has passed since the staging tip was committed', () => {
    expect(
      shouldMergeStaging({ stagedAt: 1_000, now: 1_000 + FILES_IDLE_MS }),
    ).toBe(true)
    expect(
      shouldMergeStaging({ stagedAt: 1_000, now: 1_000 + FILES_IDLE_MS - 1 }),
    ).toBe(false)
  })
})

describe('createFilesRepo refuses a repoRoot git does not own', () => {
  const layout = {
    filesDir: 'files',
    mainBranch: 'main',
    stagingBranch: 'files/staging',
  }
  const change = [{ path: 'a.md', content: 'x' }]
  const author = { name: 'fixture', email: 'fixture@test' }

  it('refuses to commit when repoRoot is not a git repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'skylark-notrepo-'))
    try {
      const repo = createFilesRepo({ repoRoot: dir, ...layout })
      await expect(repo.commitToStaging(change, author, 'm')).rejects.toThrow(
        /repository/i,
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses to commit when repoRoot is a subdirectory of a repo — git would act on the enclosing one', async () => {
    const { repoRoot } = await tempRepo()
    try {
      const repo = createFilesRepo({
        repoRoot: join(repoRoot, 'files'),
        ...layout,
      })
      await expect(repo.commitToStaging(change, author, 'm')).rejects.toThrow(
        /repository root/i,
      )
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })

  it('refuses to merge from a subdirectory of a repo', async () => {
    const { repoRoot } = await tempRepo()
    try {
      const repo = createFilesRepo({
        repoRoot: join(repoRoot, 'files'),
        ...layout,
      })
      await expect(repo.mergeStaging()).rejects.toThrow(/repository root/i)
    } finally {
      await rm(repoRoot, { recursive: true, force: true })
    }
  })
})

describe('files service over a real git repo', () => {
  let repoRoot: string
  let git: GitRunner
  let repo: FilesRepo
  let db: Database
  let close: () => Promise<void>
  let service: FilesService

  beforeEach(async () => {
    ;({ repoRoot, git } = await tempRepo())
    ;({ db, close } = await freshDb())
    // The events table's actor FK points at users — the author must exist.
    AUTHOR = { id: uuidv7(), handle: 'dru' }
    await createUser(db, {
      id: AUTHOR.id,
      handle: AUTHOR.handle,
      displayName: 'Dru',
      type: 'human',
    })
    repo = createFilesRepo({
      repoRoot,
      filesDir: 'files',
      mainBranch: 'main',
      stagingBranch: 'files/staging',
    })
    service = createFilesService({ db, repo })
  })

  afterEach(async () => {
    await close()
    await rm(repoRoot, { recursive: true, force: true })
  })

  it('reads and lists from disk while no staging branch exists (external edits visible)', async () => {
    await writeFile(join(repoRoot, 'files', 'tool-edit.md'), 'from a tool\n')
    expect(await service.read('tool-edit.md')).toBe('from a tool\n')
    expect((await service.list()).sort()).toEqual(['seed.md', 'tool-edit.md'])
    expect(await service.read('missing.md')).toBeNull()
  })

  it('stages a write on the staging branch without touching disk, main, or the index', async () => {
    await service.write({ path: 'plan.md', content: '# plan\n', actor: AUTHOR })

    // The service sees the write (routed to staging)…
    expect(await service.read('plan.md')).toBe('# plan\n')
    expect((await service.list()).sort()).toEqual(['plan.md', 'seed.md'])

    // …but nothing else moved: disk untouched, main untouched, status clean.
    await expect(readFile(join(repoRoot, 'files', 'plan.md'))).rejects.toThrow()
    const { stdout: onMain } = await git('ls-tree', '-r', '--name-only', 'main')
    expect(onMain).not.toContain('plan.md')
    const { stdout: status } = await git('status', '--porcelain')
    expect(status.trim()).toBe('')

    // The commit is attributed to the acting user.
    const { stdout: author } = await git(
      'log',
      '-1',
      '--format=%an',
      'files/staging',
    )
    expect(author.trim()).toBe('dru')
  })

  it('layers successive writes and edits onto the same staging branch', async () => {
    await service.write({ path: 'a.md', content: 'one\n', actor: AUTHOR })
    await service.write({ path: 'b.md', content: 'two\n', actor: AUTHOR })
    await service.write({
      path: 'a.md',
      content: 'one-edited\n',
      actor: AUTHOR,
    })

    expect(await service.read('a.md')).toBe('one-edited\n')
    expect(await service.read('b.md')).toBe('two\n')
    // seed.md rode along from main into the staged view.
    expect(await service.read('seed.md')).toBe('# seed\n')
  })

  it('stages a delete: gone from the service view, still on disk until merge', async () => {
    await service.remove({ path: 'seed.md', actor: AUTHOR })
    expect(await service.read('seed.md')).toBeNull()
    expect(await service.list()).toEqual([])
    expect(
      (await readFile(join(repoRoot, 'files', 'seed.md'), 'utf8')).length,
    ).toBeGreaterThan(0)
  })

  it('announces every change on the ship log with the file topic', async () => {
    await service.write({ path: 'plan.md', content: 'x', actor: AUTHOR })
    await service.remove({ path: 'plan.md', actor: AUTHOR })

    const events = await listEventsSince(db, {
      topicPatterns: ['file:*'],
      audience: 'public',
    })
    const changed = events.filter((e) => e.type === FILE_CHANGED)
    expect(changed).toHaveLength(2)
    expect(changed[0].topic).toBe(fileTopic('plan.md'))
    expect(changed[0].actorId).toBe(AUTHOR.id)
    expect(
      changed.map((e) => (e.payload as { action: string }).action),
    ).toEqual(['write', 'delete'])
  })

  it('sweep merges an idle staging branch into main, landing the files on disk', async () => {
    await service.write({ path: 'plan.md', content: '# plan\n', actor: AUTHOR })
    await service.remove({ path: 'seed.md', actor: AUTHOR })

    const outcome = await service.sweep(Date.now() + FILES_IDLE_MS)
    expect(outcome).toBe('merged')

    // Real files on disk now — the interop surface.
    expect(await readFile(join(repoRoot, 'files', 'plan.md'), 'utf8')).toBe(
      '# plan\n',
    )
    await expect(readFile(join(repoRoot, 'files', 'seed.md'))).rejects.toThrow()
    // Staging is gone; the service reads from disk again.
    expect(await service.read('plan.md')).toBe('# plan\n')
    const { stdout } = await git('branch', '--list', 'files/staging')
    expect(stdout.trim()).toBe('')

    const events = await listEventsSince(db, {
      topicPatterns: ['files:*'],
      audience: 'public',
    })
    expect(events.some((e) => e.type === FILES_MERGED)).toBe(true)
  })

  it('sweep does nothing while writes are fresh, or when no staging exists', async () => {
    expect(await service.sweep(Date.now())).toBe('no-staging')
    await service.write({ path: 'p.md', content: 'x', actor: AUTHOR })
    expect(await service.sweep(Date.now())).toBe('waiting')
    const { stdout } = await git('branch', '--list', 'files/staging')
    expect(stdout.trim()).not.toBe('')
  })

  it('sweep postpones when the repo is checked out on another branch', async () => {
    await service.write({ path: 'p.md', content: 'x', actor: AUTHOR })
    await git('checkout', '-b', 'feature')
    expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('postponed')
    await git('checkout', 'main')
    expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('merged')
  })

  it('sweep postpones when the files dir has uncommitted disk edits', async () => {
    await service.write({ path: 'p.md', content: 'x', actor: AUTHOR })
    await writeFile(join(repoRoot, 'files', 'seed.md'), 'dirty\n')
    expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('postponed')
  })

  it('sweep aborts cleanly on a conflicting merge, leaving main and staging intact', async () => {
    await service.write({ path: 'seed.md', content: 'staged\n', actor: AUTHOR })
    // main moves the same file after staging diverged → a real conflict.
    await writeFile(join(repoRoot, 'files', 'seed.md'), 'main-side\n')
    await git('add', '.')
    await git('commit', '-m', 'main-side edit')

    expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('conflict')
    // The working tree is not left mid-merge, and both sides survive.
    const { stdout: status } = await git('status', '--porcelain')
    expect(status.trim()).toBe('')
    expect(await readFile(join(repoRoot, 'files', 'seed.md'), 'utf8')).toBe(
      'main-side\n',
    )
    expect(await service.read('seed.md')).toBe('staged\n')

    // A conflicted sweep merged nothing, so it must not announce a merge.
    const events = await listEventsSince(db, {
      topicPatterns: ['files:*'],
      audience: 'public',
    })
    expect(events.filter((e) => e.type === FILES_MERGED)).toHaveLength(0)
  })

  it('the idle clock is git-derived: it survives a restart and honors fresh writes', async () => {
    await service.write({ path: 'p.md', content: 'x', actor: AUTHOR })
    // A new service instance simulates a process restart. The clock lives in
    // the staging tip's committer time, so a fresh write still waits out the
    // idle window — and merges once it has passed.
    const rebooted = createFilesService({ db, repo })
    expect(await rebooted.sweep(Date.now())).toBe('waiting')
    expect(await rebooted.sweep(Date.now() + FILES_IDLE_MS)).toBe('merged')
  })

  describe('with an origin remote', () => {
    let originDir: string
    const originGit = (...args: string[]) =>
      run('git', args, { cwd: originDir })

    beforeEach(async () => {
      originDir = await addOrigin(git)
    })

    afterEach(async () => {
      await rm(originDir, { recursive: true, force: true })
    })

    it('sweep pushes the merged docs to origin main — local main stops diverging', async () => {
      await service.write({
        path: 'plan.md',
        content: '# plan\n',
        actor: AUTHOR,
      })
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('merged')

      const { stdout: localTip } = await git('rev-parse', 'main')
      const { stdout: originTip } = await originGit('rev-parse', 'main')
      expect(originTip.trim()).toBe(localTip.trim())
      const { stdout: originTree } = await originGit(
        'ls-tree',
        '-r',
        '--name-only',
        'main',
      )
      expect(originTree).toContain('files/plan.md')
    })

    it('sweep fast-forwards a behind local main to origin before merging', async () => {
      await commitToOrigin(originDir, 'files/upstream.md', 'from a PR\n')
      await service.write({
        path: 'plan.md',
        content: '# plan\n',
        actor: AUTHOR,
      })

      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('merged')

      // Both sides landed on disk, and origin has the whole result.
      expect(
        await readFile(join(repoRoot, 'files', 'upstream.md'), 'utf8'),
      ).toBe('from a PR\n')
      expect(await readFile(join(repoRoot, 'files', 'plan.md'), 'utf8')).toBe(
        '# plan\n',
      )
      const { stdout: localTip } = await git('rev-parse', 'main')
      const { stdout: originTip } = await originGit('rev-parse', 'main')
      expect(originTip.trim()).toBe(localTip.trim())
    })

    it('sweep rebases local-only main commits onto a moved origin, then pushes everything', async () => {
      // Local main has its own commit (yesterday's unpushed sweep, say)…
      await writeFile(join(repoRoot, 'files', 'local.md'), 'local\n')
      await git('add', '.')
      await git('commit', '-m', 'local-only')
      // …and origin moved independently.
      await commitToOrigin(originDir, 'files/upstream.md', 'from a PR\n')

      await service.write({
        path: 'plan.md',
        content: '# plan\n',
        actor: AUTHOR,
      })
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('merged')

      const { stdout: localTip } = await git('rev-parse', 'main')
      const { stdout: originTip } = await originGit('rev-parse', 'main')
      expect(originTip.trim()).toBe(localTip.trim())
      const { stdout: originTree } = await originGit(
        'ls-tree',
        '-r',
        '--name-only',
        'main',
      )
      for (const path of ['local.md', 'upstream.md', 'plan.md']) {
        expect(originTree).toContain(`files/${path}`)
      }
    })

    it('a conflicting sync aborts cleanly and postpones: no half-done rebase, staging intact', async () => {
      // Local main and origin edit the same file, apart → the rebase conflicts.
      await writeFile(join(repoRoot, 'files', 'seed.md'), 'local-side\n')
      await git('add', '.')
      await git('commit', '-m', 'local-side edit')
      await commitToOrigin(originDir, 'files/seed.md', 'origin-side\n')

      await service.write({
        path: 'plan.md',
        content: '# plan\n',
        actor: AUTHOR,
      })
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('conflict')

      // Nothing is left mid-rebase; every side survives for the next attempt.
      const { stdout: status } = await git('status', '--porcelain')
      expect(status.trim()).toBe('')
      await expect(
        git('rev-parse', '--verify', 'REBASE_HEAD'),
      ).rejects.toThrow()
      expect(await readFile(join(repoRoot, 'files', 'seed.md'), 'utf8')).toBe(
        'local-side\n',
      )
      expect(await service.read('plan.md')).toBe('# plan\n')
      // A conflicted sweep merged nothing, so it must not announce a merge.
      const events = await listEventsSince(db, {
        topicPatterns: ['files:*'],
        audience: 'public',
      })
      expect(events.filter((e) => e.type === FILES_MERGED)).toHaveLength(0)
    })

    it('pushMain reports rejected when origin moved after the fetch, instead of forcing', async () => {
      await writeFile(join(repoRoot, 'files', 'local.md'), 'local\n')
      await git('add', '.')
      await git('commit', '-m', 'local-only')
      // Origin moves after our fetch — the push must be rejected, not forced.
      await commitToOrigin(originDir, 'files/upstream.md', 'from a PR\n')
      expect(await repo.pushMain()).toBe('rejected')
      const { stdout: originTree } = await originGit(
        'ls-tree',
        '-r',
        '--name-only',
        'main',
      )
      expect(originTree).not.toContain('files/local.md')
    })

    it('aheadOfOrigin is 0 when origin/main was never fetched — nothing owed', async () => {
      await git('update-ref', '-d', 'refs/remotes/origin/main')
      expect(await repo.aheadOfOrigin()).toBe(0)
    })

    it('a sweep with nothing staged and nothing to push touches origin not at all', async () => {
      const { stdout: before } = await originGit('rev-parse', 'main')
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('no-staging')
      const { stdout: after } = await originGit('rev-parse', 'main')
      expect(after).toBe(before)
    })

    it('after a rejected push, the next sweep syncs and pushes without needing a new write', async () => {
      // The aftermath of a rejected push: local main carries an unpushed
      // commit, origin moved past our last fetch, staging is gone.
      await writeFile(join(repoRoot, 'files', 'local.md'), 'local\n')
      await git('add', '.')
      await git('commit', '-m', 'unpushed sweep merge')
      await commitToOrigin(originDir, 'files/upstream.md', 'from a PR\n')

      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('pushed')

      const { stdout: localTip } = await git('rev-parse', 'main')
      const { stdout: originTip } = await originGit('rev-parse', 'main')
      expect(originTip.trim()).toBe(localTip.trim())
      const { stdout: originTree } = await originGit(
        'ls-tree',
        '-r',
        '--name-only',
        'main',
      )
      expect(originTree).toContain('files/local.md')
    })
  })
})

/**
 * The sweep's order of operations and failure handling are contracts of the
 * SERVICE, not of git — so they're pinned against a recording fake, where a
 * rejected push (origin moving between fetch and push) is even reachable.
 */
describe('the sweep against a fake repo: order and failure handling', () => {
  let db: Database
  let close: () => Promise<void>

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
  })

  afterEach(async () => {
    await close()
  })

  interface FakeState {
    staging: boolean
    origin: boolean
    ahead: number
    sync: 'synced' | 'conflict'
    merge: 'merged' | 'conflict'
    push: 'pushed' | 'rejected'
  }

  function fakeRepo(overrides: Partial<FakeState> = {}): {
    repo: FilesRepo
    calls: string[]
    state: FakeState
  } {
    const state: FakeState = {
      staging: true,
      origin: true,
      ahead: 0,
      sync: 'synced',
      merge: 'merged',
      push: 'pushed',
      ...overrides,
    }
    const calls: string[] = []
    const repo: FilesRepo = {
      ensureFilesDir: () => Promise.resolve(),
      stagingExists: () => Promise.resolve(state.staging),
      listStaged: () => Promise.resolve([]),
      listDisk: () => Promise.resolve([]),
      readStaged: () => Promise.resolve(null),
      readDisk: () => Promise.resolve(null),
      commitToStaging: () => Promise.resolve(),
      stagedAt: () => Promise.resolve(0),
      mergeReadiness: () => Promise.resolve('ready' as const),
      hasOrigin: () => Promise.resolve(state.origin),
      fetchOrigin: () => {
        calls.push('fetch')
        return Promise.resolve()
      },
      aheadOfOrigin: () => Promise.resolve(state.ahead),
      syncWithOrigin: () => {
        calls.push('sync')
        return Promise.resolve(state.sync)
      },
      mergeStaging: () => {
        calls.push('merge')
        state.staging = false
        return Promise.resolve(state.merge)
      },
      pushMain: () => {
        calls.push('push')
        return Promise.resolve(state.push)
      },
    }
    return { repo, calls, state }
  }

  it('runs fetch → sync → merge → push, in that order', async () => {
    const { repo, calls } = fakeRepo()
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('merged')
    expect(calls).toEqual(['fetch', 'sync', 'merge', 'push'])
  })

  it('without an origin remote the sweep merges as before and never pushes', async () => {
    const { repo, calls } = fakeRepo({ origin: false })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('merged')
    expect(calls).toEqual(['merge'])
  })

  it('a sync conflict postpones before anything merges or pushes', async () => {
    const { repo, calls } = fakeRepo({ sync: 'conflict' })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('conflict')
    expect(calls).toEqual(['fetch', 'sync'])
  })

  it('a rejected push postpones after the merge landed; the next sweep retries it', async () => {
    const { repo, calls, state } = fakeRepo({ push: 'rejected' })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('push-rejected')
    expect(calls).toEqual(['fetch', 'sync', 'merge', 'push'])

    // Next sweep: staging merged away, but local main is ahead of the origin
    // ref we last fetched — the sweep syncs with the moved origin and pushes.
    calls.length = 0
    state.ahead = 1
    state.push = 'pushed'
    expect(await service.sweep(FILES_IDLE_MS)).toBe('pushed')
    expect(calls).toEqual(['fetch', 'sync', 'push'])
  })

  it('nothing staged, nothing unpushed: the sweep does no git work at all', async () => {
    const { repo, calls } = fakeRepo({ staging: false, ahead: 0 })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('no-staging')
    expect(calls).toEqual([])
  })
})
