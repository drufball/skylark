// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { installChatTestBed, renderView } from './chat.test-support'

installChatTestBed()

describe('ChatView: the roster', () => {
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
