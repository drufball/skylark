import { uuidv7 } from '@earendil-works/pi-agent-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '@hull/db/client'
import { freshDb } from '@hull/db/test-db'
import { createUser } from '@hull/users/service'
import { parseNewArgs } from './cli'
import { createIssue, getIssue } from './service'

describe('parseNewArgs', () => {
  it('parses title only when no body flag', () => {
    const [title, body] = parseNewArgs(['Fix', 'the', 'bug'])
    expect(title).toBe('Fix the bug')
    expect(body).toBeUndefined()
  })

  it('extracts body flag and remaining args as title', () => {
    const [title, body] = parseNewArgs([
      'Add',
      'feature',
      '--body',
      'This is the body text',
      'to',
      'project',
    ])
    expect(title).toBe('Add feature to project')
    expect(body).toBe('This is the body text')
  })

  it('handles body flag at the start', () => {
    const [title, body] = parseNewArgs([
      '--body',
      'Body text',
      'Issue',
      'title',
    ])
    expect(title).toBe('Issue title')
    expect(body).toBe('Body text')
  })

  it('handles body flag at the end', () => {
    const [title, body] = parseNewArgs([
      'Issue',
      'title',
      '--body',
      'Body text',
    ])
    expect(title).toBe('Issue title')
    expect(body).toBe('Body text')
  })

  it('handles empty title with body', () => {
    const [title, body] = parseNewArgs(['--body', 'Body text'])
    expect(title).toBe('')
    expect(body).toBe('Body text')
  })

  it('handles empty args', () => {
    const [title, body] = parseNewArgs([])
    expect(title).toBe('')
    expect(body).toBeUndefined()
  })
})

describe('createIssue with body', () => {
  let db: Database
  let close: () => Promise<void>
  let authorId: string

  beforeEach(async () => {
    ;({ db, close } = await freshDb())
    const author = await createUser(db, {
      id: uuidv7(),
      handle: 'test',
      displayName: 'Test',
      type: 'human',
    })
    authorId = author.id
  })

  afterEach(async () => {
    await close()
  })

  it('persists body when provided', async () => {
    const issue = await createIssue(db, {
      title: 'Issue with body',
      body: 'This is the body text',
      authorId,
    })
    expect(issue.body).toBe('This is the body text')

    const fetched = await getIssue(db, issue.id)
    expect(fetched?.body).toBe('This is the body text')
  })

  it('persists empty body when not provided', async () => {
    const issue = await createIssue(db, {
      title: 'Issue without body',
      authorId,
    })
    expect(issue.body).toBe('')

    const fetched = await getIssue(db, issue.id)
    expect(fetched?.body).toBe('')
  })

  it('allows undefined body', async () => {
    const issue = await createIssue(db, {
      title: 'Issue with undefined body',
      body: undefined,
      authorId,
    })
    expect(issue.body).toBe('')

    const fetched = await getIssue(db, issue.id)
    expect(fetched?.body).toBe('')
  })
})
