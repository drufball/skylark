import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { listEventsSince } from '@hull/events/service'
import { createUser } from '@hull/users/service'
import type { UserRow } from '@hull/users/schema'

import { ISSUE_HANDOFF, ISSUE_OWNER_PING, requestHandoff } from './handoff'
import { createIssue, transitionIssue, setBuildContext } from './service'
import type { IssueRow } from './schema'

let db: Database
let close: () => Promise<void>
let dru: UserRow
let builder: UserRow
let babysitter: UserRow

beforeEach(async () => {
  ;({ db, close } = await freshDb())
  dru = await createUser(db, {
    id: uuidv7(),
    handle: 'drufball',
    displayName: 'Dru',
    type: 'human',
  })
  builder = await createUser(db, {
    id: uuidv7(),
    handle: 'builder',
    displayName: 'Builder',
    type: 'agent',
  })
  babysitter = await createUser(db, {
    id: uuidv7(),
    handle: 'babysitter',
    displayName: 'Babysitter',
    type: 'agent',
  })
})

afterEach(async () => {
  await close()
})

async function buildingIssue(
  over: { ownerId?: string } = {},
): Promise<IssueRow> {
  const issue = await createIssue(db, {
    title: 'Fix the mast',
    authorId: dru.id,
    ownerId: over.ownerId,
  })
  await transitionIssue(db, {
    issueId: issue.id,
    to: 'building',
    actorId: dru.id,
  })
  await setBuildContext(db, issue.id, {
    branchName: `fix-the-mast-${issue.nano}`,
    worktreePath: `/wt/fix-the-mast-${issue.nano}`,
  })
  return issue
}

describe('handoff event type split', () => {
  it('emits issue.handoff (no toOwner field) for baton-pass between agents', async () => {
    const issue = await buildingIssue()
    await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builder.id,
      target: 'babysitter',
      message: 'PR #12 is open, take it home',
    })

    const events = await listEventsSince(db, {
      topicPatterns: [`issue:${issue.id}`],
      audience: 'public',
    })
    const handoffs = events.filter((e) => e.type === ISSUE_HANDOFF)
    expect(handoffs).toHaveLength(1)

    const payload = handoffs[0].payload as Record<string, unknown>
    expect(payload).toMatchObject({
      issueId: issue.id,
      fromUserId: builder.id,
      toUserId: babysitter.id,
      toHandle: 'babysitter',
      message: 'PR #12 is open, take it home',
    })
    // No toOwner field in the new model
    expect(payload).not.toHaveProperty('toOwner')
  })

  it('emits issue.owner_ping for OWNER target', async () => {
    const issue = await buildingIssue({ ownerId: babysitter.id })
    await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builder.id,
      target: 'OWNER',
      message: 'checks are green — merge?',
    })

    const events = await listEventsSince(db, {
      topicPatterns: [`issue:${issue.id}`],
      audience: 'public',
    })
    const ownerPings = events.filter((e) => e.type === ISSUE_OWNER_PING)
    expect(ownerPings).toHaveLength(1)

    const payload = ownerPings[0].payload as Record<string, unknown>
    expect(payload).toMatchObject({
      issueId: issue.id,
      fromUserId: builder.id,
      toUserId: babysitter.id,
      toHandle: 'babysitter',
      message: 'checks are green — merge?',
    })
    // No toOwner field in the new model
    expect(payload).not.toHaveProperty('toOwner')
  })

  it('issue.handoff events have no owner pings mixed in', async () => {
    const issue = await buildingIssue({ ownerId: babysitter.id })

    // Regular handoff
    await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builder.id,
      target: 'babysitter',
      message: 'take it',
    })

    // Owner ping
    await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builder.id,
      target: 'OWNER',
      message: 'review this',
    })

    const events = await listEventsSince(db, {
      topicPatterns: [`issue:${issue.id}`],
      audience: 'public',
    })

    const handoffs = events.filter((e) => e.type === ISSUE_HANDOFF)
    const ownerPings = events.filter((e) => e.type === ISSUE_OWNER_PING)

    expect(handoffs).toHaveLength(1)
    expect(ownerPings).toHaveLength(1)

    // Verify no cross-contamination
    expect(handoffs[0].type).toBe(ISSUE_HANDOFF)
    expect(ownerPings[0].type).toBe(ISSUE_OWNER_PING)
  })
})
