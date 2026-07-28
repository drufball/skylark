import { describe, expect, it } from 'vitest'

import { chatDocsDir } from './docs'

describe('chatDocsDir', () => {
  it('derives a stable, shared-files folder from the chat id', () => {
    expect(chatDocsDir('room-issues')).toBe('chats/room-issues')
  })

  it('uses an ordinary chat’s bare uuid the same way — no separate slug', () => {
    expect(chatDocsDir('019fa5b1-f0f1-7000-8000-000000000000')).toBe(
      'chats/019fa5b1-f0f1-7000-8000-000000000000',
    )
  })

  it('is a pure function of the id alone — same id, same folder, every call', () => {
    expect(chatDocsDir('room-files')).toBe(chatDocsDir('room-files'))
  })
})
