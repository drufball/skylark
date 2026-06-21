// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { ChatView, type ChatViewProps, chatName } from './chat'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

describe('chatName', () => {
  it('uses the title, else the members, else a fallback', () => {
    expect(chatName({ title: 'design', memberHandles: ['a'] })).toBe('design')
    expect(chatName({ title: null, memberHandles: ['tilde', 'bix'] })).toBe(
      '@tilde, @bix',
    )
    expect(chatName({ title: null, memberHandles: [] })).toBe('New chat')
  })
})

function renderView(props: Partial<ChatViewProps> = {}) {
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

describe('ChatView', () => {
  it('lists chats and selects one', () => {
    const { onSelect } = renderView({
      chats: [{ id: 'c1', title: null, memberHandles: ['tilde'] }],
    })
    // With chats present the "no chats yet" sidebar placeholder is gone.
    expect(screen.queryByText(/no chats yet/i)).toBeNull()
    fireEvent.click(screen.getByText('@tilde'))
    expect(onSelect).toHaveBeenCalledWith('c1')
  })

  // The accent token also appears as `hover:bg-accent`, so match it as a
  // standalone class, not a substring.
  const classTokens = (el: Element) => el.className.split(/\s+/)

  it('highlights only the active chat in the list', () => {
    renderView({
      activeId: 'c1',
      chats: [
        { id: 'c1', title: null, memberHandles: ['tilde'] },
        { id: 'c2', title: null, memberHandles: ['bix'] },
      ],
    })
    // The active row carries the accent class; the inactive one does not.
    expect(classTokens(screen.getByText('@tilde'))).toContain('bg-accent')
    expect(classTokens(screen.getByText('@bix'))).not.toContain('bg-accent')
  })

  it('does not highlight any chat while composing a new one', () => {
    // composing wins over activeId: the list shows no selection. (zara is only
    // in the chat list, never the crew picker, so the lookup is unambiguous.)
    renderView({
      activeId: 'c1',
      composing: true,
      chats: [{ id: 'c1', title: null, memberHandles: ['zara'] }],
      crew: [{ id: 'a', handle: 'tilde', displayName: 'Tilde', type: 'agent' }],
    })
    expect(classTokens(screen.getByText('@zara'))).not.toContain('bg-accent')
  })

  it('renders messages, attributing only others (not mine)', () => {
    renderView({
      activeId: 'c1',
      members: [{ userId: 'a', handle: 'tilde', type: 'agent' }],
      messages: [
        { id: 'm1', authorHandle: 'dru', body: 'hi', mine: true },
        { id: 'm2', authorHandle: 'tilde', body: 'hello', mine: false },
      ],
    })
    expect(screen.getByText('hi')).toBeTruthy()
    expect(screen.getByText('hello')).toBeTruthy()
    // The other party is labelled (header chip + the message author line)…
    expect(screen.getAllByText('@tilde').length).toBeGreaterThan(0)
    // …but my own message is not prefixed with my handle.
    expect(screen.queryByText('@dru')).toBeNull()
  })

  it('shows a working placeholder for a mid-reply agent', () => {
    renderView({
      activeId: 'c1',
      working: { handle: 'tilde', line: 'thinking…' },
    })
    expect(screen.getByText('thinking…')).toBeTruthy()
  })

  it('sends a message from the composer', () => {
    const { onSend } = renderView({ activeId: 'c1' })
    const box = screen.getByPlaceholderText(/message/i)
    fireEvent.change(box, { target: { value: '  hey  ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hey')
  })

  it('composes a new chat by picking members (with toggle-off)', () => {
    const { onCreate } = renderView({
      composing: true,
      crew: [
        { id: 'a', handle: 'tilde', displayName: 'Tilde', type: 'agent' },
        { id: 'b', handle: 'bix', displayName: 'Bix', type: 'agent' },
        { id: 'c', handle: 'sam', displayName: 'Sam', type: 'human' },
      ],
    })
    fireEvent.change(screen.getByPlaceholderText(/title/i), {
      target: { value: 'planning' },
    })
    fireEvent.click(screen.getByText('@tilde')) // select
    fireEvent.click(screen.getByText('@tilde')) // deselect (toggle off)
    fireEvent.click(screen.getByText('@bix'))
    fireEvent.click(screen.getByText('Start chat'))
    expect(onCreate).toHaveBeenCalledWith(['b'], 'planning')
  })

  it('does not send on Shift+Enter', () => {
    const { onSend } = renderView({ activeId: 'c1' })
    const box = screen.getByPlaceholderText(/message/i)
    fireEvent.change(box, { target: { value: 'multi' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows the empty state with no chats and not composing', () => {
    renderView()
    expect(screen.getByText(/start a conversation/i)).toBeTruthy()
  })

  it('does not send a blank message', () => {
    const { onSend } = renderView({ activeId: 'c1' })
    const box = screen.getByPlaceholderText(/message/i)
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('disables Start chat until a member is picked', () => {
    const { onCreate } = renderView({
      composing: true,
      crew: [{ id: 'a', handle: 'tilde', displayName: 'Tilde', type: 'agent' }],
    })
    fireEvent.click(screen.getByText('Start chat'))
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('adds and removes members', () => {
    const { onAddMember, onRemoveMember } = renderView({
      activeId: 'c1',
      members: [{ userId: 'a', handle: 'tilde', type: 'agent' }],
      crew: [
        { id: 'a', handle: 'tilde', displayName: 'Tilde', type: 'agent' },
        { id: 'b', handle: 'bix', displayName: 'Bix', type: 'agent' },
      ],
    })
    fireEvent.change(screen.getByLabelText('Add member'), {
      target: { value: 'b' },
    })
    expect(onAddMember).toHaveBeenCalledWith('b')

    fireEvent.click(screen.getByLabelText('Remove tilde'))
    expect(onRemoveMember).toHaveBeenCalledWith('a')
  })
})
