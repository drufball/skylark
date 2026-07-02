import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
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

export function createFilesRepo(config: FilesRepoConfig): FilesRepo {
  const { repoRoot, filesDir, mainBranch, stagingBranch } = config
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
  }
}
