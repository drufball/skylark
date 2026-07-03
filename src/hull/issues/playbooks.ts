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
  if (new Set(input.memberIds).size !== input.memberIds.length) {
    throw new Error('A playbook roster lists each agent once.')
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
 * Seed the standard playbooks: `build` (builder implements to an open PR,
 * babysitter shepherds it home) and `general` (the hand — full tools, no
 * build contract, does what the issue says). A playbook whose crew isn't
 * aboard yet is skipped, not fatal — seedCrew (users) and the profile seeding
 * (agent) run first in every boot path, so this is a fresh-database corner,
 * not a live one.
 *
 * Boot ENSURES, seed CONVERGES: the every-boot path (`convergeAll: false`)
 * creates missing playbooks and — the one exception to hands-off — APPENDS
 * newly-standard members to an existing standard playbook's roster. The
 * factory flow needs its own agents (a builder that hands to a babysitter
 * the roster refuses is a broken flow), while everything else about the row
 * (description, extra members, entrypoint) stays exactly as the crew edited
 * it. The explicit CLI seed (`convergeAll: true`) rewrites the standard rows
 * back to their declared shape.
 */
export async function seedPlaybooks(
  db: Database,
  opts: { convergeAll?: boolean } = {},
): Promise<void> {
  const standard: {
    memberHandles: string[]
    entryHandle: string
    playbook: Omit<PlaybookInput, 'memberIds' | 'entrypointId'>
  }[] = [
    {
      memberHandles: ['builder', 'babysitter'],
      entryHandle: 'builder',
      playbook: {
        name: BUILD_PLAYBOOK_NAME,
        description:
          'Implement it: the builder takes it to an open PR, the babysitter shepherds CI to a merge.',
      },
    },
    {
      memberHandles: ['hand'],
      entryHandle: 'hand',
      playbook: {
        name: 'general',
        description:
          'One agent, full tools, no script — does whatever the issue says.',
      },
    },
  ]
  for (const { memberHandles, entryHandle, playbook } of standard) {
    const members = (
      await Promise.all(memberHandles.map((h) => getUserByHandle(db, h)))
    ).flatMap((u) => (u ? [u] : []))
    const entry = members.find((m) => m.handle === entryHandle)
    if (members.length < memberHandles.length || !entry) continue

    const existing = await getPlaybookByName(db, playbook.name)
    if (existing && !opts.convergeAll) {
      // Leave the captain's edits alone — but the factory roster must be
      // whole, so append any standard member the row predates.
      const missing = members
        .map((m) => m.id)
        .filter((id) => !existing.memberIds.includes(id))
      if (missing.length > 0) {
        await upsertPlaybook(db, {
          name: existing.name,
          description: existing.description,
          memberIds: [...existing.memberIds, ...missing],
          entrypointId: existing.entrypointId,
        })
      }
      continue
    }
    await upsertPlaybook(db, {
      ...playbook,
      memberIds: members.map((m) => m.id),
      entrypointId: entry.id,
    })
  }
}
