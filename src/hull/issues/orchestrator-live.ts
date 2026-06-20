import { exec } from 'node:child_process'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { completeSimple } from '@earendil-works/pi-ai'
import { getModels } from '@earendil-works/pi-ai'

import { db } from '@hull/db/client'
import { shipLogBus, ensureShipLogListener } from '@hull/events/bus'
import { createAgentRuntime, createPiSession } from '@hull/agent/runtime'
import { getUserByHandle } from '@hull/users/service'
import { errorMessage } from '@hull/lib/errors'

import {
  createOrchestrator,
  parseWorktreeInclude,
  slugify,
  type GitOps,
  type Orchestrator,
} from './orchestrator'
import type { IssueRow } from './schema'

/* v8 ignore start -- live wiring: real git/exec/fs, the LLM slug call, and the
   ship-log subscription. The orchestrator's DECISIONS are unit-tested against
   fakes in orchestrator.test.ts; this file is the impure shell that connects
   them to the real world, exercised by the manual end-to-end builder run. */

const run = promisify(exec)

/** Where build worktrees live: ~/skylark/worktrees/<branch>/. */
export function worktreeRoot(): string {
  return join(homedir(), 'skylark', 'worktrees')
}

/**
 * The real git/filesystem operations. `git worktree add` does NOT copy
 * gitignored files, so after creating a worktree we copy the `.worktreeinclude`
 * set (currently `.env`) from the server's checkout — mirroring Claude Code's
 * worktree copy, so a fresh worktree shares the one local Postgres.
 */
export const nodeGitOps: GitOps = {
  async worktreeExists(path) {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
  async addWorktree(path, branch) {
    await mkdir(dirname(path), { recursive: true })
    await run(`git worktree add ${shq(path)} -b ${shq(branch)}`)
  },
  async removeWorktree(path) {
    await run(`git worktree remove --force ${shq(path)}`)
  },
  async copyWorktreeIncludes(from, to, patterns) {
    // We copy the literal paths we use (.env); glob patterns aren't expanded
    // here because the current .worktreeinclude is a single file. If patterns
    // grow to globs, expand them before copying.
    for (const pattern of patterns) {
      if (pattern.includes('*')) {
        console.warn(`worktree copy: skipping unsupported glob "${pattern}"`)
        continue
      }
      try {
        await copyFile(join(from, pattern), join(to, pattern))
      } catch (err) {
        console.warn(
          `worktree copy: ${pattern} not copied: ${errorMessage(err)}`,
        )
      }
    }
  },
  async pullMain() {
    await run('git pull --ff-only')
  },
  async runMigrations() {
    await run('npm run db:migrate')
  },
  async readWorktreeIncludes() {
    try {
      return parseWorktreeInclude(await readFile('.worktreeinclude', 'utf8'))
    } catch {
      return ['.env']
    }
  },
  async branchMerged(branch) {
    // `git merge-base --is-ancestor <branch> main` exits 0 when the branch's tip
    // is reachable from main — i.e. it's been merged. A non-zero exit (run
    // rejects) means it isn't, so a thrown error reads as "not merged".
    try {
      await run(`git merge-base --is-ancestor ${shq(branch)} main`)
      return true
    } catch {
      return false
    }
  },
}

/**
 * Generate a short, readable branch slug for an issue with a cheap LLM call.
 * Falls back to slugifying the title if the model is unavailable or errors —
 * the branch is always valid even with no network.
 */
export async function generateSlug(issue: IssueRow): Promise<string> {
  try {
    const model = getModels('anthropic').find(
      (m) => m.id === 'claude-haiku-4-5' || m.id === 'claude-3-5-haiku-latest',
    )
    if (!model) return slugify(issue.title)
    const result = await completeSimple(model, {
      systemPrompt:
        'You produce a short git branch slug (2-4 words, lowercase, hyphenated, ' +
        'no punctuation) for a software issue. Reply with ONLY the slug.',
      messages: [
        {
          role: 'user',
          content: `Title: ${issue.title}\n${issue.body}`.slice(0, 500),
          timestamp: Date.now(),
        },
      ],
    })
    const text = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join(' ')
    const slug = slugify(text)
    return slug === 'build' ? slugify(issue.title) : slug
  } catch (err) {
    console.warn(`slug LLM call failed, using title: ${errorMessage(err)}`)
    return slugify(issue.title)
  }
}

let started: Orchestrator | undefined

/**
 * Boot the orchestrator into the server process (idempotent): wire it to the
 * real runtime + git/fs + slug generator, subscribe it to the ship's log so
 * agent-initiated transitions from a separate CLI process are heard, and run
 * startup reconciliation for issues marooned in `building` by a restart.
 *
 * The builder agent identity is the `builder` crew user if present, else the
 * operator — so SKYLARK_ACTOR is always a real id the issue CLI can attribute.
 */
export async function ensureOrchestrator(): Promise<Orchestrator> {
  if (started) return started

  ensureShipLogListener()
  const builder =
    (await getUserByHandle(db, 'builder')) ??
    (await getUserByHandle(db, 'drufball'))
  const runtime = createAgentRuntime({ db, factory: createPiSession })

  const orch = createOrchestrator({
    db,
    git: nodeGitOps,
    runtime,
    builderUserId: builder?.id ?? '',
    worktreeRoot: worktreeRoot(),
    generateSlug,
  })

  shipLogBus.subscribe((note) => {
    void orch.handleBusNote(note).catch((err: unknown) => {
      console.error(`orchestrator bus handler failed: ${errorMessage(err)}`)
    })
  })

  started = orch
  await orch.reconcile().catch((err: unknown) => {
    console.error(`orchestrator reconcile failed: ${errorMessage(err)}`)
  })
  return orch
}

/** Quote a shell argument (paths/branches) safely for exec. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
/* v8 ignore stop */
