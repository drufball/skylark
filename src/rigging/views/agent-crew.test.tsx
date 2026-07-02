// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentCrew,
  type AgentCrewProps,
  type CrewMemberSummary,
} from './agent-crew'

afterEach(cleanup)

const CREW: CrewMemberSummary[] = [
  {
    id: 'h1',
    handle: 'dru',
    displayName: 'Dru',
    type: 'human',
    profileId: null,
  },
  {
    id: 'a1',
    handle: 'tilde',
    displayName: 'Tilde',
    type: 'agent',
    profileId: 'p-chat',
  },
]

const PROFILES = [
  { id: 'p-chat', name: 'chat' },
  { id: 'p-builder', name: 'builder' },
]

function renderView(props: Partial<AgentCrewProps> = {}) {
  const onCreate = vi.fn()
  const onUpdate = vi.fn()
  const onOpenMemory = vi.fn()
  const result = render(
    <AgentCrew
      crew={CREW}
      profiles={PROFILES}
      saving={false}
      onCreate={onCreate}
      onUpdate={onUpdate}
      onOpenMemory={onOpenMemory}
      {...props}
    />,
  )
  return { ...result, onCreate, onUpdate, onOpenMemory }
}

describe('AgentCrew', () => {
  it('splits the roster: agents editable, humans read-only', () => {
    renderView()
    expect(screen.getByText(/agents · 1/i)).toBeTruthy()
    expect(screen.getByText(/humans · 1/i)).toBeTruthy()
    // The agent's name is an input; the human's is plain text.
    expect(screen.getByLabelText('Display name for @tilde')).toBeTruthy()
    expect(screen.getByText('Dru')).toBeTruthy()
  })

  it('creates a named agent through the form, lowercasing the handle', () => {
    const { onCreate } = renderView()
    fireEvent.click(screen.getByText(/new agent/i))
    fireEvent.change(screen.getByPlaceholderText(/handle/i), {
      target: { value: 'Scout' },
    })
    fireEvent.change(screen.getByPlaceholderText('Display name'), {
      target: { value: 'Scout' },
    })
    fireEvent.click(screen.getByText('Create agent'))
    expect(onCreate).toHaveBeenCalledWith({
      handle: 'scout',
      displayName: 'Scout',
      profileId: null,
    })
  })

  it('renames an agent on blur — only when the name actually changed', () => {
    const { onUpdate } = renderView()
    const input = screen.getByLabelText('Display name for @tilde')
    fireEvent.blur(input)
    expect(onUpdate).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'Tilde the Shipwright' } })
    fireEvent.blur(input)
    expect(onUpdate).toHaveBeenCalledWith({
      userId: 'a1',
      displayName: 'Tilde the Shipwright',
    })
  })

  it('re-points an agent at another profile', () => {
    const { onUpdate } = renderView()
    fireEvent.change(screen.getByDisplayValue('chat'), {
      target: { value: 'p-builder' },
    })
    expect(onUpdate).toHaveBeenCalledWith({
      userId: 'a1',
      profileId: 'p-builder',
    })
  })

  it('opens an agent memory from the card', () => {
    const { onOpenMemory } = renderView()
    fireEvent.click(screen.getByText('Memory'))
    expect(onOpenMemory).toHaveBeenCalledWith('tilde')
  })
})
