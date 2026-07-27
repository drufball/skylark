import { spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/**
 * The git shell under the files service: every branch and commit the service
 * needs, done with plumbing against REFS — never a checkout, never the crew's
 * index. The working tree is the running app (and the crew's dev state), so a
 * staged doc edit must not move it; files land on disk only when `mergeStaging`
 * runs a real merge on a clean, main-checked-out repo.
 *
 * Everything takes the repo layout from `FilesRepoConfig`, so tests drive the
 * exact same code against a throwaway repo.
 */

export interface FilesRepoConfig {
  /** Absolute path to the git repo the files live in. */
  repoRoot: string
  /** Repo-relative directory the service owns (e.g. "src/home/files"). */
  filesDir: string
  /** The branch staged edits merge back into (e.g. "main"). */
  mainBranch: string
  /** The branch staged edits accumulate on (e.g. "files/staging"). */
  stagingBranch: string
}

/** One staged change: write `content`, or delete the path with `null`. */
export interface FileChange {
  path: string
  content: string | null
}

/** How merge-readiness came out — the sweep postpones on anything but 'ready'. */
export type MergeReadiness = 'not-on-main' | 'files-dirty' | 'ready'

export interface FilesRepo {
  /** Create the files directory on disk if it's missing. */
  ensureFilesDir(): Promise<void>
  stagingExists(): Promise<boolean>
  /** File paths (relative to filesDir) in the staging branch's tree. */
  listStaged(): Promise<string[]>
  /** File paths (relative to filesDir) on disk — the working tree. */
  listDisk(): Promise<string[]>
  /** A file's content in the staging branch, or null if absent. */
  readStaged(path: string): Promise<string | null>
  /** A file's content on disk, or null if absent. */
  readDisk(path: string): Promise<string | null>
  /**
   * Commit changes onto the staging branch (created from main if missing),
   * via a temporary index — the crew's index and working tree are untouched.
   */
  commitToStaging(
    changes: FileChange[],
    author: { name: string; email: string },
    message: string,
  ): Promise<void>
  /**
   * When the staging tip was committed (ms epoch) — the sweep's idle clock.
   * Derived from git, not process memory, so it's correct across restarts and
   * across processes (a CLI write elsewhere resets it too).
   */
  stagedAt(): Promise<number>
  /** May a merge run right now? Only on a clean, main-checked-out repo. */
  mergeReadiness(): Promise<MergeReadiness>
  /**
   * Really merge staging into main (updating the working tree), deleting the
   * staging branch on success. A conflict aborts the merge and leaves both
   * branches as they were.
   */
  mergeStaging(): Promise<'merged' | 'conflict'>
  /** Is there an `origin` remote to sync with? Without one, main is local-only. */
  hasOrigin(): Promise<boolean>
  /** Fetch origin's main, updating the remote-tracking ref the sync reads. */
  fetchOrigin(): Promise<void>
  /**
   * How many commits local main carries that origin/main (as of the last
   * fetch) does not — the leftovers of a push a previous sweep couldn't land.
   * Local refs only, no network; 0 when origin was never fetched.
   */
  aheadOfOrigin(): Promise<number>
  /**
   * How many commits origin/main (as of the last fetch) carries that local main
   * does not. 0 means origin/main is already an ancestor of local main, so a
   * plain push fast-forwards and there is nothing to converge — the common case,
   * and the one an unconditional sync used to wedge on (#p5as).
   */
  behindOrigin(): Promise<number>
  /**
   * Converge local main with a genuinely-advanced origin/main: fast-forward when
   * strictly behind, else a real merge of origin/main into main — content, not a
   * replay of local history, so no historical commit can ever block it. A
   * conflict INSIDE the files dir is resolved by union (both sides' lines kept);
   * anything else aborts and leaves main exactly as it was. Updates the working
   * tree, so only call on a clean, main-checked-out repo.
   */
  convergeWithOrigin(): Promise<'converged' | 'conflict'>
  /**
   * Push local main to origin — never forced. 'rejected' when origin moved
   * since the fetch (the next sweep's sync handles the new divergence).
   */
  pushMain(): Promise<'pushed' | 'rejected'>
}

/** Run git in a repo, optionally feeding stdin; rejects with stderr on failure. */
function runGit(
  repoRoot: string,
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd: repoRoot,
      env: { ...process.env, ...opts.env },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`git ${args[0]} failed: ${stderr.trim()}`))
    })
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
  })
}

/** The commits the service itself makes are committed by the service. */
const COMMITTER = { name: 'skylark-files', email: 'files@skylark.local' }

/** The one remote the sweep syncs with — the convention, not a config knob. */
const ORIGIN = 'origin'

export function createFilesRepo(config: FilesRepoConfig): FilesRepo {
  const { repoRoot, filesDir, mainBranch, stagingBranch } = config
  const originMainRef = `refs/remotes/${ORIGIN}/${mainBranch}`
  const git = (
    args: string[],
    opts?: { input?: string; env?: Record<string, string> },
  ) => runGit(repoRoot, args, opts)
  const filesRoot = resolve(repoRoot, filesDir)

  /** The path as git sees it, guarded against escaping the files dir. */
  function repoPath(path: string): string {
    const abs = resolve(filesRoot, path)
    if (abs !== filesRoot && !abs.startsWith(filesRoot + sep)) {
      throw new Error(`Path escapes the files dir: ${path}`)
    }
    return `${filesDir}/${path}`
  }

  /**
   * Refuse to act unless `repoRoot` IS the repository git resolves. Git
   * discovers its repo by walking upward from cwd, so a repoRoot that is a
   * plain directory inside some other checkout would silently aim every
   * commit, merge, and branch delete at a repo this service does not own.
   * Checked once, before any ref-mutating command; fail-closed thereafter.
   */
  let ownRepoChecked: Promise<void> | undefined
  function assertOwnRepo(): Promise<void> {
    ownRepoChecked ??= (async () => {
      const top = (await git(['rev-parse', '--show-toplevel'])).trim()
      const [actual, expected] = await Promise.all([
        realpath(top),
        realpath(repoRoot),
      ])
      if (actual !== expected) {
        throw new Error(
          `files repo refuses to run git: ${repoRoot} is not the repository root (git resolves ${top})`,
        )
      }
    })()
    return ownRepoChecked
  }

  /** Is this repo-relative path inside the directory the service owns? */
  function insideFilesDir(path: string): boolean {
    return path.startsWith(`${filesDir}/`)
  }

  /**
   * The paths left unmerged by the merge in progress — raw (NUL-separated), so
   * a unicode or spaced filename arrives exactly as git holds it.
   */
  async function unmergedPaths(): Promise<string[]> {
    const out = await git(['diff', '-z', '--name-only', '--diff-filter=U'])
      /* v8 ignore next -- git diff has no failure mode here; treating one as
         "no conflicts I can settle" keeps the caller's abort path in charge. */
      .catch(() => '')
    return out.split('\0').filter(Boolean)
  }

  /** One side of a conflicted path, or null when that side doesn't have it. */
  async function conflictStage(
    stage: 1 | 2 | 3,
    path: string,
  ): Promise<string | null> {
    try {
      return await git(['show', `:${String(stage)}:${path}`])
    } catch {
      return null
    }
  }

  /**
   * Resolve one conflicted document by union: both sides' hunks, in order,
   * with no markers. A path only one side still has survives with that side's
   * content — the sweep does not delete a document out from under a writer.
   */
  async function unionResolve(
    path: string,
    sides: { base: string | null; ours: string; theirs: string },
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'skylark-files-union-'))
    try {
      const paths = {
        base: join(dir, 'base'),
        ours: join(dir, 'ours'),
        theirs: join(dir, 'theirs'),
      }
      await writeFile(paths.base, sides.base ?? '')
      await writeFile(paths.ours, sides.ours)
      await writeFile(paths.theirs, sides.theirs)
      const merged = await git([
        'merge-file',
        '--union',
        '-p',
        paths.ours,
        paths.base,
        paths.theirs,
      ])
      await writeFile(resolve(repoRoot, path), merged)
      await git(['add', '--', path])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * Try to resolve the merge in progress under the union policy. Returns false —
   * having changed nothing — when the conflict is not ours to settle: a path
   * outside the files dir (code, config: a human's call), a binary document
   * (union is a line rule), or no unmerged paths at all (the merge failed for
   * some other reason, e.g. a dirty working tree). The caller then aborts.
   */
  async function unionResolveDocConflicts(): Promise<boolean> {
    const paths = await unmergedPaths()
    if (paths.length === 0 || !paths.every(insideFilesDir)) return false
    const sides = await Promise.all(
      paths.map(async (path) => ({
        path,
        base: await conflictStage(1, path),
        ours: await conflictStage(2, path),
        theirs: await conflictStage(3, path),
      })),
    )
    if (sides.some((s) => [s.ours, s.theirs].some((v) => v?.includes('\0')))) {
      return false
    }
    for (const side of sides) {
      if (side.ours !== null && side.theirs !== null) {
        await unionResolve(side.path, {
          base: side.base,
          ours: side.ours,
          theirs: side.theirs,
        })
        continue
      }
      const kept = side.ours ?? side.theirs
      /* v8 ignore next 2 -- both sides gone (git's "DD"): rare enough that no
         fixture produces it, and a guess about a doc nobody has is a human's. */
      if (kept === null) return false
      // Modify/delete: keep the side that still has the document, by writing it
      // back — a sweep never destroys content it didn't author.
      await writeFile(resolve(repoRoot, side.path), kept)
      await git(['add', '--', side.path])
    }
    return true
  }

  async function stagingExists(): Promise<boolean> {
    try {
      await git(['show-ref', '--verify', `refs/heads/${stagingBranch}`])
      return true
    } catch {
      return false
    }
  }

  return {
    async ensureFilesDir() {
      await mkdir(filesRoot, { recursive: true })
    },

    stagingExists,

    async listStaged() {
      const out = await git([
        'ls-tree',
        '-r',
        '--name-only',
        stagingBranch,
        '--',
        filesDir,
      ])
      return out
        .split('\n')
        .filter(Boolean)
        .map((p) => p.slice(filesDir.length + 1))
    },

    async listDisk() {
      await mkdir(filesRoot, { recursive: true })
      const entries = await readdir(filesRoot, {
        recursive: true,
        withFileTypes: true,
      })
      return entries
        .filter((e) => e.isFile())
        .map((e) => {
          const dir = resolve(e.parentPath)
          const rel =
            dir === filesRoot ? '' : dir.slice(filesRoot.length + 1) + '/'
          return `${rel}${e.name}`.replaceAll(sep, '/')
        })
        .sort()
    },

    async readStaged(path) {
      try {
        return await git(['show', `${stagingBranch}:${repoPath(path)}`])
      } catch {
        return null
      }
    },

    async readDisk(path) {
      const abs = resolve(filesRoot, path)
      if (abs !== filesRoot && !abs.startsWith(filesRoot + sep)) {
        throw new Error(`Path escapes the files dir: ${path}`)
      }
      try {
        return await readFile(abs, 'utf8')
      } catch {
        return null
      }
    },

    async commitToStaging(changes, author, message) {
      await assertOwnRepo()
      const exists = await stagingExists()
      const baseRef = exists ? stagingBranch : mainBranch
      const baseCommit = (await git(['rev-parse', baseRef])).trim()

      // A temp index so the crew's real index never sees these changes.
      const indexFile = join(
        tmpdir(),
        `skylark-files-index-${String(process.pid)}-${Math.random().toString(36).slice(2)}`,
      )
      const env = { GIT_INDEX_FILE: indexFile }
      try {
        await git(['read-tree', baseCommit], { env })
        for (const change of changes) {
          if (change.content === null) {
            await git(
              ['update-index', '--force-remove', repoPath(change.path)],
              {
                env,
              },
            )
          } else {
            const oid = (
              await git(['hash-object', '-w', '--stdin'], {
                input: change.content,
              })
            ).trim()
            await git(
              [
                'update-index',
                '--add',
                '--cacheinfo',
                `100644,${oid},${repoPath(change.path)}`,
              ],
              { env },
            )
          }
        }
        const tree = (await git(['write-tree'], { env })).trim()
        const commit = (
          await git(['commit-tree', tree, '-p', baseCommit, '-m', message], {
            env: {
              GIT_AUTHOR_NAME: author.name,
              GIT_AUTHOR_EMAIL: author.email,
              GIT_COMMITTER_NAME: COMMITTER.name,
              GIT_COMMITTER_EMAIL: COMMITTER.email,
            },
          })
        ).trim()
        // Compare-and-swap: create-only when staging didn't exist, else advance
        // from exactly the base we built on — a concurrent writer fails loudly
        // instead of being silently overwritten.
        await git([
          'update-ref',
          `refs/heads/${stagingBranch}`,
          commit,
          exists ? baseCommit : '',
        ])
      } finally {
        await rm(indexFile, { force: true })
      }
    },

    async stagedAt() {
      const seconds = await git(['log', '-1', '--format=%ct', stagingBranch])
      return Number.parseInt(seconds.trim(), 10) * 1000
    },

    async mergeReadiness() {
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      if (branch !== mainBranch) return 'not-on-main'
      const status = await git(['status', '--porcelain', '--', filesDir])
      if (status.trim() !== '') return 'files-dirty'
      return 'ready'
    },

    async mergeStaging() {
      await assertOwnRepo()
      try {
        await git(['merge', '--no-edit', stagingBranch], {
          env: {
            GIT_AUTHOR_NAME: COMMITTER.name,
            GIT_AUTHOR_EMAIL: COMMITTER.email,
            GIT_COMMITTER_NAME: COMMITTER.name,
            GIT_COMMITTER_EMAIL: COMMITTER.email,
          },
        })
      } catch {
        // Leave nothing mid-merge; a failed abort means there was no merge to
        // abort (e.g. the merge failed before starting), which is already clean.
        await git(['merge', '--abort']).catch(() => undefined)
        return 'conflict'
      }
      await git(['branch', '-D', stagingBranch])
      return 'merged'
    },

    async hasOrigin() {
      try {
        await git(['remote', 'get-url', ORIGIN])
        return true
      } catch {
        return false
      }
    },

    async fetchOrigin() {
      await git(['fetch', ORIGIN, mainBranch])
    },

    async aheadOfOrigin() {
      try {
        const out = await git([
          'rev-list',
          '--count',
          `${originMainRef}..refs/heads/${mainBranch}`,
        ])
        return Number.parseInt(out.trim(), 10)
      } catch {
        // No origin/main ref yet — nothing a past sweep could have left behind.
        return 0
      }
    },

    async behindOrigin() {
      try {
        const out = await git([
          'rev-list',
          '--count',
          `refs/heads/${mainBranch}..${originMainRef}`,
        ])
        return Number.parseInt(out.trim(), 10)
      } catch {
        // No origin/main ref yet — origin cannot have advanced past us.
        return 0
      }
    },

    async convergeWithOrigin() {
      await assertOwnRepo()
      const env = {
        GIT_AUTHOR_NAME: COMMITTER.name,
        GIT_AUTHOR_EMAIL: COMMITTER.email,
        GIT_COMMITTER_NAME: COMMITTER.name,
        GIT_COMMITTER_EMAIL: COMMITTER.email,
      }
      const message = `files sweep: converge ${mainBranch} with ${ORIGIN}/${mainBranch}`
      try {
        // Strictly behind fast-forwards; otherwise this is one content-level
        // three-way merge — never a replay of local history.
        await git(['merge', '--no-edit', '-m', message, originMainRef], { env })
        return 'converged'
      } catch {
        if (!(await unionResolveDocConflicts())) {
          // Leave nothing mid-merge; a failed abort means there was no merge to
          // abort (it failed before starting), which is already clean.
          await git(['merge', '--abort']).catch(() => undefined)
          return 'conflict'
        }
        try {
          await git(
            ['commit', '-m', `${message}\n\nConflicting documents unioned.`],
            { env },
          )
          /* v8 ignore next 4 -- committing a fully-resolved merge shouldn't fail;
             if it somehow does, leave nothing mid-merge and ask for a human. */
        } catch {
          await git(['merge', '--abort']).catch(() => undefined)
          return 'conflict'
        }
        return 'converged'
      }
    },

    async pushMain() {
      await assertOwnRepo()
      try {
        await git(['push', ORIGIN, mainBranch])
      } catch {
        return 'rejected'
      }
      return 'pushed'
    },
  }
}
