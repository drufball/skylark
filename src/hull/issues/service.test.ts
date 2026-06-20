import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from '@hull/db/client'
import { listEventsSince } from '@hull/events/service'
import { defined, freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'

import {
  addComment,
  assembleThread,
  createIssue,
  generateNano,
  getIssue,
  listComments,
  listIssues,
  nextStatus,
  resolveIssueRef,
  resolveStatusWord,
  setBuildContext,
  setStatusLine,
  toBoardCard,
  transitionIssue,
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

describe('nextStatus — the legal state machine', () => {
  it('allows open ↔ building', () => {
    expect(nextStatus('open', 'building')).toBe('building')
    expect(nextStatus('building', 'open')).toBe('open')
  })

  it('allows building → done', () => {
    expect(nextStatus('building', 'done')).toBe('done')
  })

  it('allows open|building → closed', () => {
    expect(nextStatus('open', 'closed')).toBe('closed')
    expect(nextStatus('building', 'closed')).toBe('closed')
  })

  it('rejects open → done (must build first)', () => {
    expect(() => nextStatus('open', 'done')).toThrow(/open.*done/i)
  })

  it('treats done and closed as terminal', () => {
    for (const to of ['open', 'building', 'done', 'closed'] as const) {
      expect(() => nextStatus('done', to)).toThrow()
      expect(() => nextStatus('closed', to)).toThrow()
    }
  })

  it('rejects a no-op transition to the same status', () => {
    expect(() => nextStatus('open', 'open')).toThrow()
    expect(() => nextStatus('building', 'building')).toThrow()
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
  })

  it('defaults body to empty', async () => {
    const issue = await createIssue(db, { title: 'Bare', authorId })
    expect(issue.body).toBe('')
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
      scopes: [`issue:${issue.id}`],
    })
    const commented = events.filter((e) => e.type === 'issue.commented')
    expect(commented).toHaveLength(2)
  })
})

describe('transitionIssue', () => {
  it('moves the status and emits issue.status_changed', async () => {
    const issue = await createIssue(db, { title: 'build me', authorId })
    const moved = await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    expect(moved.status).toBe('building')

    const events = await listEventsSince(db, { scopes: [`issue:${issue.id}`] })
    const changed = events.filter((e) => e.type === 'issue.status_changed')
    expect(changed).toHaveLength(1)
    expect(changed[0].payload).toMatchObject({
      from: 'open',
      to: 'building',
    })
    expect(changed[0].actorId).toBe(authorId)
  })

  it('also emits on the public scope so the board updates live', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    await transitionIssue(db, {
      issueId: issue.id,
      to: 'building',
      actorId: authorId,
    })
    const publicEvents = await listEventsSince(db, { scopes: ['public'] })
    expect(publicEvents.some((e) => e.type === 'issue.status_changed')).toBe(
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
    const events = await listEventsSince(db, { scopes: [`issue:${issue.id}`] })
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
      visibility: 'public',
      branchName: 'add-widget-aa11',
      worktreePath: '/wt/add-widget-aa11',
      sessionId: 's1',
      statusLine: 'on it',
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
    })
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
  })
})

describe('setBuildContext + setStatusLine', () => {
  it('records branch/worktree/session on first build', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    await setBuildContext(db, issue.id, {
      branchName: 'add-widget-aa12',
      worktreePath: '/home/me/skylark/worktrees/add-widget-aa12',
      sessionId: null,
    })
    const after = defined(await getIssue(db, issue.id))
    expect(after.branchName).toBe('add-widget-aa12')
    expect(after.worktreePath).toBe(
      '/home/me/skylark/worktrees/add-widget-aa12',
    )
  })

  it('writes a status line', async () => {
    const issue = await createIssue(db, { title: 'x', authorId })
    await setStatusLine(db, issue.id, 'running npm run check')
    const after = defined(await getIssue(db, issue.id))
    expect(after.statusLine).toBe('running npm run check')
  })
})
