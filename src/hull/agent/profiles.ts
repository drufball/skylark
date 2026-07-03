import { uuidv7 } from '@earendil-works/pi-agent-core'
import { asc, eq, inArray } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import {
  assignDefaultAgentProfile,
  clearDanglingProfiles,
  getUserByHandle,
  setUserProfile,
} from '@hull/users/service'

import {
  agentProfiles,
  extensions,
  type AgentProfileRow,
  type ExtensionRow,
} from './schema'

/**
 * Pure persistence + seeding for agent profiles and the extensions registry —
 * the data that tells the runtime *how* to boot an agent. Database-agnostic
 * like every service (live Postgres or PGlite in tests); touches only the
 * agent's own two registry tables. The runtime (runtime.ts) resolves a profile
 * row into pi.dev session options; this file owns the rows.
 */

/** The fields a profile is created/updated with (id and createdAt are managed). */
export interface ProfileInput {
  name: string
  systemPrompt: string | null
  /** Allowlist of tool names; null = the default coding tools. */
  tools: string[] | null
  readContextFiles: boolean
  useRepoSkills: boolean
  extensionIds: string[]
  model: string | null
}

/**
 * Normalize an untrusted profile input to its stored shape: trim the name, and
 * fold blank text / empty allowlists to null. The one home for these rules, so
 * the web door (which re-validates client input) and any other caller agree —
 * and a new `ProfileInput` field flows through without a second edit site.
 */
export function normalizeProfileInput(input: ProfileInput): ProfileInput {
  return {
    name: input.name.trim(),
    systemPrompt: input.systemPrompt?.trim() ? input.systemPrompt : null,
    tools: input.tools && input.tools.length > 0 ? input.tools : null,
    readContextFiles: input.readContextFiles,
    useRepoSkills: input.useRepoSkills,
    extensionIds: input.extensionIds,
    model: input.model?.trim() ? input.model : null,
  }
}

export async function createProfile(
  db: Database,
  input: ProfileInput & { id: string },
): Promise<AgentProfileRow> {
  const [row] = await db.insert(agentProfiles).values(input).returning()
  return row
}

export async function getProfileByName(
  db: Database,
  name: string,
): Promise<AgentProfileRow | undefined> {
  const [row] = await db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.name, name))
  return row
}

export async function getProfileById(
  db: Database,
  id: string,
): Promise<AgentProfileRow | undefined> {
  const [row] = await db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.id, id))
  return row
}

/** Every profile, oldest first (UUIDv7 ids are time-ordered). */
export async function listProfiles(db: Database): Promise<AgentProfileRow[]> {
  return db.select().from(agentProfiles).orderBy(asc(agentProfiles.id))
}

/**
 * Create a profile or update the existing one with the same name. Idempotent by
 * name, so seeding and re-seeding converge on the declared shape while keeping
 * a profile's id (and therefore any session/user pointing at it) stable.
 * One atomic upsert (not get-then-insert), so two processes seeding at once —
 * a server boot racing a CLI seed — converge instead of one of them throwing.
 */
export async function upsertProfile(
  db: Database,
  input: ProfileInput,
): Promise<AgentProfileRow> {
  // On conflict, set the whole input (name included — it's the same value we
  // matched on), so a field added to ProfileInput converges on re-seed without
  // a second edit here. id/createdAt aren't in the set, so the existing row
  // keeps them — and everything pointing at the profile's id stays valid.
  const [row] = await db
    .insert(agentProfiles)
    .values({ id: uuidv7(), ...input })
    .onConflictDoUpdate({ target: agentProfiles.name, set: { ...input } })
    .returning()
  return row
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

/** The extensions matching these ids — unordered; for ordered paths use resolveProfileExtensionPaths. */
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
 * profiles keep pointing at it), updating path and description. One atomic
 * upsert (not get-then-insert), so two processes seeding at once — a server
 * boot racing a CLI seed — converge instead of one of them throwing.
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
 * Resolve a profile's extensionIds to their repo-relative module paths, in the
 * order asked for (so load order is the profile's order). Throws if any id is
 * unknown — a profile referencing a missing extension is a config error we want
 * loud, not silently dropped.
 */
export async function resolveProfileExtensionPaths(
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

// --- The standard profiles + extensions every ship is seeded with ---

/** The build-gates extension: mirrors the human's commit/landing/session hooks. */
export const BUILD_GATES_EXTENSION: ExtensionInput = {
  name: 'build-gates',
  description:
    "Mirrors the ship's Claude Code hooks for builder agents: run `npm run check` before a commit, discourage unpushed work at session end, and `./scripts/setup` on session start.",
  path: 'src/hull/agent/extensions/build-gates/index.ts',
}

/** Definition of the two seeded profiles, minus the resolved extension ids. */
type SeedProfile = Omit<ProfileInput, 'extensionIds'>

/**
 * The front-door chat pilot. Read-only tools (read + bash), no CLAUDE.md, no
 * repo skills, no extensions. It operates the ship's services but never builds
 * — to change something it files an issue (the intended end state).
 */
export const CHAT_PROFILE: SeedProfile = {
  name: 'chat',
  systemPrompt:
    "You pilot a Skylark ship: read code and run commands to operate its services, but you never modify the ship. To build or change something, file an issue. Don't read CLAUDE.md.",
  tools: ['read', 'bash'],
  readContextFiles: false,
  useRepoSkills: false,
  model: null,
}

/**
 * The builder. Default coding tools, reads CLAUDE.md, loads repo skills, and
 * runs the build-gates extension. Used by M3's building agents; seeded now.
 */
export const BUILDER_PROFILE: SeedProfile = {
  name: 'builder',
  systemPrompt:
    'You build a Skylark ship. Follow the ship-feature skill through OPENING ' +
    'the PR: red-green TDD, npm run check clean, branch, push, open a PR. ' +
    'Shepherding CI and merging is NOT your job — once the PR is open, hand ' +
    'the baton to @babysitter through the issue CLI as your last action and ' +
    'stop. When the babysitter hands a fix brief back to you, fix, push, and ' +
    'hand the baton back. ' +
    'To wait on any long local task, call the `background` tool with the ' +
    'command and END YOUR TURN — never block, poll, or `--watch` in the ' +
    'foreground; you are resumed automatically with the result.',
  tools: null,
  readContextFiles: true,
  useRepoSkills: true,
  model: null,
}

/**
 * Seed the standard extensions and profiles, idempotently. Registers
 * build-gates, then upserts the chat and builder profiles — wiring builder's
 * extensionIds to the just-registered build-gates row. Safe to run any number
 * of times; converges on the declared shape while keeping ids stable.
 *
 * Boot ENSURES, seed CONVERGES: with `convergeAll: false` (the every-boot
 * path) an existing profile is left exactly as the crew edited it and only
 * missing ones are created; the explicit CLI seed (the default) rewrites the
 * standard profiles back to their declared shape. Extensions always converge
 * — their path/description are code-owned and move with the repo.
 */
export async function seedProfiles(
  db: Database,
  opts: { convergeAll?: boolean } = {},
): Promise<void> {
  const converge = opts.convergeAll ?? true
  const buildGates = await registerExtension(db, BUILD_GATES_EXTENSION)
  const standard: ProfileInput[] = [
    { ...CHAT_PROFILE, extensionIds: [] },
    { ...BUILDER_PROFILE, extensionIds: [buildGates.id] },
    { ...GENERAL_PROFILE, extensionIds: [] },
    { ...BABYSITTER_PROFILE, extensionIds: [] },
  ]
  for (const profile of standard) {
    if (!converge && (await getProfileByName(db, profile.name))) continue
    await upsertProfile(db, profile)
  }
}

/**
 * The general deckhand — the `general` playbook's entrypoint. Full coding
 * tools and ship context, but no build contract and no gates: the issue's own
 * words are the instructions. Distinct from `chat` (read-only pilot) and
 * `builder` (the ship-feature loop).
 */
export const GENERAL_PROFILE: SeedProfile = {
  name: 'general',
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
export const BABYSITTER_PROFILE: SeedProfile = {
  name: 'babysitter',
  systemPrompt:
    'You babysit pull requests for a Skylark ship. You receive an issue whose ' +
    'PR is already open; you are in the issue worktree, on its branch — ' +
    '`gh pr view` and `gh pr checks` show your PR. ' +
    'To wait on CI or reviews, call the `background` tool with the watch ' +
    'command (e.g. `gh pr checks --watch --interval 30`) and END YOUR TURN — ' +
    'you are resumed with the result; never poll in the foreground. ' +
    'Read the review comments when checks settle — the ship’s automated ' +
    'reviews are advisory, not gates: weigh them, don’t obey them. When ' +
    'everything is green and the reviews are handled, confirm the PR is ' +
    'mergeable, merge it (squash, delete branch), and mark the issue done ' +
    'through the issue CLI as your LAST action, then stop. ' +
    'If CI fails or a review demands real code changes, hand the baton back ' +
    'to @builder with a precise brief of what to fix — you never write code ' +
    'yourself. After a second builder round-trip on the same PR, or any ' +
    'judgment call above your pay grade, hand off to OWNER instead.',
  tools: ['read', 'bash'],
  readContextFiles: false,
  useRepoSkills: false,
  model: null,
}

/**
 * Seed the standard profiles + extensions AND wire the crew to them: agents
 * (tilde/bix/dot) without a profile get pointed at `chat`. Idempotent end to
 * end. This is the single callable seam for "set up agent config" — the CLI
 * `seed` command is a thin door onto it, and M3's builders can call it directly
 * rather than shelling out. Crosses into the users service only by passing the
 * resolved chat-profile id; each service still writes only its own tables.
 */
export async function seedAndWireProfiles(
  db: Database,
  opts: { convergeAll?: boolean } = {},
): Promise<void> {
  await seedProfiles(db, opts)
  // Heal before wiring: a users.profileId pointing at a profile that no longer
  // exists (rebuilt table, hand-deleted row) becomes null here, so the default
  // assignment below re-points it instead of leaving a session-boot FK bomb.
  await clearDanglingProfiles(
    db,
    (await listProfiles(db)).map((p) => p.id),
  )
  const chat = await getProfileByName(db, CHAT_PROFILE.name)
  if (chat) await assignDefaultAgentProfile(db, chat.id)
  // Named crew whose whole point is a specific profile converge onto it — the
  // chat default is never right for them. A deliberate hand-assignment to any
  // OTHER profile survives; only null-or-chat is corrected. Playbook
  // entrypoints boot from users.profileId, so these two must be true.
  await wireCrewProfile(db, 'builder', BUILDER_PROFILE.name, chat?.id)
  await wireCrewProfile(db, 'hand', GENERAL_PROFILE.name, chat?.id)
  await wireCrewProfile(db, 'babysitter', BABYSITTER_PROFILE.name, chat?.id)
}

/** Point `handle` at `profileName` when its profile is unset or the chat default. */
async function wireCrewProfile(
  db: Database,
  handle: string,
  profileName: string,
  chatProfileId: string | undefined,
): Promise<void> {
  const user = await getUserByHandle(db, handle)
  const profile = await getProfileByName(db, profileName)
  if (!user || !profile) return
  if (!user.profileId || user.profileId === chatProfileId) {
    await setUserProfile(db, user.id, profile.id)
  }
}
