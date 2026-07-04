import { describe, expect, it } from 'vitest'

import { actorCmd } from './actor-cmd'

describe('actorCmd', () => {
  it('formats a command with SKYLARK_ACTOR prefix', () => {
    const cmd = actorCmd('user-123', 'issue', 'new', 'hello')
    expect(cmd).toBe('SKYLARK_ACTOR=user-123 npm run issue -- new hello')
  })

  it('handles multiple arguments', () => {
    const cmd = actorCmd('user-456', 'files', 'read', 'agents/builder/index.md')
    expect(cmd).toBe(
      'SKYLARK_ACTOR=user-456 npm run files -- read agents/builder/index.md',
    )
  })

  it('handles commands with no arguments', () => {
    const cmd = actorCmd('user-789', 'issue')
    expect(cmd).toBe('SKYLARK_ACTOR=user-789 npm run issue --')
  })

  it('passes through pre-quoted arguments as-is', () => {
    const cmd = actorCmd(
      'user-abc',
      'issue',
      'comment',
      'test',
      '"quoted text"',
    )
    expect(cmd).toBe(
      'SKYLARK_ACTOR=user-abc npm run issue -- comment test "quoted text"',
    )
  })
})
