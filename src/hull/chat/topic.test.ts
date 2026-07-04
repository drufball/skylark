import { describe, expect, it } from 'vitest'
import {
  CHAT_AGENT_PROGRESS,
  CHAT_MESSAGE_POSTED,
  CHAT_TOPIC_PREFIX,
  chatIdFromTopic,
  chatTopic,
  type ChatAgentProgressPayload,
} from './topic'

describe('chat topic grammar', () => {
  it('builds a topic from chat id', () => {
    expect(chatTopic('abc123')).toBe('chat:abc123')
  })

  it('extracts chat id from topic', () => {
    expect(chatIdFromTopic('chat:abc123')).toBe('abc123')
  })

  it('returns null for non-chat topics', () => {
    expect(chatIdFromTopic('session:xyz')).toBeNull()
    expect(chatIdFromTopic('issue:123')).toBeNull()
    expect(chatIdFromTopic('notify:user1')).toBeNull()
  })

  it('exports the topic prefix constant', () => {
    expect(CHAT_TOPIC_PREFIX).toBe('chat:')
  })

  it('exports message posted event constant', () => {
    expect(CHAT_MESSAGE_POSTED).toBe('chat.message_posted')
  })

  it('exports agent progress event constant', () => {
    expect(CHAT_AGENT_PROGRESS).toBe('chat.agent_progress')
  })

  it('defines agent progress payload type', () => {
    const payload: ChatAgentProgressPayload = {
      chatId: 'chat123',
      agentUserId: 'agent456',
      line: 'working on it...',
    }
    expect(payload.chatId).toBe('chat123')
    expect(payload.agentUserId).toBe('agent456')
    expect(payload.line).toBe('working on it...')
  })
})
