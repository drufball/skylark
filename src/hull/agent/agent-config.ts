import { uuidv7 } from '@earendil-works/pi-agent-core'
import { asc, eq, inArray } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import type { UserRow } from '@hull/users/schema'
import {
  createUser,
  getUserByHandle,
  listUsers,
  updateAgentUser,
} from '@hull/users/service'

import { extensions, type ExtensionRow } from './schema'

/**
 * Agent config + the extensions registry — the data that tells the runtime
 * *how* to boot an agent. Config lives directly on the agent's users row (no
 * profile indirection: a crew this size doesn't need reusable templates);
 * this file owns the seed constants, the seeding that writes them onto the
 * crew, and the extensions registry table. Database-agnostic like every
 * service (live Postgres or PGlite in tests). The runtime (runtime.ts)
 * resolves a user row into pi.dev session options.
 */

/** The config fields an agent user row stores (extension *ids*, unresolved). */
export interface AgentConfigInput {
  systemPrompt: string | null
  /** Allowlist of tool names; null = the default coding tools. */
  tools: string[] | null
  readContextFiles: boolean
  useRepoSkills: boolean
  extensionIds: string[]
  model: string | null
}

/**
 * Has this agent's config ever been written — by a seed, a migration, or the
 * captain? False only when every config column still sits at its schema
 * default (the shape a bare `createUser` leaves). This is what lets the seed
 * converge a fresh crew member without ever clobbering a customized one.
 */
export function hasAgentConfig(user: UserRow): boolean {
  return (
    user.systemPrompt !== null ||
    user.tools !== null ||
    !user.readContextFiles ||
    !user.useRepoSkills ||
    user.extensionIds.length > 0 ||
    user.model !== null
  )
}

/** The fields an extension is registered with (id and createdAt are managed). */
export interface ExtensionInput {
  name: string
  description: string
  path: string
}

export async function createExtension(
  db: Database,
  input: ExtensionInput & { id: string },
): Promise<ExtensionRow> {
  const [row] = await db.insert(extensions).values(input).returning()
  return row
}

export async function getExtensionByName(
  db: Database,
  name: string,
): Promise<ExtensionRow | undefined> {
  const [row] = await db
    .select()
    .from(extensions)
    .where(eq(extensions.name, name))
  return row
}

/** The extensions matching these ids — unordered; for ordered paths use resolveExtensionPaths. */
export async function getExtensionsByIds(
  db: Database,
  ids: string[],
): Promise<ExtensionRow[]> {
  if (ids.length === 0) return []
  return db.select().from(extensions).where(inArray(extensions.id, ids))
}

/** Every extension, oldest first. */
export async function listExtensions(db: Database): Promise<ExtensionRow[]> {
  return db.select().from(extensions).orderBy(asc(extensions.id))
}

/**
 * Register an extension or update the existing one with the same name.
 * Idempotent by name (code moves; the registry row's id stays stable so
 * agent configs keep pointing at it), updating path and description. One
 * atomic upsert (not get-then-insert), so two processes seeding at once — a
 * server boot racing a CLI seed — converge instead of one of them throwing.
 */
export async function registerExtension(
  db: Database,
  input: ExtensionInput,
): Promise<ExtensionRow> {
  const [row] = await db
    .insert(extensions)
    .values({ id: uuidv7(), ...input })
    .onConflictDoUpdate({
      target: extensions.name,
      set: { description: input.description, path: input.path },
    })
    .returning()
  return row
}

/**
 * Resolve an agent's extensionIds to their repo-relative module paths, in the
 * order asked for (so load order is the config's order). Throws if any id is
 * unknown — a config referencing a missing extension is an error we want
 * loud, not silently dropped.
 */
export async function resolveExtensionPaths(
  db: Database,
  extensionIds: string[],
): Promise<string[]> {
  if (extensionIds.length === 0) return []
  const rows = await getExtensionsByIds(db, extensionIds)
  const byId = new Map(rows.map((r) => [r.id, r]))
  return extensionIds.map((id) => {
    const row = byId.get(id)
    if (!row) throw new Error(`Unknown extension id: ${id}`)
    return row.path
  })
}

// --- The standard agent configs + extensions every ship is seeded with ------

/** The build-gates extension: mirrors the human's commit/landing/session hooks. */
export const BUILD_GATES_EXTENSION: ExtensionInput = {
  name: 'build-gates',
  description:
    "Mirrors the ship's Claude Code hooks for builder agents: run `npm run check` before a commit, discourage unpushed work at session end, and `./scripts/setup` on session start.",
  path: 'src/hull/agent/extensions/build-gates/index.ts',
}

/** A seed config, minus the resolved extension ids (wired at seed time). */
type SeedConfig = Omit<AgentConfigInput, 'extensionIds'>

/**
 * The chat pilot — the default for conversational agents (tilde, bix, dot,
 * and any new named agent). Read-only tools (read + bash), no CLAUDE.md, no
 * repo skills, no extensions. It operates the ship's services but never
 * builds — to change something it files an issue (the intended end state).
 */
export const CHAT_CONFIG: SeedConfig = {
  systemPrompt:
    "You pilot a Skylark ship: read code and run commands to operate its services, but you never modify the ship. To build or change something, file an issue. Don't read CLAUDE.md.",
  tools: ['read', 'bash'],
  readContextFiles: false,
  useRepoSkills: false,
  model: null,
}

/**
 * The builder. Default coding tools, reads CLAUDE.md, loads repo skills, and
 * runs the build-gates extension. The `build` playbook's entrypoint.
 */
export const BUILDER_CONFIG: SeedConfig = {
  systemPrompt:
    'You build a Skylark ship. Follow the build-feature skill through OPENING ' +
    'the PR: red-green TDD, npm run check clean, branch, push, open a PR. ' +
    'Shepherding CI and merging is NOT your job — once the PR is open, hand ' +
    'the baton to @babysitter through the issue CLI as your last action and ' +
    'stop; do not run the babysit-pr skill yourself. When the babysitter ' +
    'hands a fix brief back to you, fix, push, and hand the baton back. ' +
    'To wait on any long local task, call the `background` tool with the ' +
    'command and END YOUR TURN — never block, poll, or `--watch` in the ' +
    'foreground; you are resumed automatically with the result.',
  tools: null,
  readContextFiles: true,
  useRepoSkills: true,
  model: null,
}

/**
 * The general deckhand — the `general` playbook's entrypoint. Full coding
 * tools and ship context, but no build contract and no gates: the issue's own
 * words are the instructions. Distinct from the chat pilot (read-only) and
 * the builder (the build-feature loop).
 */
export const GENERAL_CONFIG: SeedConfig = {
  systemPrompt:
    'You are a general-purpose agent aboard a Skylark ship. Do the work the ' +
    'issue describes — research, writing, operating the ship’s services, or ' +
    'code — and report back through the issue thread as instructed.',
  tools: null,
  readContextFiles: true,
  useRepoSkills: true,
  model: null,
}

/**
 * The PR babysitter — the build playbook's second hand. Takes the baton once
 * a PR is open, waits on CI without burning a turn (the `background` tool),
 * and closes the loop: merge and mark the issue done, or hand the baton back
 * to the builder with a precise fix brief. Read+bash only — it operates `gh`
 * and the issue CLI; it never writes code (fixes are the builder's job).
 */
export const BABYSITTER_CONFIG: SeedConfig = {
  systemPrompt:
    'You babysit pull requests for a Skylark ship. Follow the babysit-pr ' +
    'skill to shepherd an open PR to a merge. You receive an issue whose PR ' +
    'is already open; you are in the issue worktree, on its branch. ' +
    'To wait on CI or reviews, call the `background` tool with the watch ' +
    'command and END YOUR TURN — you are resumed with the result; never ' +
    'poll in the foreground. ' +
    'Once merged, mark the issue done through the issue CLI as your LAST ' +
    'action and stop. ' +
    'If a fix needs real code changes, hand the baton back to @builder ' +
    'with a precise brief of what to fix — you never write code yourself. ' +
    'If merging is blocked for a reason outside that loop (branch protection, ' +
    'a required review), or after a second builder round-trip on the same PR, ' +
    'hand off to OWNER instead.',
  tools: ['read', 'bash'],
  readContextFiles: false,
  useRepoSkills: true,
  model: null,
}

/** The role crew and the config each one boots with. */
const ROLE_SEEDS: readonly {
  handle: string
  displayName: string
  config: SeedConfig
  /** Wire the build-gates extension onto this agent at seed time. */
  buildGates?: true
}[] = [
  {
    handle: 'builder',
    displayName: 'Builder',
    config: BUILDER_CONFIG,
    buildGates: true,
  },
  { handle: 'hand', displayName: 'Hand', config: GENERAL_CONFIG },
  {
    handle: 'babysitter',
    displayName: 'Babysitter',
    config: BABYSITTER_CONFIG,
  },
]

/**
 * Seed the standard agent config, idempotently: register the build-gates
 * extension, write the role configs onto the `builder`/`hand`/`babysitter`
 * crew users (creating any that are missing — the same rows `seedCrew`
 * ensures), and give every other agent the chat-pilot config. Safe to run any
 * number of times, from any process (server boot, CLI seed).
 *
 * Seed CONVERGES fresh agents but never clobbers the captain's work: config
 * is written only onto agents whose config columns have never been touched
 * (`hasAgentConfig` false). Once anything — a seed, the migration off
 * profiles, or a hand edit in the Crew editor — has written config, the row
 * is the captain's and re-seeding leaves it alone. Extensions always converge
 * — their path/description are code-owned and move with the repo.
 */
export async function seedAgentConfig(db: Database): Promise<void> {
  const buildGates = await registerExtension(db, BUILD_GATES_EXTENSION)
  for (const role of ROLE_SEEDS) {
    const user =
      (await getUserByHandle(db, role.handle)) ??
      (await createUser(db, {
        id: uuidv7(),
        handle: role.handle,
        displayName: role.displayName,
        type: 'agent',
      }))
    if (hasAgentConfig(user)) continue
    await updateAgentUser(db, user.id, {
      ...role.config,
      extensionIds: role.buildGates ? [buildGates.id] : [],
    })
  }
  // Every other agent whose config was never written becomes a chat pilot —
  // the safe default for a crew member that talks (read-only, files issues).
  const roleHandles = new Set(ROLE_SEEDS.map((r) => r.handle))
  for (const user of await listUsers(db)) {
    if (user.type !== 'agent' || roleHandles.has(user.handle)) continue
    if (hasAgentConfig(user)) continue
    await updateAgentUser(db, user.id, { ...CHAT_CONFIG, extensionIds: [] })
  }
}
