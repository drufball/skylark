import { spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
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
export type MergeReadiness =
  | 'not-on-main'
  | 'merge-in-progress'
  | 'index-dirty'
  | 'files-dirty'
  | 'ready'

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
  /**
   * May a merge run right now? Only on a clean, main-checked-out repo with no
   * other git operation open — the sweep's aborts don't ask whose merge it is,
   * so it stays out entirely while someone else's is in flight.
   */
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

/**
 * Run git in a repo, optionally feeding stdin; rejects with stderr on failure.
 *
 * Output is collected as BYTES and decoded once at the end. Decoding each chunk
 * as it arrives would replace any multibyte character that happens to straddle a
 * chunk boundary with U+FFFD — a dice roll per read, invisible until a document
 * grows past ~48KB. That matters more than it looks: `convergeWithOrigin` reads
 * a doc's conflict stages through here and writes the result back, so a garbled
 * read would be committed and pushed as real content.
 */
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
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolvePromise(Buffer.concat(stdout).toString('utf8'))
      else {
        reject(
          new Error(
            `git ${args[0]} failed: ${Buffer.concat(stderr).toString('utf8').trim()}`,
          ),
        )
      }
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

  /** A path the merge in progress could not settle, and every stage's file mode. */
  interface UnmergedEntry {
    path: string
    modes: string[]
  }

  /**
   * The unmerged entries of the merge in progress, read from the INDEX
   * (`ls-files -u`) rather than the working tree. That choice matters twice: the
   * records are NUL-separated, so a unicode or spaced filename arrives exactly as
   * git holds it; and each carries its file mode, which is the only way to tell a
   * document from a symlink or a submodule before writing to it. A directory/file
   * conflict also appears here under its real path, never as git's `~HEAD`
   * working-tree artifact — which the sweep must not commit as if it were a doc.
   */
  async function unmergedEntries(): Promise<UnmergedEntry[]> {
    const out = await git(['ls-files', '-u', '-z'])
      /* v8 ignore next -- ls-files has no failure mode here; treating one as
         "no conflicts I can settle" keeps the caller's abort path in charge. */
      .catch(() => '')
    // One record per STAGE, so a path shows up as many as three times: group
    // them, because a path's modes only make sense together.
    const byPath = new Map<string, string[]>()
    for (const record of out.split('\0')) {
      // `<mode> <sha> <stage>\t<path>` — no tab means no record (the trailing
      // empty string after the last separator lands here).
      const tab = record.indexOf('\t')
      if (tab === -1) continue
      const path = record.slice(tab + 1)
      const mode = record.slice(0, record.indexOf(' '))
      byPath.set(path, [...(byPath.get(path) ?? []), mode])
    }
    return [...byPath].map(([path, modes]) => ({ path, modes }))
  }

  /** Only plain files are documents — never a symlink, submodule, or directory. */
  function isPlainFile(entry: UnmergedEntry): boolean {
    return entry.modes.every((m) => m === '100644' || m === '100755')
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
   * Try to resolve the merge in progress under the union policy, returning the
   * documents it unioned so the merge commit can name them.
   *
   * Returns null — having changed nothing — when the conflict is not ours to
   * settle, and every one of those cases is a real hazard rather than a
   * hypothetical: a path outside the files dir (code, config: a human's call);
   * anything that isn't a plain file (writing "through" a conflicted symlink would
   * land outside the repo entirely); a binary document (union is a line rule); or
   * no unmerged entries at all, which means the merge never started — a staged
   * index or a dirty tree — and is emphatically NOT a document conflict. The
   * caller aborts on null.
   */
  async function unionResolveDocConflicts(): Promise<string[] | null> {
    const entries = await unmergedEntries()
    if (entries.length === 0) return null
    if (!entries.every((e) => insideFilesDir(e.path) && isPlainFile(e))) {
      return null
    }
    const sides = await Promise.all(
      entries.map(async ({ path }) => ({
        path,
        base: await conflictStage(1, path),
        ours: await conflictStage(2, path),
        theirs: await conflictStage(3, path),
      })),
    )
    if (sides.some((s) => [s.ours, s.theirs].some((v) => v?.includes('\0')))) {
      return null
    }
    const unioned: string[] = []
    for (const side of sides) {
      unioned.push(side.path)
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
      if (kept === null) return null
      // Modify/delete: keep the side that still has the document, by writing it
      // back — a sweep never destroys content it didn't author.
      await writeFile(resolve(repoRoot, side.path), kept)
      await git(['add', '--', side.path])
    }
    return unioned
  }

  /**
   * Is a multi-step git operation already in flight — a merge, rebase,
   * cherry-pick or revert someone (or something) else started?
   *
   * This matters because the sweep's own failure paths run `merge --abort`, and
   * an abort does not care whose merge it is. The serving checkout is somebody's
   * working copy: a crew member part way through resolving a merge by hand would
   * lose that work. So the sweep refuses to act at all while one is open, even
   * when the files dir itself looks clean. That state is undefined and wants a
   * human — the sweep just has to say so instead of bulldozing it.
   */
  async function operationInProgress(): Promise<boolean> {
    for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      const present = await git(['rev-parse', '--verify', '--quiet', ref]).then(
        () => true,
        () => false,
      )
      if (present) return true
    }
    for (const dir of ['rebase-merge', 'rebase-apply']) {
      const path = (await git(['rev-parse', '--git-path', dir])).trim()
      const present = await stat(resolve(repoRoot, path)).then(
        () => true,
        () => false,
      )
      if (present) return true
    }
    return false
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
      // Asked first, because a conflicted rebase detaches HEAD: checking the
      // branch first would report "not on main" and hide the real reason.
      if (await operationInProgress()) return 'merge-in-progress'
      const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      if (branch !== mainBranch) return 'not-on-main'
      // Anything staged, anywhere, stops git from starting a merge at all — and a
      // merge that never starts leaves no unmerged paths, which would otherwise
      // read as "a document conflict I can't settle" and raise a false alarm.
      // Someone ran `git add` and went to lunch; that's a wait, not a conflict.
      const indexClean = await git(['diff', '--cached', '--quiet']).then(
        () => true,
        () => false,
      )
      if (!indexClean) return 'index-dirty'
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
        // Everything from here on is wrapped, because a THROW must not escape
        // leaving the repo mid-merge with a half-resolved index — a full disk or
        // an unwritable path partway through would do exactly that, and no
        // later sweep could tell that state from a human's own open merge.
        try {
          const unioned = await unionResolveDocConflicts()
          if (unioned === null) throw new Error('not the sweep’s conflict')
          // Name the documents in the commit: the union policy is only safe if
          // the mess it makes is findable afterwards.
          await git(
            [
              'commit',
              '-m',
              `${message}\n\nUnioned conflicting documents (both sides kept):\n${unioned.map((p) => `- ${p}`).join('\n')}`,
            ],
            { env },
          )
        } catch {
          // Leave nothing mid-merge; a failed abort means there was no merge to
          // abort (it failed before starting), which is already clean.
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
