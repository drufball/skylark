import { uuidv7 } from '@earendil-works/pi-agent-core'
import { eq } from 'drizzle-orm'

import type { Database } from '@hull/db/client'
import { getUserByHandle, getUserById } from '@hull/users/service'

import { playbooks, type IssueRow, type PlaybookRow } from './schema'

/**
 * Playbooks: issue-handling strategies as data. A playbook is a roster of
 * agent crew members plus an entrypoint — WHO works an issue, not HOW. The
 * how (each agent's role, when it hands off, to whom) lives in the agents'
 * own profiles and prompts; the playbook is the guardrail (`handoff` refuses
 * targets outside the roster) and the starting gun (→ building seeds the
 * entrypoint's session).
 *
 * An issue with no playbook means the default `build` playbook, so every
 * pre-playbooks issue keeps its meaning and a bare `issue new` still builds.
 */

/** The default playbook: what a bare `issue new` means. */
export const BUILD_PLAYBOOK_NAME = 'build'

export interface PlaybookInput {
  name: string
  description?: string
  /** Agent crew members (→ users.id) allowed hands on the issue. */
  memberIds: string[]
  /** The member whose session a → building seeds. Must be in memberIds. */
  entrypointId: string
}

/**
 * Validate a playbook's roster: at least one member, every member a real crew
 * AGENT (a playbook of humans is a meeting, not a strategy), entrypoint on the
 * roster. Throws with a message meant for whoever typed the form/command.
 */
async function validateRoster(db: Database, input: PlaybookInput) {
  if (input.memberIds.length === 0) {
    throw new Error('A playbook needs at least one member agent.')
  }
  for (const id of input.memberIds) {
    const user = await getUserById(db, id)
    if (!user) throw new Error(`No such crew member: ${id}`)
    if (user.type !== 'agent') {
      throw new Error(
        `@${user.handle} is human — playbook members must be agents.`,
      )
    }
  }
  if (!input.memberIds.includes(input.entrypointId)) {
    throw new Error('The entrypoint must be one of the playbook members.')
  }
}

/**
 * Create or update a playbook by name, converging on the given shape while
 * keeping the id stable (issues reference playbooks by id, so an edit must
 * never orphan them).
 */
export async function upsertPlaybook(
  db: Database,
  input: PlaybookInput,
): Promise<PlaybookRow> {
  await validateRoster(db, input)
  const existing = await getPlaybookByName(db, input.name)
  const values = {
    name: input.name,
    description: input.description ?? '',
    memberIds: input.memberIds,
    entrypointId: input.entrypointId,
  }
  if (existing) {
    const [row] = await db
      .update(playbooks)
      .set(values)
      .where(eq(playbooks.id, existing.id))
      .returning()
    return row
  }
  const [row] = await db
    .insert(playbooks)
    .values({ id: uuidv7(), ...values })
    .returning()
  return row
}

export async function getPlaybook(
  db: Database,
  id: string,
): Promise<PlaybookRow | undefined> {
  const [row] = await db.select().from(playbooks).where(eq(playbooks.id, id))
  return row
}

export async function getPlaybookByName(
  db: Database,
  name: string,
): Promise<PlaybookRow | undefined> {
  const [row] = await db
    .select()
    .from(playbooks)
    .where(eq(playbooks.name, name))
  return row
}

/** Every playbook, oldest first (UUIDv7 ids are time-ordered). */
export async function listPlaybooks(db: Database): Promise<PlaybookRow[]> {
  return db.select().from(playbooks).orderBy(playbooks.id)
}

/**
 * The playbook an issue runs under: its own if set, else the `build` default.
 * Undefined only on a ship where nothing is seeded — callers (orchestrator,
 * handoff) fall back to the legacy builder path then.
 */
export async function playbookFor(
  db: Database,
  issue: IssueRow,
): Promise<PlaybookRow | undefined> {
  if (issue.playbookId) return getPlaybook(db, issue.playbookId)
  return getPlaybookByName(db, BUILD_PLAYBOOK_NAME)
}

/**
 * Seed the standard playbooks, idempotently: `build` (the builder, as ever)
 * and `general` (the hand — full tools, no build contract, does what the
 * issue says). A playbook whose crew member isn't aboard yet is skipped, not
 * fatal — seedCrew (users) and seedAndWireProfiles (agent) run first in every
 * boot path, so this is a fresh-database corner, not a live one.
 */
export async function seedPlaybooks(db: Database): Promise<void> {
  const builder = await getUserByHandle(db, 'builder')
  if (builder) {
    await upsertPlaybook(db, {
      name: BUILD_PLAYBOOK_NAME,
      description:
        'Implement it: red-green TDD in a worktree, through CI to a merged PR.',
      memberIds: [builder.id],
      entrypointId: builder.id,
    })
  }
  const hand = await getUserByHandle(db, 'hand')
  if (hand) {
    await upsertPlaybook(db, {
      name: 'general',
      description:
        'One agent, full tools, no script — does whatever the issue says.',
      memberIds: [hand.id],
      entrypointId: hand.id,
    })
  }
}
