import { uuidv7 } from '@earendil-works/pi-agent-core'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { listEventsSince } from '@hull/events/service'
import { createSession, setStatus } from '@hull/agent/service'
import { createUser } from '@hull/users/service'
import type { UserRow } from '@hull/users/schema'

import {
  ISSUE_HANDOFF,
  requestHandoff,
  type IssueHandoffPayload,
} from './handoff'
import {
  createIssue,
  setBuildContext,
  recordIssueSession,
  transitionIssue,
} from './service'
import { upsertPlaybook } from './playbooks'
import { issues, type IssueRow } from './schema'

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

/** An issue mid-build, the state most handoffs happen in. */
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

/**
 * Point an issue at a playbook by writing the row directly — no production
 * code sets an issue's playbook after filing, so the tests do it by SQL.
 */
async function pointIssueAtPlaybook(
  issueId: string,
  playbookId: string,
): Promise<void> {
  await db.update(issues).set({ playbookId }).where(eq(issues.id, issueId))
}

/** The handoff events announced on an issue's topic. */
async function handoffEvents(issueId: string) {
  const events = await listEventsSince(db, {
    topicPatterns: [`issue:${issueId}`],
    audience: 'public',
  })
  return events.filter((e) => e.type === ISSUE_HANDOFF)
}

describe('requestHandoff — agent to agent', () => {
  it('emits issue.handoff naming both ends, with the message', async () => {
    const issue = await buildingIssue()
    const result = await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builder.id,
      target: 'babysitter',
      message: 'PR #12 is open, take it home',
    })
    expect(result.toHandle).toBe('babysitter')
    expect(result.toOwner).toBe(false)

    const [event] = await handoffEvents(issue.id)
    expect(event.actorId).toBe(builder.id)
    expect(event.payload).toMatchObject({
      issueId: issue.id,
      fromUserId: builder.id,
      toUserId: babysitter.id,
      toHandle: 'babysitter',
      toOwner: false,
      message: 'PR #12 is open, take it home',
    } satisfies IssueHandoffPayload)
  })

  it('accepts an @-prefixed handle, the way crew are named everywhere else', async () => {
    const issue = await buildingIssue()
    const result = await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builder.id,
      target: '@babysitter',
      message: 'over to you',
    })
    expect(result.toHandle).toBe('babysitter')
  })

  it('refuses when the issue is not building — there is no worktree to hand', async () => {
    const issue = await createIssue(db, { title: 'idle', authorId: dru.id })
    await expect(
      requestHandoff(db, {
        issueRef: issue.nano,
        actorId: builder.id,
        target: 'babysitter',
        message: 'go',
      }),
    ).rejects.toThrow(/building/i)
    expect(await handoffEvents(issue.id)).toHaveLength(0)
  })

  it('refuses an unknown crew member', async () => {
    const issue = await buildingIssue()
    await expect(
      requestHandoff(db, {
        issueRef: issue.nano,
        actorId: builder.id,
        target: 'nobody',
        message: 'go',
      }),
    ).rejects.toThrow(/no such crew/i)
  })

  it('refuses a human target — humans are reached via OWNER, not the baton', async () => {
    const issue = await buildingIssue()
    await expect(
      requestHandoff(db, {
        issueRef: issue.nano,
        actorId: builder.id,
        target: 'drufball',
        message: 'go',
      }),
    ).rejects.toThrow(/agent/i)
  })

  it('refuses handing the baton to yourself', async () => {
    const issue = await buildingIssue()
    await expect(
      requestHandoff(db, {
        issueRef: issue.nano,
        actorId: builder.id,
        target: 'builder',
        message: 'go',
      }),
    ).rejects.toThrow(/yourself/i)
  })

  it('refuses while another agent is mid-turn on the issue — one baton', async () => {
    const issue = await buildingIssue()
    const session = await createSession(db, {
      id: uuidv7(),
      model: 'claude-sonnet-5',
      agentUserId: babysitter.id,
    })
    await recordIssueSession(db, {
      issueId: issue.id,
      agentUserId: babysitter.id,
      sessionId: session.id,
    })
    await setStatus(db, session.id, 'running')
    await expect(
      requestHandoff(db, {
        issueRef: issue.nano,
        actorId: builder.id,
        target: 'babysitter',
        message: 'go',
      }),
    ).rejects.toThrow(/@babysitter/)
  })

  it('the caller being mid-turn does not block — an agent hands off from inside its own turn', async () => {
    const issue = await buildingIssue()
    const session = await createSession(db, {
      id: uuidv7(),
      model: 'claude-sonnet-5',
      agentUserId: builder.id,
    })
    await recordIssueSession(db, {
      issueId: issue.id,
      agentUserId: builder.id,
      sessionId: session.id,
    })
    await setStatus(db, session.id, 'running')
    const result = await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builder.id,
      target: 'babysitter',
      message: 'go',
    })
    expect(result.toHandle).toBe('babysitter')
  })

  it('refuses an empty message — a baton with no brief is a dropped baton', async () => {
    const issue = await buildingIssue()
    await expect(
      requestHandoff(db, {
        issueRef: issue.nano,
        actorId: builder.id,
        target: 'babysitter',
        message: '   ',
      }),
    ).rejects.toThrow(/message/i)
  })

  it('refuses an unknown issue ref', async () => {
    await expect(
      requestHandoff(db, {
        issueRef: 'zzzz',
        actorId: builder.id,
        target: 'babysitter',
        message: 'go',
      }),
    ).rejects.toThrow(/no such issue/i)
  })
})

describe('requestHandoff — playbook membership', () => {
  it('refuses a target outside the issue playbook, naming the roster', async () => {
    const issue = await buildingIssue()
    const outsider = await createUser(db, {
      id: uuidv7(),
      handle: 'outsider',
      displayName: 'Outsider',
      type: 'agent',
    })
    const playbook = await upsertPlaybook(db, {
      name: 'duo',
      memberIds: [builder.id, babysitter.id],
      entrypointId: builder.id,
    })
    await pointIssueAtPlaybook(issue.id, playbook.id)
    await expect(
      requestHandoff(db, {
        issueRef: issue.nano,
        actorId: builder.id,
        target: 'outsider',
        message: 'go',
      }),
    ).rejects.toThrow(/playbook.*@builder.*@babysitter/s)
    void outsider
  })

  it('allows roster members, and OWNER regardless of the roster', async () => {
    const issue = await buildingIssue()
    const playbook = await upsertPlaybook(db, {
      name: 'duo',
      memberIds: [builder.id, babysitter.id],
      entrypointId: builder.id,
    })
    await pointIssueAtPlaybook(issue.id, playbook.id)
    const pass = await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builder.id,
      target: 'babysitter',
      message: 'go',
    })
    expect(pass.toHandle).toBe('babysitter')
    const ping = await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builder.id,
      target: 'OWNER',
      message: 'thoughts?',
    })
    expect(ping.toOwner).toBe(true)
  })

  it('places no roster limit when no playbook exists (unseeded ship)', async () => {
    const issue = await buildingIssue()
    const anyone = await createUser(db, {
      id: uuidv7(),
      handle: 'anyone',
      displayName: 'Anyone',
      type: 'agent',
    })
    const result = await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builder.id,
      target: 'anyone',
      message: 'go',
    })
    expect(result.toHandle).toBe(anyone.handle)
  })
})

describe('requestHandoff — OWNER', () => {
  it('targets the issue owner with toOwner, resolving their handle', async () => {
    const issue = await buildingIssue({ ownerId: babysitter.id })
    const result = await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builder.id,
      target: 'OWNER',
      message: 'checks are green — merge?',
    })
    expect(result.toOwner).toBe(true)
    expect(result.toHandle).toBe('babysitter')

    const [event] = await handoffEvents(issue.id)
    expect(event.payload).toMatchObject({
      toUserId: babysitter.id,
      toOwner: true,
      message: 'checks are green — merge?',
    })
  })

  it('works on an issue that is not building — an owner ping needs no worktree', async () => {
    const issue = await createIssue(db, {
      title: 'just a question',
      authorId: dru.id,
    })
    const result = await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builder.id,
      target: 'OWNER',
      message: 'is this still wanted?',
    })
    expect(result.toOwner).toBe(true)
    expect(result.toHandle).toBe('drufball')
  })

  it('refuses a self-ping — the reactor never delivers your own action to you', async () => {
    const issue = await buildingIssue({ ownerId: builder.id })
    await expect(
      requestHandoff(db, {
        issueRef: issue.nano,
        actorId: builder.id,
        target: 'OWNER',
        message: 'am I done?',
      }),
    ).rejects.toThrow(/yourself|goes nowhere/i)
    expect(await handoffEvents(issue.id)).toHaveLength(0)
  })

  it('accepts lowercase "owner" too', async () => {
    const issue = await buildingIssue()
    const result = await requestHandoff(db, {
      issueRef: issue.nano,
      actorId: builder.id,
      target: 'owner',
      message: 'done?',
    })
    expect(result.toOwner).toBe(true)
  })
})
