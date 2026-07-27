import { execFile } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { uuidv7 } from '@earendil-works/pi-agent-core'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { listEventsSince } from '@hull/events/service'
import { createUser } from '@hull/users/service'

import { createFilesRepo, type FilesRepo, type MergeReadiness } from './git'
import {
  createFilesService,
  createSweepReporter,
  FILE_CHANGED,
  FILES_IDLE_MS,
  FILES_MERGED,
  FILES_SWEEP_WEDGED,
  findCapturedCommandBanner,
  shouldMergeStaging,
  SWEEP_FAILURE_LIMIT,
  SWEEP_LOG_REPEAT_EVERY,
  SWEEP_WEDGED_PROBE_EVERY,
  sweepGate,
  validateFilePath,
  type FilesService,
  type SweepOutcome,
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

/**
 * Move origin's main from elsewhere — a PR merged on GitHub, in miniature.
 * `null` content deletes the path (a doc a PR removed on purpose).
 */
async function commitToOrigin(
  originDir: string,
  path: string,
  content: string | null,
): Promise<void> {
  const cloneDir = await mkdtemp(join(tmpdir(), 'skylark-clone-'))
  try {
    await run('git', ['clone', originDir, cloneDir])
    const git = (...args: string[]) => run('git', args, { cwd: cloneDir })
    await git('config', 'user.name', 'elsewhere')
    await git('config', 'user.email', 'elsewhere@test')
    await mkdir(join(cloneDir, 'files'), { recursive: true })
    if (content === null) await git('rm', '--', path)
    else await writeFile(join(cloneDir, path), content)
    await git('add', '-A')
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

  it('refuses content that is captured command output, staging nothing', async () => {
    await expect(
      service.write({
        path: 'agents/tilde/index.md',
        content:
          '> files\n> node --env-file-if-exists=.env --import tsx src/hull/files/cli.ts read agents/tilde/index.md\n\n# Tilde\n',
        actor: AUTHOR,
      }),
      // The error names the problem, shows the offending lines, and says what
      // to do instead — the caller is usually an agent that can fix itself.
    ).rejects.toThrow(
      /captured command output[\s\S]*cli\.ts read agents\/tilde[\s\S]*fenced code block/i,
    )

    // Nothing staged, nothing announced — the bad write never happened.
    expect(await repo.stagingExists()).toBe(false)
    const events = await listEventsSince(db, {
      topicPatterns: ['file:*'],
      audience: 'public',
    })
    expect(events).toHaveLength(0)
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

  /**
   * The serving checkout is somebody's working copy: a crew member can be part
   * way through resolving a merge by hand on main, with the conflict nowhere near
   * the files dir. The sweep aborts merges it started — it must never abort one it
   * didn't, or that hand resolution is gone.
   */
  it('keeps its hands off a merge somebody else started, even outside the files dir', async () => {
    await writeFile(join(repoRoot, 'code.txt'), 'base\n')
    await git('add', '.')
    await git('commit', '-m', 'base code')
    await git('checkout', '-b', 'theirs')
    await writeFile(join(repoRoot, 'code.txt'), 'theirs\n')
    await git('add', '.')
    await git('commit', '-m', 'theirs code')
    await git('checkout', 'main')
    await writeFile(join(repoRoot, 'code.txt'), 'ours\n')
    await git('add', '.')
    await git('commit', '-m', 'ours code')
    // A human, mid-merge, conflict still open.
    await git('merge', 'theirs').catch(() => undefined)
    const { stdout: before } = await git('status', '--porcelain')

    expect(await repo.mergeReadiness()).toBe('merge-in-progress')
    await service.write({ path: 'p.md', content: 'x', actor: AUTHOR })
    expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('postponed')

    // Their merge is exactly where they left it, and the staged doc is safe.
    await git('rev-parse', '--verify', 'MERGE_HEAD')
    const { stdout: after } = await git('status', '--porcelain')
    expect(after).toBe(before)
    expect(await service.read('p.md')).toBe('x')
  })

  it('stays out of a half-finished rebase too, not just a merge', async () => {
    await writeFile(join(repoRoot, 'code.txt'), 'base\n')
    await git('add', '.')
    await git('commit', '-m', 'base code')
    await git('checkout', '-b', 'theirs')
    await writeFile(join(repoRoot, 'code.txt'), 'theirs\n')
    await git('add', '.')
    await git('commit', '-m', 'theirs code')
    await git('checkout', 'main')
    await writeFile(join(repoRoot, 'code.txt'), 'ours\n')
    await git('add', '.')
    await git('commit', '-m', 'ours code')
    // A human, mid-rebase, conflict still open — no MERGE_HEAD, but a rebase dir.
    await git('rebase', 'theirs').catch(() => undefined)

    expect(await repo.mergeReadiness()).toBe('merge-in-progress')
    await git('rebase', '--abort')
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

    /**
     * The #p5as regression: local main is a DESCENDANT of origin/main with a
     * backlog of unpushed doc commits. A plain push fast-forwards, so the sweep
     * must not try to replay that backlog — the rebase it used to run wedged on
     * commit 1 of 56 and never recovered. Pinned by SHA: a rebase (or any
     * history rewrite) would change the backlog commit's id.
     */
    it('does not touch history when origin is already an ancestor — it just pushes the backlog', async () => {
      await writeFile(join(repoRoot, 'files', 'backlog.md'), 'unpushed\n')
      await git('add', '.')
      await git('commit', '-m', 'backlog doc commit')
      const { stdout: backlogSha } = await git('rev-parse', 'HEAD')

      await service.write({
        path: 'plan.md',
        content: '# plan\n',
        actor: AUTHOR,
      })
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('merged')

      // The backlog commit is still itself, still in main's history: nothing
      // replayed it, and no merge commit was needed to reach origin.
      const { stdout: afterSha } = await git(
        'rev-parse',
        `${backlogSha.trim()}^{commit}`,
      )
      expect(afterSha.trim()).toBe(backlogSha.trim())
      await git('merge-base', '--is-ancestor', backlogSha.trim(), 'main')
      const { stdout: merges } = await git(
        'rev-list',
        '--count',
        '--merges',
        'main',
      )
      expect(merges.trim()).toBe('0')

      const { stdout: localTip } = await git('rev-parse', 'main')
      const { stdout: originTip } = await originGit('rev-parse', 'main')
      expect(originTip.trim()).toBe(localTip.trim())
    })

    it('converges local-only commits with a moved origin without rewriting them, then pushes everything', async () => {
      // Local main has its own commit (yesterday's unpushed sweep, say)…
      await writeFile(join(repoRoot, 'files', 'local.md'), 'local\n')
      await git('add', '.')
      await git('commit', '-m', 'local-only')
      const { stdout: localSha } = await git('rev-parse', 'HEAD')
      // …and origin moved independently.
      await commitToOrigin(originDir, 'files/upstream.md', 'from a PR\n')

      await service.write({
        path: 'plan.md',
        content: '# plan\n',
        actor: AUTHOR,
      })
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('merged')

      // Convergence is a merge, not a replay: the local commit keeps its id.
      await git('merge-base', '--is-ancestor', localSha.trim(), 'main')
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

    it('a doc both sides edited converges by union: neither side loses a line', async () => {
      // Local main and origin edit the same doc, apart — the old rebase wedged
      // here; convergence keeps both sides' lines and leaves no markers.
      await writeFile(
        join(repoRoot, 'files', 'seed.md'),
        '# seed\nlocal note\n',
      )
      await git('add', '.')
      await git('commit', '-m', 'local-side edit')
      await commitToOrigin(originDir, 'files/seed.md', '# seed\norigin note\n')

      await service.write({
        path: 'plan.md',
        content: '# plan\n',
        actor: AUTHOR,
      })
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('merged')

      const seed = await readFile(join(repoRoot, 'files', 'seed.md'), 'utf8')
      expect(seed).toContain('local note')
      expect(seed).toContain('origin note')
      expect(seed).not.toContain('<<<<<<<')
      const { stdout: status } = await git('status', '--porcelain')
      expect(status.trim()).toBe('')
      const { stdout: localTip } = await git('rev-parse', 'main')
      const { stdout: originTip } = await originGit('rev-parse', 'main')
      expect(originTip.trim()).toBe(localTip.trim())
    })

    it('two sides adding the same new doc keep both bodies', async () => {
      await writeFile(join(repoRoot, 'files', 'both.md'), 'from the ship\n')
      await git('add', '.')
      await git('commit', '-m', 'local adds both.md')
      await commitToOrigin(originDir, 'files/both.md', 'from a PR\n')

      await service.write({ path: 'p.md', content: 'x', actor: AUTHOR })
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('merged')

      const both = await readFile(join(repoRoot, 'files', 'both.md'), 'utf8')
      expect(both).toContain('from the ship')
      expect(both).toContain('from a PR')
    })

    it('a doc origin deleted but the ship kept writing survives — the sweep never destroys content', async () => {
      await writeFile(join(repoRoot, 'files', 'seed.md'), '# seed\nship note\n')
      await git('add', '.')
      await git('commit', '-m', 'local keeps writing seed.md')
      await commitToOrigin(originDir, 'files/seed.md', null)

      await service.write({ path: 'p.md', content: 'x', actor: AUTHOR })
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('merged')

      expect(await readFile(join(repoRoot, 'files', 'seed.md'), 'utf8')).toBe(
        '# seed\nship note\n',
      )
    })

    it('a conflict outside the files dir is never auto-resolved: it aborts cleanly and waits for a human', async () => {
      await writeFile(join(repoRoot, 'code.txt'), 'local code\n')
      await git('add', '.')
      await git('commit', '-m', 'local code edit')
      await commitToOrigin(originDir, 'code.txt', 'origin code\n')

      await service.write({
        path: 'plan.md',
        content: '# plan\n',
        actor: AUTHOR,
      })
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('conflict')

      // Nothing left mid-merge; every side survives for the next attempt.
      const { stdout: status } = await git('status', '--porcelain')
      expect(status.trim()).toBe('')
      await expect(git('rev-parse', '--verify', 'MERGE_HEAD')).rejects.toThrow()
      expect(await readFile(join(repoRoot, 'code.txt'), 'utf8')).toBe(
        'local code\n',
      )
      expect(await service.read('plan.md')).toBe('# plan\n')
      // A conflicted sweep merged nothing, so it must not announce a merge.
      const events = await listEventsSince(db, {
        topicPatterns: ['files:*'],
        audience: 'public',
      })
      expect(events.filter((e) => e.type === FILES_MERGED)).toHaveLength(0)
    })

    /**
     * A staged file stops git from starting a merge at all, which leaves ZERO
     * unmerged paths. That must read as "not now", not as "a document conflict
     * nobody can settle" — a false alarm on the one alarm this issue adds would
     * teach the crew to ignore it.
     */
    it('somebody with a staged file makes the sweep wait, not cry conflict', async () => {
      await commitToOrigin(originDir, 'files/upstream.md', 'from a PR\n')
      await writeFile(join(repoRoot, 'code.txt'), 'half-done work\n')
      await git('add', 'code.txt')

      expect(await repo.mergeReadiness()).toBe('index-dirty')
      await service.write({ path: 'p.md', content: 'x', actor: AUTHOR })
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('postponed')

      // Their staged work is untouched, and nothing was announced as a conflict.
      const { stdout: staged } = await git('diff', '--cached', '--name-only')
      expect(staged.trim()).toBe('code.txt')

      // Once they commit it, the very next sweep drains normally.
      await git('commit', '-m', 'their work')
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('merged')
    })

    it('a conflicting symlink is never unioned — writing through one would land outside the repo', async () => {
      await symlink('/etc/passwd', join(repoRoot, 'files', 'link.md'))
      await git('add', '-A')
      await git('commit', '-m', 'local symlink')
      await commitToOrigin(originDir, 'files/link.md', 'a real doc\n')

      await service.write({ path: 'p.md', content: 'x', actor: AUTHOR })
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('conflict')
      const { stdout: status } = await git('status', '--porcelain')
      expect(status.trim()).toBe('')
      await expect(git('rev-parse', '--verify', 'MERGE_HEAD')).rejects.toThrow()
    })

    it('names the unioned documents in the merge commit, so the mess is findable', async () => {
      await writeFile(join(repoRoot, 'files', 'seed.md'), '# seed\nlocal\n')
      await git('add', '.')
      await git('commit', '-m', 'local edit')
      await commitToOrigin(originDir, 'files/seed.md', '# seed\norigin\n')

      await service.write({ path: 'p.md', content: 'x', actor: AUTHOR })
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('merged')

      const { stdout: log } = await git('log', '--format=%B', '-20')
      expect(log).toContain('Unioned conflicting documents')
      expect(log).toContain('- files/seed.md')
    })

    it('a conflicting binary doc is never unioned — union is a text rule only', async () => {
      const bin = join(repoRoot, 'files', 'logo.bin')
      await writeFile(bin, 'ship\0')
      await git('add', '.')
      await git('commit', '-m', 'local binary')
      await commitToOrigin(originDir, 'files/logo.bin', 'origin\0')

      await service.write({ path: 'p.md', content: 'x', actor: AUTHOR })
      expect(await service.sweep(Date.now() + FILES_IDLE_MS)).toBe('conflict')
      const { stdout: status } = await git('status', '--porcelain')
      expect(status.trim()).toBe('')
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

    it('both origin counts are 0 when origin/main was never fetched — nothing owed, nothing to converge', async () => {
      await git('update-ref', '-d', 'refs/remotes/origin/main')
      expect(await repo.aheadOfOrigin()).toBe(0)
      expect(await repo.behindOrigin()).toBe(0)
    })

    it('behindOrigin counts only what origin has that we lack', async () => {
      expect(await repo.behindOrigin()).toBe(0)
      // A local commit makes us ahead, never behind.
      await writeFile(join(repoRoot, 'files', 'local.md'), 'local\n')
      await git('add', '.')
      await git('commit', '-m', 'local-only')
      expect(await repo.behindOrigin()).toBe(0)
      // Origin moving is what makes us behind — once we have fetched it.
      await commitToOrigin(originDir, 'files/upstream.md', 'from a PR\n')
      await repo.fetchOrigin()
      expect(await repo.behindOrigin()).toBe(1)
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
    behind: number
    readiness: MergeReadiness
    converge: 'converged' | 'conflict'
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
      behind: 0,
      readiness: 'ready',
      converge: 'converged',
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
      mergeReadiness: () => Promise.resolve(state.readiness),
      hasOrigin: () => Promise.resolve(state.origin),
      fetchOrigin: () => {
        calls.push('fetch')
        return Promise.resolve()
      },
      aheadOfOrigin: () => Promise.resolve(state.ahead),
      behindOrigin: () => Promise.resolve(state.behind),
      convergeWithOrigin: () => {
        calls.push('converge')
        return Promise.resolve(state.converge)
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

  it('runs fetch → merge → push, and does not converge when origin has not moved', async () => {
    const { repo, calls } = fakeRepo()
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('merged')
    expect(calls).toEqual(['fetch', 'merge', 'push'])
  })

  it('converges only when origin genuinely advanced past local main', async () => {
    const { repo, calls } = fakeRepo({ behind: 2 })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('merged')
    expect(calls).toEqual(['fetch', 'converge', 'merge', 'push'])
  })

  it('without an origin remote the sweep merges as before and never pushes', async () => {
    const { repo, calls } = fakeRepo({ origin: false })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('merged')
    expect(calls).toEqual(['merge'])
  })

  it('a failed convergence stops before anything merges or pushes', async () => {
    const { repo, calls } = fakeRepo({ behind: 1, converge: 'conflict' })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('conflict')
    expect(calls).toEqual(['fetch', 'converge'])
  })

  it('a rejected push postpones after the merge landed; the next sweep retries it', async () => {
    const { repo, calls, state } = fakeRepo({ push: 'rejected' })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('push-rejected')
    expect(calls).toEqual(['fetch', 'merge', 'push'])

    // Next sweep: staging merged away, but local main is ahead of the origin
    // ref we last fetched — the sweep pushes it without a new write.
    calls.length = 0
    state.ahead = 1
    state.push = 'pushed'
    expect(await service.sweep(FILES_IDLE_MS)).toBe('pushed')
    expect(calls).toEqual(['fetch', 'push'])
  })

  /**
   * The #p5as shape at the service level: nothing staged, a backlog of local
   * commits, origin still an ancestor. The sweep must push and never converge.
   */
  it('pushes an unpushed backlog without converging when origin is an ancestor', async () => {
    const { repo, calls } = fakeRepo({ staging: false, ahead: 63, behind: 0 })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('pushed')
    expect(calls).toEqual(['fetch', 'push'])
  })

  it('nothing staged, nothing unpushed: the sweep does no git work at all', async () => {
    const { repo, calls } = fakeRepo({ staging: false, ahead: 0 })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('no-staging')
    expect(calls).toEqual([])
  })

  it('a repo with no origin has nothing to push and stays out of git', async () => {
    const { repo, calls } = fakeRepo({
      staging: false,
      origin: false,
      ahead: 9,
    })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('no-staging')
    expect(calls).toEqual([])
  })

  it('an unpushed backlog waits for a clean main before it fetches anything', async () => {
    const { repo, calls } = fakeRepo({
      staging: false,
      ahead: 3,
      readiness: 'not-on-main',
    })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('postponed')
    expect(calls).toEqual([])
  })

  it('an unpushed backlog that cannot converge with a moved origin never pushes', async () => {
    const { repo, calls } = fakeRepo({
      staging: false,
      ahead: 3,
      behind: 1,
      converge: 'conflict',
    })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('conflict')
    expect(calls).toEqual(['fetch', 'converge'])
  })

  it('an unpushed backlog whose push is rejected reports it and waits', async () => {
    const { repo, calls } = fakeRepo({
      staging: false,
      ahead: 3,
      push: 'rejected',
    })
    const service = createFilesService({ db, repo })
    expect(await service.sweep(FILES_IDLE_MS)).toBe('push-rejected')
    expect(calls).toEqual(['fetch', 'push'])
  })

  describe('a wedged sweep stops hammering git', () => {
    it('latches after SWEEP_FAILURE_LIMIT identical failures and then touches no git', async () => {
      const { repo, calls, state } = fakeRepo({
        behind: 1,
        converge: 'conflict',
      })
      const service = createFilesService({ db, repo })
      for (let i = 0; i < SWEEP_FAILURE_LIMIT; i++) {
        expect(await service.sweep(FILES_IDLE_MS)).toBe('conflict')
        state.staging = true
      }
      calls.length = 0
      expect(await service.sweep(FILES_IDLE_MS)).toBe('wedged')
      expect(calls).toEqual([])
    })

    it('stays quiet on the ship log until the limit, then announces exactly once', async () => {
      const { repo, state } = fakeRepo({ behind: 1, converge: 'conflict' })
      const service = createFilesService({ db, repo })
      const wedgeEvents = async () => {
        const events = await listEventsSince(db, {
          topicPatterns: ['files:*'],
          audience: 'public',
        })
        return events.filter((e) => e.type === FILES_SWEEP_WEDGED)
      }

      // A failure or four is ordinary weather — nobody needs telling.
      for (let i = 0; i < SWEEP_FAILURE_LIMIT - 1; i++) {
        expect(await service.sweep(FILES_IDLE_MS)).toBe('conflict')
        state.staging = true
        expect(await wedgeEvents()).toHaveLength(0)
      }

      // The limit-th failure is the news, and it's said once, with the detail.
      expect(await service.sweep(FILES_IDLE_MS)).toBe('conflict')
      for (let i = 0; i < 3; i++) {
        state.staging = true
        await service.sweep(FILES_IDLE_MS)
      }
      const announced = await wedgeEvents()
      expect(announced).toHaveLength(1)
      expect(announced[0].source).toBe('files')
      expect(announced[0].payload).toEqual({
        outcome: 'conflict',
        consecutiveFailures: SWEEP_FAILURE_LIMIT,
      })
    })

    /**
     * A THROW is a failure too. An offline ship's `git fetch` rejects on every
     * tick; if throws skip the bookkeeping, the bound is a lie and the sweep
     * hammers git forever without announcing anything — the #p5as shape again,
     * wearing a different hat.
     */
    it('counts a thrown sweep toward the latch, and still surfaces the error', async () => {
      const { repo, calls } = fakeRepo()
      const offline = {
        ...repo,
        fetchOrigin: () => {
          calls.push('fetch')
          return Promise.reject(new Error('could not resolve host: github.com'))
        },
      }
      const service = createFilesService({ db, repo: offline })

      for (let i = 0; i < SWEEP_FAILURE_LIMIT; i++) {
        // The error still reaches the caller (the sweep helper logs it).
        await expect(service.sweep(FILES_IDLE_MS)).rejects.toThrow(
          /could not resolve host/,
        )
      }

      // …and now it stops hammering git, and it said so on the ship's log.
      calls.length = 0
      expect(await service.sweep(FILES_IDLE_MS)).toBe('wedged')
      expect(calls).toEqual([])
      const events = await listEventsSince(db, {
        topicPatterns: ['files:*'],
        audience: 'public',
      })
      const wedged = events.filter((e) => e.type === FILES_SWEEP_WEDGED)
      expect(wedged).toHaveLength(1)
      expect(wedged[0].payload).toEqual({
        outcome: 'error',
        consecutiveFailures: SWEEP_FAILURE_LIMIT,
      })
    })

    it('announces once per wedge, not once per probe — no drip on the ship log', async () => {
      const { repo, state } = fakeRepo({ behind: 1, converge: 'conflict' })
      const service = createFilesService({ db, repo })
      for (let i = 0; i < SWEEP_FAILURE_LIMIT; i++) {
        await service.sweep(FILES_IDLE_MS)
        state.staging = true
      }
      for (let i = 0; i < SWEEP_WEDGED_PROBE_EVERY; i++) {
        await service.sweep(FILES_IDLE_MS)
      }
      // The probe tick fails again — the wedge is old news, not new news.
      expect(await service.sweep(FILES_IDLE_MS)).toBe('conflict')
      const events = await listEventsSince(db, {
        topicPatterns: ['files:*'],
        audience: 'public',
      })
      expect(events.filter((e) => e.type === FILES_SWEEP_WEDGED)).toHaveLength(
        1,
      )
    })

    it('probes again after SWEEP_WEDGED_PROBE_EVERY skipped ticks, so a cleared cause recovers', async () => {
      const { repo, calls, state } = fakeRepo({
        behind: 1,
        converge: 'conflict',
      })
      const service = createFilesService({ db, repo })
      for (let i = 0; i < SWEEP_FAILURE_LIMIT; i++) {
        await service.sweep(FILES_IDLE_MS)
        state.staging = true
      }
      for (let i = 0; i < SWEEP_WEDGED_PROBE_EVERY; i++) {
        expect(await service.sweep(FILES_IDLE_MS)).toBe('wedged')
      }
      // The cause cleared in the meantime — the probe tick finds it and drains.
      state.converge = 'converged'
      calls.length = 0
      expect(await service.sweep(FILES_IDLE_MS)).toBe('merged')
      expect(calls).toEqual(['fetch', 'converge', 'merge', 'push'])
      // …and a success clears the latch: the next tick works normally again.
      state.staging = true
      expect(await service.sweep(FILES_IDLE_MS)).toBe('merged')
    })

    it('a successful sweep between failures resets the count', async () => {
      const { repo, state } = fakeRepo({ behind: 1, converge: 'conflict' })
      const service = createFilesService({ db, repo })
      for (let i = 0; i < SWEEP_FAILURE_LIMIT - 1; i++) {
        expect(await service.sweep(FILES_IDLE_MS)).toBe('conflict')
        state.staging = true
      }
      state.converge = 'converged'
      expect(await service.sweep(FILES_IDLE_MS)).toBe('merged')
      state.staging = true
      state.converge = 'conflict'
      for (let i = 0; i < SWEEP_FAILURE_LIMIT - 1; i++) {
        expect(await service.sweep(FILES_IDLE_MS)).toBe('conflict')
        state.staging = true
      }
    })
  })
})

describe('sweepGate', () => {
  it('probes while consecutive failures are under the limit', () => {
    expect(sweepGate({ failures: 0, skipped: 0 })).toBe('probe')
    expect(sweepGate({ failures: SWEEP_FAILURE_LIMIT - 1, skipped: 0 })).toBe(
      'probe',
    )
  })

  it('skips at the limit until enough ticks have gone by, then probes once', () => {
    expect(sweepGate({ failures: SWEEP_FAILURE_LIMIT, skipped: 0 })).toBe(
      'skip',
    )
    expect(
      sweepGate({
        failures: SWEEP_FAILURE_LIMIT,
        skipped: SWEEP_WEDGED_PROBE_EVERY - 1,
      }),
    ).toBe('skip')
    expect(
      sweepGate({
        failures: SWEEP_FAILURE_LIMIT,
        skipped: SWEEP_WEDGED_PROBE_EVERY,
      }),
    ).toBe('probe')
  })
})

describe('createSweepReporter', () => {
  it('says nothing for idle or successful sweeps — a quiet log means a healthy sweep', () => {
    const report = createSweepReporter()
    for (const outcome of [
      'waiting',
      'no-staging',
      'merged',
      'pushed',
    ] satisfies SweepOutcome[]) {
      expect(report(outcome)).toBeNull()
    }
  })

  it('speaks the first time a sweep fails to get its work done', () => {
    for (const outcome of [
      'postponed',
      'conflict',
      'push-rejected',
      'wedged',
    ] satisfies SweepOutcome[]) {
      expect(createSweepReporter()(outcome)).toContain(outcome)
    }
  })

  it('throttles a repeating failure instead of flooding, but never goes silent', () => {
    const report = createSweepReporter()
    expect(report('conflict')).not.toBeNull()
    for (let i = 2; i < SWEEP_LOG_REPEAT_EVERY; i++) {
      expect(report('conflict')).toBeNull()
    }
    expect(report('conflict')).not.toBeNull()
  })

  it('speaks again as soon as the outcome changes', () => {
    const report = createSweepReporter()
    expect(report('conflict')).not.toBeNull()
    expect(report('conflict')).toBeNull()
    expect(report('postponed')).not.toBeNull()
    expect(report('conflict')).not.toBeNull()
  })
})

describe('findCapturedCommandBanner', () => {
  const banner =
    '> files\n> node --env-file-if-exists=.env --import tsx src/hull/files/cli.ts read a.md\n'

  it('finds npm’s two-line script banner captured into a document', () => {
    expect(findCapturedCommandBanner(banner)).toContain('> files')
    expect(
      findCapturedCommandBanner(`# memory\n\n${banner}\nnotes\n`),
    ).toContain('cli.ts')
    expect(
      findCapturedCommandBanner('> skylark@1.0.0 issue\n> node --x=1 cli.ts\n'),
    ).not.toBeNull()
  })

  it('leaves ordinary prose, blockquotes, and code fences alone', () => {
    expect(findCapturedCommandBanner('')).toBeNull()
    expect(findCapturedCommandBanner('# notes\n\nplain text\n')).toBeNull()
    expect(
      findCapturedCommandBanner('> A quote\n> that runs on for a while\n'),
    ).toBeNull()
    expect(
      findCapturedCommandBanner('> Heads up\n> run npm run files -- list\n'),
    ).toBeNull()
    expect(
      findCapturedCommandBanner(
        'Run it:\n\n```\nnode --env-file-if-exists=.env cli.ts read a.md\n```\n',
      ),
    ).toBeNull()
    // A single banner-shaped line with no command after it is just a quote.
    expect(findCapturedCommandBanner('> files\n\nreal content\n')).toBeNull()
  })
})
