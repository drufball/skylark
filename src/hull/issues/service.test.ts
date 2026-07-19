import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { listEventsSince } from '@hull/events/service'
import { defined, freshDb } from '@hull/db/test-db'
import { createSession } from '@hull/agent/service'
import { createUser } from '@hull/users/service'

import {
  addComment,
  assembleThread,
  createIssue,
  generateNano,
  getIssue,
  getIssueSession,
  linkedSessionIds,
  listComments,
  listIssues,
  listIssueSessions,
  assertTransition,
  resolveIssueRef,
  resolveStatusWord,
  setBuildContext,
  setBatonHolder,
  claimIssueSession,
  setStatusLine,
  toBoardCard,
  transitionIssue,
  validateCommentInput,
  validateOpenIssueInput,
  validateTransitionInput,
  type IssueTransitionError,
} from './service'
import type { IssueRow } from './schema'

let db: Database
let close: () => Promise<void>
let authorId: string

beforeEach(async () => {
  ;({ db, close } = await freshDb())
  const author = await createUser(db, {
    id: uuidv7(),
    handle: 'drufball',
    displayName: 'Dru',
    type: 'human',
  })
  authorId = author.id
})

afterEach(async () => {
  await close()
})

describe('generateNano', () => {
  it('produces a 4-char url/git-safe id', () => {
    for (let i = 0; i < 50; i++) {
      const nano = generateNano()
      expect(nano).toHaveLength(4)
      // url + git ref safe: lowercase alnum only — no slashes, dots, spaces.
      expect(nano).toMatch(/^[0-9a-z]{4}$/)
    }
  })

  it('is overwhelmingly unique across many draws', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(generateNano())
    // 36^4 ≈ 1.7M space; 200 draws should virtually never collide.
    expect(seen.size).toBeGreaterThan(195)
  })
})

describe('assertTransition — the legal state machine', () => {
  it('allows open ↔ building', () => {
    expect(assertTransition('open', 'building')).toBe('building')
    expect(assertTransition('building', 'open')).toBe('open')
  })

  it('allows building → done', () => {
    expect(assertTransition('building', 'done')).toBe('done')
  })

  it('allows open|building → closed', () => {
    expect(assertTransition('open', 'closed')).toBe('closed')
    expect(assertTransition('building', 'closed')).toBe('closed')
  })

  it('rejects open → done (must build first)', () => {
    expect(() => assertTransition('open', 'done')).toThrow(/open.*done/i)
  })

  it('treats done and closed as terminal', () => {
    for (const to of ['open', 'building', 'done', 'closed'] as const) {
      expect(() => assertTransition('done', to)).toThrow()
      expect(() => assertTransition('closed', to)).toThrow()
    }
  })

  it('rejects a no-op transition to the same status', () => {
    expect(() => assertTransition('open', 'open')).toThrow()
    expect(() => assertTransition('building', 'building')).toThrow()
  })
})

describe('resolveStatusWord', () => {
  it('maps the accepted words to statuses', () => {
    expect(resolveStatusWord('open')).toBe('open')
    expect(resolveStatusWord('building')).toBe('building')
    expect(resolveStatusWord('done')).toBe('done')
    expect(resolveStatusWord('close')).toBe('closed')
    expect(resolveStatusWord('closed')).toBe('closed')
  })

  it('returns undefined for an unknown word', () => {
    expect(resolveStatusWord('frobnicate')).toBeUndefined()
    expect(resolveStatusWord('')).toBeUndefined()
  })
})

describe('validateOpenIssueInput — the web door check', () => {
  it('accepts a title with optional body and playbookId', () => {
    expect(
      validateOpenIssueInput({
        title: 'Fix it',
        body: 'how',
        playbookId: 'p1',
      }),
    ).toEqual({ title: 'Fix it', body: 'how', playbookId: 'p1' })
    expect(validateOpenIssueInput({ title: 'Fix it' })).toEqual({
      title: 'Fix it',
      body: undefined,
      playbookId: undefined,
    })
  })

  it('rejects a missing, non-string, or blank title', () => {
    expect(() => validateOpenIssueInput({})).toThrow(/title/)
    expect(() => validateOpenIssueInput({ title: 7 })).toThrow(/title/)
    expect(() => validateOpenIssueInput({ title: '   ' })).toThrow(/title/)
  })

  it('drops non-string body/playbookId rather than passing junk through', () => {
    expect(
      validateOpenIssueInput({ title: 'x', body: 9, playbookId: [] }),
    ).toEqual({ title: 'x', body: undefined, playbookId: undefined })
  })
})

describe('validateCommentInput — the web door check', () => {
  it('accepts an issueId and a non-empty body', () => {
    expect(validateCommentInput({ issueId: 'i1', body: 'hello' })).toEqual({
      issueId: 'i1',
      body: 'hello',
    })
  })

  it('rejects a missing issueId', () => {
    expect(() => validateCommentInput({ body: 'hello' })).toThrow(/issueId/)
    expect(() => validateCommentInput({ issueId: '', body: 'x' })).toThrow(
      /issueId/,
    )
  })

  it('rejects a missing or blank body', () => {
    expect(() => validateCommentInput({ issueId: 'i1' })).toThrow(/body/)
    expect(() => validateCommentInput({ issueId: 'i1', body: '  ' })).toThrow(
      /body/,
    )
  })
})

describe('validateTransitionInput — the web door check', () => {
  it('accepts an issueId and a known status word (incl. the close alias)', () => {
    expect(
      validateTransitionInput({ issueId: 'i1', status: 'building' }),
    ).toEqual({ issueId: 'i1', to: 'building' })
    expect(validateTransitionInput({ issueId: 'i1', status: 'close' })).toEqual(
      {
        issueId: 'i1',
        to: 'closed',
      },
    )
  })

  it('rejects a missing issueId', () => {
    expect(() => validateTransitionInput({ status: 'open' })).toThrow(/issueId/)
  })

  it('rejects an unknown or non-string status word', () => {
    expect(() =>
      validateTransitionInput({ issueId: 'i1', status: 'frobnicate' }),
    ).toThrow(/Unknown status: frobnicate/)
    expect(() => validateTransitionInput({ issueId: 'i1', status: 4 })).toThrow(
      /Unknown status/,
    )
  })
})

describe('resolveIssueRef', () => {
  it('resolves by nano and by full id', async () => {
    const issue = await createIssue(db, { title: 'x', authorId, nano: 'qw12' })
    expect((await resolveIssueRef(db, 'qw12'))?.id).toBe(issue.id)
    expect((await resolveIssueRef(db, issue.id))?.id).toBe(issue.id)
  })

  it('returns undefined for an unknown ref', async () => {
    expect(await resolveIssueRef(db, 'nope')).toBeUndefined()
  })
})

describe('createIssue', () => {
  it('creates an open issue with a unique nano and a title', async () => {
    const issue = await createIssue(db, {
      title: 'Add a widget',
      body: 'It should sparkle.',
      authorId,
    })
    expect(issue.status).toBe('open')
    expect(issue.nano).toMatch(/^[0-9a-z]{4}$/)
    expect(issue.title).toBe('Add a widget')
    expect(issue.body).toBe('It should sparkle.')
    expect(issue.authorId).toBe(authorId)

    const fetched = defined(await getIssue(db, issue.id))
    expect(fetched.id).toBe(issue.id)
    expect(fetched.body).toBe('It should sparkle.') // persisted, not just echoed
  })

  it('defaults body to empty', async () => {
    const issue = await createIssue(db, { title: 'Bare', authorId })
    expect(issue.body).toBe('')
  })

  it('defaults the owner to the creator when none is named', async () => {
    const issue = await createIssue(db, { title: 'Mine by default', authorId })
    expect(issue.ownerId).toBe(authorId)
  })

  it('records an explicit owner distinct from the author', async () => {
    const owner = await createUser(db, {
      id: uuidv7(),
      handle: 'tilde',
      displayName: 'Tilde',
      type: 'agent',
    })
    const issue = await createIssue(db, {
      title: 'Filed for tilde',
      authorId,
      ownerId: owner.id,
    })
    expect(issue.authorId).toBe(authorId)
    expect(issue.ownerId).toBe(owner.id)
  })

  it('announces the owner on issue.opened so the reactor can watch them', async () => {
    const issue = await createIssue(db, { title: 'watched', authorId })
    const events = await listEventsSince(db, {
      topicPatterns: [`issue:${issue.id}`],
      audience: 'public',
    })
    const opened = events.find((e) => e.type === 'issue.opened')
    expect(opened?.payload).toMatchObject({ ownerId: authorId })
  })

  it('retries on a nano collision so two issues never share one', async () => {
    // Force the first generated nano, then a distinct one. We seed an issue
    // holding "aaaa", then make the generator return "aaaa" once before "bbbb".
    await createIssue(db, { title: 'first', authorId, nano: 'aaaa' })
    const draws = ['aaaa', 'bbbb']
    let i = 0
    const issue = await createIssue(db, {
      title: 'second',
      authorId,
      generateNano: () => draws[i++] ?? 'zzzz',
    })
    expect(issue.nano).toBe('bbbb')
  })

  it('surfaces a forced-nano collision immediately — no pointless retries', async () => {
    await createIssue(db, { title: 'holder', authorId, nano: 'ff11' })
    const err: unknown = await createIssue(db, {
      title: 'clash',
      authorId,
      nano: 'ff11',
    }).then(
      () => undefined,
      (e: unknown) => e,
    )
    // The database's own unique-violation error, not the retry-exhausted one:
    // a forced nano can't be redrawn, so retrying it ten times would only bury
    // the real cause.
    expect(err).toBeInstanceOf(Error)
    expect(String(err)).toMatch(/insert into "issues"/i)
    expect(String(err)).not.toMatch(/could not generate/i)
  })

  it('gives up loudly if it cannot find a free nano', async () => {
    await createIssue(db, { title: 'holder', authorId, nano: 'dupe' })
    await expect(
      createIssue(db, {
        title: 'doomed',
        authorId,
        generateNano: () => 'dupe', // always collides
      }),
    ).rejects.toThrow(/unique issue nano/i)
  })
})

describe('listIssues + comments', () => {
  it('lists issues newest first', async () => {
    const a = await createIssue(db, { title: 'a', authorId })
    const b = await createIssue(db, { title: 'b', authorId })
    const list = await listIssues(db)
    expect(list.map((i) => i.id)).toEqual([b.id, a.id])
  })

  it('adds and lists comments in thread order, emitting issue.commented', async () => {
    const issue = await createIssue(db, { title: 'chat', authorId })
    await addComment(db, { issueId: issue.id, authorId, body: 'first' })
    await addComment(db, { issueId: issue.id, authorId, body: 'second' })
    const comments = await listComments(db, issue.id)
    expect(comments.map((c) => c.body)).toEqual(['first', 'second'])

    const events = await listEventsSince(db, {
      topicPatterns: [`issue:${issue.id}`],
      audience: 'public',
    })
    const commented = events.filter((e) => e.type === 'issue.commented')
    expect(commented).toHaveLength(2)
    // The payload names the issue AND the comment, so a subscriber can fetch
    // exactly the new row without rescanning the thread.
    expect(commented[0].payload).toMatchObject({
      issueId: issue.id,
      commentId: comments[0].id,
    })
  })

  it('threads real comments and status changes chronologically, interleaved', async () => {
    // comment → status change → comment, with real UUIDv7 ids from both
    // sources; the assembled thread must interleave them in event order.
    const issue = await createIssue(db, { title: 'timeline', authorId })
    const first = await addComment(db, {
      issueId: issue.id,
      authorId,
      body: 'first',
    })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    const second = await addComment(db, {
      issueId: issue.id,
      authorId,
      body: 'second',
    })
    const events = await listEventsSince(db, {
      topicPatterns: [`issue:${issue.id}`],
      audience: 'public',
    })
    const change = defined(
      events.find((e) => e.type === 'issue.status_changed'),
    )
    const thread = assembleThread({
      issue: defined(await getIssue(db, issue.id)),
      authorHandle: 'drufball',
      comments: (await listComments(db, issue.id)).map((c) => ({
        id: c.id,
        authorHandle: 'drufball',
        body: c.body,
        at: c.createdAt.toISOString(),
      })),
      statusChanges: [
        {
          id: change.id,
          authorHandle: 'drufball',
          from: 'open',
          to: 'building',
          at: change.createdAt.toISOString(),
        },
      ],
    })
    expect(thread.entries.map((e) => e.kind)).toEqual([
      'comment',
      'status',
      'comment',
    ])
    expect(thread.entries.map((e) => e.id)).toEqual([
      first.id,
      change.id,
      second.id,
    ])
  })
})

describe('transitionIssue', () => {
  it('moves the status and emits issue.status_changed once with topic and audience', async () => {
    const issue = await createIssue(db, { title: 'build me', authorId })
    const moved = await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    expect(moved.status).toBe('building')

    const events = await listEventsSince(db, {
      topicPatterns: [`issue:${issue.id}`],
      audience: 'public',
    })
    const changed = events.filter((e) => e.type === 'issue.status_changed')
    expect(changed).toHaveLength(1)
    expect(changed[0].payload).toMatchObject({
      from: 'open',
      to: 'building',
    })
    expect(changed[0].actorId).toBe(authorId)
    expect(changed[0].topic).toBe(`issue:${issue.id}`)
    expect(changed[0].audience).toBe('public')
  })

  it('board can subscribe via issue:* pattern with public audience', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    // Board subscribes to "issue:*" pattern, filtering by public audience
    const boardEvents = await listEventsSince(db, {
      topicPatterns: ['issue:*'],
      audience: 'public',
    })
    expect(boardEvents.some((e) => e.type === 'issue.status_changed')).toBe(
      true,
    )
  })

  it('rejects an illegal transition without changing the row or emitting', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    await expect(
      transitionIssue(db, { issueId: issue.id, to: 'done', actorId: authorId }),
    ).rejects.toThrow()
    const after = defined(await getIssue(db, issue.id))
    expect(after.status).toBe('open')
    const events = await listEventsSince(db, {
      topicPatterns: [`issue:${issue.id}`],
      audience: 'public',
    })
    expect(
      events.filter((e) => e.type === 'issue.status_changed'),
    ).toHaveLength(0)
  })

  it('surfaces a typed error naming both states', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    let err: IssueTransitionError | undefined
    try {
      await transitionIssue(db, {
        issueId: issue.id,
        to: 'done',
        actorId: authorId,
      })
    } catch (e) {
      err = e as IssueTransitionError
    }
    expect(err?.from).toBe('open')
    expect(err?.to).toBe('done')
  })

  it('clears the baton on → done (a terminal issue has no whose-turn)', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await setBatonHolder(db, issue.id, authorId)
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'done',
      actorId: authorId,
    })
    expect(defined(await getIssue(db, issue.id)).batonHolderId).toBeNull()
  })

  it('clears the baton on → closed', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    await setBatonHolder(db, issue.id, authorId)
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'closed',
      actorId: authorId,
    })
    expect(defined(await getIssue(db, issue.id)).batonHolderId).toBeNull()
  })

  it('leaves the baton untouched on a non-terminal move (→ open pause)', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    await setBatonHolder(db, issue.id, authorId)
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'open',
      actorId: authorId,
    })
    expect(defined(await getIssue(db, issue.id)).batonHolderId).toBe(authorId)
  })
})

describe('view-data shaping (pure)', () => {
  // A minimal IssueRow for the pure shapers — they only read these fields.
  function row(over: Partial<IssueRow> = {}): IssueRow {
    return {
      id: 'i1',
      nano: 'aa11',
      title: 'Add a widget',
      body: 'sparkle',
      status: 'building',
      authorId: 'u1',
      ownerId: 'u1',
      playbookId: null,
      visibility: 'public',
      batonHolderId: null,
      branchName: 'add-widget-aa11',
      worktreePath: '/wt/add-widget-aa11',
      statusLine: 'on it',
      statusLineAt: new Date(),
      awaitingBackground: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    }
  }

  it('toBoardCard carries author handle, comment count, and status line', () => {
    const card = toBoardCard(row(), 'drufball', 3)
    expect(card).toMatchObject({
      nano: 'aa11',
      authorHandle: 'drufball',
      commentCount: 3,
      statusLine: 'on it',
      status: 'building',
      sessionRunning: false,
    })
  })

  it('toBoardCard carries sessionRunning through when passed', () => {
    const card = toBoardCard(row(), 'drufball', 0, true)
    expect(card.sessionRunning).toBe(true)
  })

  it('toBoardCard defaults batonHolder to null and carries a passed holder', () => {
    expect(toBoardCard(row(), 'drufball', 0).batonHolder).toBeNull()
    const held = toBoardCard(row(), 'drufball', 0, false, {
      handle: 'drufball',
      isHuman: true,
    })
    expect(held.batonHolder).toEqual({ handle: 'drufball', isHuman: true })
  })

  it('assembleThread defaults batonHolder to null and carries a passed holder', () => {
    const none = assembleThread({
      issue: row(),
      authorHandle: 'drufball',
      comments: [],
      statusChanges: [],
    })
    expect(none.batonHolder).toBeNull()
    const held = assembleThread({
      issue: row(),
      authorHandle: 'drufball',
      comments: [],
      statusChanges: [],
      batonHolder: { handle: 'builder', isHuman: false },
    })
    expect(held.batonHolder).toEqual({ handle: 'builder', isHuman: false })
  })

  it('assembleThread merges comments + status changes in id (chronological) order', () => {
    // Ids chosen so the correct chronological order interleaves the two kinds.
    const thread = assembleThread({
      issue: row(),
      authorHandle: 'drufball',
      comments: [
        { id: 'b', authorHandle: 'drufball', body: 'second', at: '' },
        { id: 'd', authorHandle: 'builder', body: 'fourth', at: '' },
      ],
      statusChanges: [
        {
          id: 'a',
          authorHandle: 'drufball',
          from: 'open',
          to: 'building',
          at: '',
        },
        {
          id: 'c',
          authorHandle: 'builder',
          from: 'building',
          to: 'open',
          at: '',
        },
      ],
    })
    // UUIDv7 ids are time-ordered, so a lexical id sort is chronological.
    expect(thread.entries.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(thread.entries.map((e) => e.kind)).toEqual([
      'status',
      'comment',
      'status',
      'comment',
    ])
    expect(thread.branchName).toBe('add-widget-aa11')
    expect(thread.sessionRunning).toBe(false)
  })
})

describe('setBuildContext + setStatusLine', () => {
  it('records branch/worktree on first build', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    await setBuildContext(db, issue.id, {
      branchName: 'add-widget-aa12',
      worktreePath: '/home/me/skylark/worktrees/add-widget-aa12',
    })
    const after = defined(await getIssue(db, issue.id))
    expect(after.branchName).toBe('add-widget-aa12')
    expect(after.worktreePath).toBe(
      '/home/me/skylark/worktrees/add-widget-aa12',
    )
  })

  it('writes a status line, bumping statusLineAt and defaulting awaitingBackground false', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    const before = defined(await getIssue(db, issue.id))
    expect(before.statusLineAt).toBeNull()

    await setStatusLine(db, issue.id, 'running npm run check')
    const after = defined(await getIssue(db, issue.id))
    expect(after.statusLine).toBe('running npm run check')
    expect(after.statusLineAt).not.toBeNull()
    expect(after.awaitingBackground).toBe(false)
  })

  it('can mark a line as awaiting a background job, and a later plain write clears it', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    await setStatusLine(db, issue.id, '⏳ waiting on PR #12 CI…', {
      awaitingBackground: true,
    })
    const waiting = defined(await getIssue(db, issue.id))
    expect(waiting.awaitingBackground).toBe(true)

    await setStatusLine(db, issue.id, '🔧 bash npm run check')
    const resumed = defined(await getIssue(db, issue.id))
    expect(resumed.awaitingBackground).toBe(false)
  })
})

describe('issue sessions — one per (issue, agent)', () => {
  async function agentWithSession(handle: string) {
    const user = await createUser(db, {
      id: uuidv7(),
      handle,
      displayName: handle,
      type: 'agent',
    })
    const session = await createSession(db, {
      id: uuidv7(),
      model: 'claude-sonnet-5',
      agentUserId: user.id,
    })
    return { user, session }
  }

  it('records and reads back the session an agent holds on an issue', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    const { user, session } = await agentWithSession('builder')
    await claimIssueSession(db, {
      issueId: issue.id,
      agentUserId: user.id,
      sessionId: session.id,
    })
    const link = defined(await getIssueSession(db, issue.id, user.id))
    expect(link.sessionId).toBe(session.id)
  })

  it('keeps one session per (issue, agent): the first claim wins, the loser is told', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    const { user, session } = await agentWithSession('builder')
    const other = await createSession(db, {
      id: uuidv7(),
      model: 'claude-sonnet-5',
      agentUserId: user.id,
    })
    const first = await claimIssueSession(db, {
      issueId: issue.id,
      agentUserId: user.id,
      sessionId: session.id,
    })
    const second = await claimIssueSession(db, {
      issueId: issue.id,
      agentUserId: user.id,
      sessionId: other.id,
    })
    // The winner hears its own id back; the loser hears the incumbent's — the
    // arbitration a racing spawner uses to adopt the session that actually won.
    expect(first).toBe(session.id)
    expect(second).toBe(session.id)
    const link = defined(await getIssueSession(db, issue.id, user.id))
    expect(link.sessionId).toBe(session.id)
  })

  it('throws when the conflict is not the (issue, agent) slot — a session claimed twice', async () => {
    // The insert can also conflict on the sessionId UNIQUE constraint: one
    // session claimed for two different issues. There is no incumbent on the
    // second (issue, agent) slot to adopt, so this is a real bug to surface,
    // not a race to arbitrate.
    const issue = await createIssue(db, { title: 'x', authorId })
    const otherIssue = await createIssue(db, { title: 'y', authorId })
    const { user, session } = await agentWithSession('builder')
    await claimIssueSession(db, {
      issueId: issue.id,
      agentUserId: user.id,
      sessionId: session.id,
    })
    await expect(
      claimIssueSession(db, {
        issueId: otherIssue.id,
        agentUserId: user.id,
        sessionId: session.id,
      }),
    ).rejects.toThrow(/no winner row exists/)
  })

  it('lists every linked session id across all issues (the orphan-sweep allowlist)', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    const otherIssue = await createIssue(db, { title: 'y', authorId })
    const a = await agentWithSession('builder')
    const b = await agentWithSession('babysitter')
    await claimIssueSession(db, {
      issueId: issue.id,
      agentUserId: a.user.id,
      sessionId: a.session.id,
    })
    await claimIssueSession(db, {
      issueId: otherIssue.id,
      agentUserId: b.user.id,
      sessionId: b.session.id,
    })
    expect((await linkedSessionIds(db)).sort()).toEqual(
      [a.session.id, b.session.id].sort(),
    )
  })

  it('lists every hand on an issue, and nothing from other issues', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    const bystander = await createIssue(db, { title: 'y', authorId })
    const a = await agentWithSession('builder')
    const b = await agentWithSession('babysitter')
    await claimIssueSession(db, {
      issueId: issue.id,
      agentUserId: a.user.id,
      sessionId: a.session.id,
    })
    await claimIssueSession(db, {
      issueId: issue.id,
      agentUserId: b.user.id,
      sessionId: b.session.id,
    })
    const links = await listIssueSessions(db, issue.id)
    expect(links.map((l) => l.sessionId).sort()).toEqual(
      [a.session.id, b.session.id].sort(),
    )
    expect(await listIssueSessions(db, bystander.id)).toEqual([])
  })
})
