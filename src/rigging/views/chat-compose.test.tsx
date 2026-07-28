// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { installChatTestBed, renderView, setWidth } from './chat.test-support'

installChatTestBed()

describe('ChatView: composing a new chat', () => {
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

  it('disables Start chat until a member is picked', () => {
    const { onCreate } = renderView({
      composing: true,
      crew: [{ id: 'a', handle: 'tilde', displayName: 'Tilde', type: 'agent' }],
    })
    fireEvent.click(screen.getByText('Start chat'))
    expect(onCreate).not.toHaveBeenCalled()
  })
})

describe('ChatView: the empty state', () => {
  it('shows the empty state with no chats and not composing', () => {
    renderView()
    expect(screen.getByText(/start a conversation/i)).toBeTruthy()
  })

  it('starts a chat from the empty state itself', () => {
    // On a phone the sidebar's New button is inside a closed drawer, so copy
    // that said "New to begin" pointed at a control that wasn't on the screen.
    setWidth(390)
    const { onNew } = renderView()
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(onNew).toHaveBeenCalled()
  })
})
