import { describe, expect, it } from 'vitest'
import { parseNewArgs } from './cli'

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
