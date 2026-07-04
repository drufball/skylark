import { exec } from 'node:child_process'
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { completeSimple } from '@earendil-works/pi-ai'

import { systemDb } from '@hull/db/client'
import { subscribeToShipLog } from '@hull/events/bus'
import { findHostedModel } from '@hull/agent/models'
import { createServerRuntime } from '@hull/agent/fake-session'
import { FAKE_RUNTIME_ENV } from '@hull/lib/env'
import { seedAndWireProfiles } from '@hull/agent/profiles'
import { operatorHandle, operatorSeed } from '@hull/users/actor'
import { getUserByHandle, seedCrew } from '@hull/users/service'
import { errorMessage } from '@hull/lib/errors'

import {
  createOrchestrator,
  parseWorktreeInclude,
  slugFromCompletion,
  type GitOps,
  type Orchestrator,
} from './orchestrator'
import { seedPlaybooks } from './playbooks'
import { shq } from './shell'
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
    // A regular / fast-forward merge leaves the branch tip reachable from main,
    // so `git merge-base --is-ancestor` exits 0.
    const ancestor = await run(
      `git merge-base --is-ancestor ${shq(branch)} main`,
    )
      .then(() => true)
      .catch(() => false)
    if (ancestor) return true
    // A SQUASH merge (how PRs land here, via `gh pr merge --squash`) makes a NEW
    // commit on main, so the branch tip is NOT an ancestor — the ancestor check
    // alone would wrongly say "not merged" and the done-handler would orphan the
    // worktree. Ask GitHub, the source of truth for the merge: does this branch
    // have a merged PR? Empty/zero, or a gh failure, reads as "not merged".
    return run(
      `gh pr list --head ${shq(branch)} --state merged --json number --jq 'length'`,
    )
      .then(({ stdout }) => {
        const n = stdout.trim()
        return n !== '' && n !== '0'
      })
      .catch(() => false)
  },
}

/**
 * Generate a short, readable branch slug for an issue with a cheap LLM call.
 * The decision (text-block extraction, the SLUG_FALLBACK rejection, the
 * error/no-model fallback to the title) is the unit-tested slugFromCompletion;
 * this edge only decides whether a model call is available at all.
 */
export async function generateSlug(issue: IssueRow): Promise<string> {
  // Hermetic under the fake-runtime flag: skip the LLM entirely so a build-path
  // smoke test never reaches the network. This is the issues orchestrator's
  // SECOND model entry point (the runtime factory is the other); the flag means
  // "no model call, anywhere", not just "no coding-agent session".
  const model = process.env[FAKE_RUNTIME_ENV]
    ? undefined
    : findHostedModel('anthropic', [
        'claude-haiku-4-5',
        'claude-3-5-haiku-latest',
      ])
  return slugFromCompletion(
    issue.title,
    model &&
      (async () =>
        (
          await completeSimple(model, {
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
        ).content),
  )
}

let started: Promise<Orchestrator> | undefined
let unsubscribe: (() => void) | undefined

/**
 * globalThis-based arm-once registry (defense in depth, survives module
 * re-execution). The boot module's registry prevents redundant boot calls;
 * this ensures the reactor itself is protected even if called directly.
 * Stores the LIVE PROMISE so module re-execution returns the same functioning
 * orchestrator, not a rejection (#2wkv).
 */
interface GlobalWithIssuesOrchestrator {
  __SKYLARK_ISSUES_ORCHESTRATOR__?: {
    armed: boolean
    instance?: Promise<Orchestrator>
  }
}

function getRegistry(): {
  armed: boolean
  instance?: Promise<Orchestrator>
} {
  const g = globalThis as GlobalWithIssuesOrchestrator
  g.__SKYLARK_ISSUES_ORCHESTRATOR__ ??= { armed: false }
  return g.__SKYLARK_ISSUES_ORCHESTRATOR__
}

/**
 * Boot the orchestrator into the server process (idempotent): wire it to the
 * real runtime + git/fs + slug generator, subscribe it to the ship's log so
 * agent-initiated transitions from a separate CLI process are heard, and run
 * startup reconciliation for issues marooned in `building` by a restart.
 *
 * The IN-FLIGHT promise is what's memoized, not the finished orchestrator: a
 * burst of concurrent server-fn calls on a fresh boot would otherwise each get
 * past a plain `if (started)` while the first boot is still awaiting its
 * seeding, and run several boots — duplicate seeding, and worse, multiple
 * orchestrators subscribed to the ship's log. A failed boot un-memoizes so the
 * next call retries rather than caching the rejection forever.
 *
 * The builder agent identity is the `builder` crew user if present, else the
 * operator — so SKYLARK_ACTOR is always a real id the issue CLI can attribute.
 *
 * Arm-once: uses globalThis registry that survives module re-execution (SSR
 * reload resets module state but globalThis persists), so subscriptions never
 * stack even without import.meta.hot.dispose cooperation (#lo0x).
 */
export function ensureOrchestrator(): Promise<Orchestrator> {
  const registry = getRegistry()
  // Check registry FIRST: if we restore from registry and that promise later
  // rejects, the module-level 'started' would cache the rejection forever
  // because the catch handler isn't attached to restored promises.
  if (registry.armed && registry.instance) {
    // Reactor armed in a previous module execution but module state lost:
    // restore the live promise from the registry so callers get the SAME
    // functioning orchestrator, not a rejection.
    started = registry.instance
    return registry.instance
  }
  if (started) return started
  registry.armed = true
  started = boot().catch((err: unknown) => {
    registry.armed = false // allow retry on failure
    started = undefined
    delete registry.instance
    throw err
  })
  registry.instance = started
  return started
}

async function boot(): Promise<Orchestrator> {
  // On HMR reload, module state resets but the InProcessBus subscription
  // persists (it's in a different module). Clean up the old one first.
  unsubscribe?.()
  unsubscribe = undefined

  // ENSURE the config the orchestrator runs on — crew, profiles, playbooks —
  // every boot, idempotently. hoist seeds the crew too, but the server must
  // not depend on how it was launched: entrypoint resolution reads
  // users.profileId and the playbooks table, so both must exist before the
  // first → building. Ensure, don't converge: a boot only creates what's
  // missing, so edits made in the Profiles/Playbooks editors survive a
  // restart (the explicit `npm run agent seed` is the converge-back door).
  // Best-effort: a seed hiccup mustn't hold the ship.
  try {
    await seedCrew(systemDb, operatorSeed())
    await seedAndWireProfiles(systemDb, { convergeAll: false })
    await seedPlaybooks(systemDb)
  } catch (err) {
    console.error(`orchestrator boot seeding failed: ${errorMessage(err)}`)
  }

  // systemDb (superuser): the orchestrator is fixed plumbing — reconcile scans
  // for marooned builds and it drives the builder runtime, which under app_user
  // with no actor would fail closed. It reacts to events, not requests.
  const builder =
    (await getUserByHandle(systemDb, 'builder')) ??
    (await getUserByHandle(systemDb, operatorHandle()))
  const runtime = createServerRuntime(systemDb)

  const orch = createOrchestrator({
    db: systemDb,
    git: nodeGitOps,
    runtime,
    builderUserId: builder?.id ?? '',
    worktreeRoot: worktreeRoot(),
    generateSlug,
  })

  unsubscribe = subscribeToShipLog(orch, 'issues orchestrator')
  return orch
}
/* v8 ignore stop */
