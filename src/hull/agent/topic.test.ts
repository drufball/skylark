import { describe, expect, it } from 'vitest'
import { SESSION_TOPIC_PREFIX, sessionIdFromTopic, sessionTopic } from './topic'

describe('agent topic grammar', () => {
  it('builds a topic from session id', () => {
    expect(sessionTopic('session123')).toBe('session:session123')
  })

  it('extracts session id from topic', () => {
    expect(sessionIdFromTopic('session:session123')).toBe('session123')
  })

  it('returns null for non-session topics', () => {
    expect(sessionIdFromTopic('chat:abc')).toBeNull()
    expect(sessionIdFromTopic('issue:123')).toBeNull()
    expect(sessionIdFromTopic('notify:user1')).toBeNull()
  })

  it('exports the topic prefix constant', () => {
    expect(SESSION_TOPIC_PREFIX).toBe('session:')
  })
})
