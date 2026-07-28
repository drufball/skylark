import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeAll, vi } from 'vitest'

import { ChatView, type ChatViewProps } from './chat'

// The shared bed for the chat view's test files. The view is one assembly
// split across panel modules (chat-thread, chat-roster, chat-schedules,
// chat-compose), and every panel is exercised the way the crew reaches it —
// through ChatView — so each file needs the same scaffolding: a render helper
// with the required props filled in, a viewport setter, and jsdom's missing
// scrollIntoView. (Excluded from the coverage/mutation gates like every other
// test-support module — see test-excludes.mjs.)

/** jsdom has no scrollIntoView; the thread calls it to stay at the newest message. */
export const scrollIntoView = vi.fn()

/**
 * Register the hooks every chat view test file needs: the scrollIntoView
 * stub, DOM cleanup, and a viewport restored between tests. Call once at the
 * top of the file.
 */
export function installChatTestBed() {
  beforeAll(() => {
    Element.prototype.scrollIntoView = scrollIntoView
  })
  afterEach(cleanup)
  const originalWidth = window.innerWidth
  afterEach(() => {
    setWidth(originalWidth)
  })
}

export function setWidth(width: number) {
  act(() => {
    window.innerWidth = width
    window.dispatchEvent(new Event('resize'))
  })
}

export function renderView(props: Partial<ChatViewProps> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onSend: vi.fn(),
    onCreate: vi.fn(),
    onAddMember: vi.fn(),
    onRemoveMember: vi.fn(),
  }
  const result = render(
    <ChatView
      chats={[]}
      title={null}
      members={[]}
      messages={[]}
      working={null}
      crew={[]}
      composing={false}
      busy={false}
      {...handlers}
      {...props}
    />,
  )
  return { ...result, ...handlers }
}
