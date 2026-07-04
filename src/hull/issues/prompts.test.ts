import { describe, expect, it } from 'vitest'

import {
  buildPrompt,
  generalPrompt,
  handoffPrompt,
  threadBlock,
} from './prompts'
import type { IssueRow } from './schema'

describe('threadBlock', () => {
  it('formats comments as a thread block', () => {
    const comments = [
      { authorHandle: 'alice', body: 'First comment' },
      { authorHandle: 'bob', body: 'Second comment' },
    ]
    expect(threadBlock(comments)).toBe(
      '\n\nThread so far:\n- @alice: First comment\n- @bob: Second comment',
    )
  })

  it('returns empty string when no comments', () => {
    expect(threadBlock([])).toBe('')
  })
})

describe('buildPrompt', () => {
  const issue: IssueRow = {
    id: 'issue-1',
    nano: 'abc1',
    title: 'Fix the bug',
    body: 'The widget is broken',
    status: 'building',
    authorId: 'author-1',
    ownerId: 'owner-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    playbookId: null,
    branchName: null,
    worktreePath: null,
    statusLine: null,
    visibility: 'public' as const,
    originChatId: null,
  }

  it('includes title, body, thread, and handoff to babysitter', () => {
    const prompt = buildPrompt(
      issue,
      [
        { authorHandle: 'alice', body: 'start here' },
        { authorHandle: 'bob', body: 'watch for edge cases' },
      ],
      'builder-123',
      'babysitter',
    )

    expect(prompt).toContain('#abc1')
    expect(prompt).toContain('Title: Fix the bug')
    expect(prompt).toContain('The widget is broken')
    expect(prompt).toContain('Thread so far:')
    expect(prompt).toContain(
      '- @alice: start here\n- @bob: watch for edge cases',
    )
    expect(prompt).toContain('SKYLARK_ACTOR=builder-123 npm run issue --')
    expect(prompt).toContain('handoff abc1 babysitter')
    expect(prompt).toContain("babysitter's job, not yours")
  })

  it('uses provided babysitter handle instead of hardcoding', () => {
    const prompt = buildPrompt(issue, [], 'builder-123', 'pr-shepherd')

    expect(prompt).toContain('handoff abc1 pr-shepherd')
    expect(prompt).toContain("pr-shepherd's job, not yours")
    expect(prompt).not.toContain('babysitter')
  })

  it('omits thread block when no comments', () => {
    const prompt = buildPrompt(issue, [], 'builder-123', 'babysitter')

    expect(prompt).not.toContain('Thread so far')
  })

  it('omits body when issue has no body', () => {
    const issueNoBody = { ...issue, body: '' }
    const prompt = buildPrompt(issueNoBody, [], 'builder-123', 'babysitter')

    expect(prompt).toContain('Title: Fix the bug')
    expect(prompt).not.toContain('The widget is broken')
  })
})

describe('generalPrompt', () => {
  const issue: IssueRow = {
    id: 'issue-2',
    nano: 'xyz9',
    title: 'Research task',
    body: 'Find the best approach',
    status: 'building',
    authorId: 'author-2',
    ownerId: 'owner-2',
    createdAt: new Date(),
    updatedAt: new Date(),
    playbookId: null,
    branchName: null,
    worktreePath: null,
    statusLine: null,
    visibility: 'public' as const,
    originChatId: null,
  }

  it('includes title, body, thread, and general CLI contract', () => {
    const prompt = generalPrompt(
      issue,
      [{ authorHandle: 'charlie', body: 'good luck' }],
      'hand-456',
    )

    expect(prompt).toContain('Work this issue (#xyz9)')
    expect(prompt).toContain('Title: Research task')
    expect(prompt).toContain('Find the best approach')
    expect(prompt).toContain('Thread so far:')
    expect(prompt).toContain('- @charlie: good luck')
    expect(prompt).toContain('SKYLARK_ACTOR=hand-456 npm run issue --')
    expect(prompt).toContain('comment xyz9')
    expect(prompt).toContain('handoff xyz9 <agent-handle>')
    expect(prompt).toContain('done xyz9')
  })

  it('does not mention PR or ship-feature', () => {
    const prompt = generalPrompt(issue, [], 'hand-456')

    expect(prompt).not.toContain('PR')
    expect(prompt).not.toContain('ship-feature')
    expect(prompt).not.toContain('babysitter')
  })
})

describe('handoffPrompt', () => {
  const issue: IssueRow = {
    id: 'issue-3',
    nano: 'def5',
    title: 'Handoff work',
    body: '',
    status: 'building',
    authorId: 'author-3',
    ownerId: 'owner-3',
    createdAt: new Date(),
    updatedAt: new Date(),
    playbookId: null,
    branchName: null,
    worktreePath: null,
    statusLine: null,
    visibility: 'public' as const,
    originChatId: null,
  }

  it('includes handoff message and CLI contract', () => {
    const prompt = handoffPrompt(
      issue,
      'alice',
      'Here is the PR, please review',
      'bob-789',
    )

    expect(prompt).toContain('@alice handed you issue #def5')
    expect(prompt).toContain('Title: Handoff work')
    expect(prompt).toContain('Their message:\nHere is the PR, please review')
    expect(prompt).toContain('SKYLARK_ACTOR=bob-789 npm run issue --')
    expect(prompt).toContain('show def5')
    expect(prompt).toContain('comment def5')
    expect(prompt).toContain('handoff def5 <agent-handle>')
    expect(prompt).toContain('done def5')
  })

  it('does not include full thread', () => {
    const prompt = handoffPrompt(issue, 'alice', 'Review this', 'bob-789')

    expect(prompt).not.toContain('Thread so far')
  })
})
