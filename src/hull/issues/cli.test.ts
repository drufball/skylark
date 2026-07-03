import { describe, expect, it } from 'vitest'
import { parseNewArgs } from './cli'

describe('parseNewArgs', () => {
  it('parses a bare title', () => {
    expect(parseNewArgs(['Fix', 'the', 'bug'])).toEqual({
      title: 'Fix the bug',
      body: undefined,
      originChatId: undefined,
    })
  })

  it('extracts --body wherever it sits, keeping the rest as the title', () => {
    expect(
      parseNewArgs(['Add', 'feature', '--body', 'The body', 'to', 'project']),
    ).toEqual({
      title: 'Add feature to project',
      body: 'The body',
      originChatId: undefined,
    })
    expect(parseNewArgs(['--body', 'Body text', 'Issue', 'title'])).toEqual({
      title: 'Issue title',
      body: 'Body text',
      originChatId: undefined,
    })
    expect(parseNewArgs(['Issue', 'title', '--body', 'Body text'])).toEqual({
      title: 'Issue title',
      body: 'Body text',
      originChatId: undefined,
    })
  })

  it('extracts --chat (the origin conversation) alongside --body', () => {
    expect(
      parseNewArgs(['Fix', 'it', '--chat', 'c-123', '--body', 'details']),
    ).toEqual({ title: 'Fix it', body: 'details', originChatId: 'c-123' })
  })

  it('yields an empty title (a usage error upstream) when only flags are given', () => {
    expect(parseNewArgs(['--body', 'Body text'])).toEqual({
      title: '',
      body: 'Body text',
      originChatId: undefined,
    })
    expect(parseNewArgs([])).toEqual({
      title: '',
      body: undefined,
      originChatId: undefined,
    })
  })
})

describe('parseNewArgs — strict flag values', () => {
  it('rejects a flag with no value, or with another flag where its value goes', () => {
    expect(() => parseNewArgs(['Fix', '--chat'])).toThrow(/--chat requires/)
    expect(() => parseNewArgs(['Fix', '--chat', '--body', 'x'])).toThrow(
      /--chat requires/,
    )
    expect(() => parseNewArgs(['Fix', '--body'])).toThrow(/--body requires/)
    expect(() => parseNewArgs(['Fix', '--owner'])).toThrow(/--owner requires/)
  })
})

describe('parseNewArgs — owner', () => {
  it('extracts --owner (a crew handle), with or without the @', () => {
    expect(parseNewArgs(['Fix', 'it', '--owner', 'tilde'])).toEqual({
      title: 'Fix it',
      body: undefined,
      originChatId: undefined,
      ownerHandle: 'tilde',
    })
    expect(parseNewArgs(['Fix', 'it', '--owner', '@tilde']).ownerHandle).toBe(
      'tilde',
    )
  })

  it('leaves ownerHandle undefined when the flag is absent — owner defaults to the creator downstream', () => {
    expect(parseNewArgs(['Fix', 'it']).ownerHandle).toBeUndefined()
  })
})
