// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentCrew,
  formatToolList,
  parseToolList,
  type AgentCrewProps,
  type CrewMemberSummary,
  type ExtensionSummary,
} from './agent-crew'

afterEach(cleanup)

describe('parseToolList', () => {
  it('splits on commas and whitespace, trimming blanks', () => {
    expect(parseToolList('read, bash')).toEqual(['read', 'bash'])
    expect(parseToolList('read   bash\nedit')).toEqual(['read', 'bash', 'edit'])
    expect(parseToolList(' read ,, bash , ')).toEqual(['read', 'bash'])
  })

  it('returns null for an empty field (= the default coding tools)', () => {
    expect(parseToolList('')).toBeNull()
    expect(parseToolList('   ')).toBeNull()
    expect(parseToolList(' , , ')).toBeNull()
  })
})

describe('formatToolList', () => {
  it('round-trips an allowlist and renders null as blank', () => {
    expect(formatToolList(['read', 'bash'])).toBe('read, bash')
    expect(formatToolList(null)).toBe('')
  })
})

const CREW: CrewMemberSummary[] = [
  {
    id: 'h1',
    handle: 'dru',
    displayName: 'Dru',
    type: 'human',
    systemPrompt: null,
    tools: null,
    readContextFiles: true,
    useRepoSkills: true,
    extensionIds: [],
    model: null,
  },
  {
    id: 'a1',
    handle: 'tilde',
    displayName: 'Tilde',
    type: 'agent',
    systemPrompt: 'pilot the ship',
    tools: ['read', 'bash'],
    readContextFiles: false,
    useRepoSkills: false,
    extensionIds: [],
    model: null,
  },
]

const EXTENSIONS: ExtensionSummary[] = [
  { id: 'ext-1', name: 'build-gates', description: 'mirrors the git hooks' },
]

function renderView(props: Partial<AgentCrewProps> = {}) {
  const onCreate = vi.fn()
  const onUpdate = vi.fn()
  const onUpdateConfig = vi.fn()
  const onOpenMemory = vi.fn()
  const result = render(
    <AgentCrew
      crew={CREW}
      extensions={EXTENSIONS}
      modelOptions={[]}
      saving={false}
      onCreate={onCreate}
      onUpdate={onUpdate}
      onUpdateConfig={onUpdateConfig}
      onOpenMemory={onOpenMemory}
      {...props}
    />,
  )
  return { ...result, onCreate, onUpdate, onUpdateConfig, onOpenMemory }
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

  it('cancel discards the draft — reopening starts blank', () => {
    renderView()
    fireEvent.click(screen.getByText(/new agent/i))
    fireEvent.change(screen.getByPlaceholderText(/handle/i), {
      target: { value: 'scout' },
    })
    fireEvent.click(screen.getByText('Cancel'))
    fireEvent.click(screen.getByText(/new agent/i))
    expect(screen.getByPlaceholderText(/handle/i)).toHaveProperty('value', '')
  })

  it('opens an agent memory from the card', () => {
    const { onOpenMemory } = renderView()
    fireEvent.click(screen.getByText('Memory'))
    expect(onOpenMemory).toHaveBeenCalledWith('tilde')
  })

  it('config editor is collapsed by default and expands on demand', () => {
    renderView()
    expect(screen.queryByText('System prompt')).toBeNull()
    fireEvent.click(screen.getByText('Edit config'))
    expect(screen.getByText('System prompt')).toBeTruthy()
    fireEvent.click(screen.getByText('Hide config'))
    expect(screen.queryByText('System prompt')).toBeNull()
  })

  it('saves the full config together, with parsed tools and selected extensions', () => {
    const { onUpdateConfig } = renderView()
    fireEvent.click(screen.getByText('Edit config'))

    fireEvent.change(screen.getByPlaceholderText('You pilot a Skylark ship…'), {
      target: { value: 'be extra careful' },
    })
    fireEvent.click(screen.getByText('build-gates'))
    fireEvent.click(screen.getByText('Save config'))

    // The form sends raw text; the server normalizes (trims, folds blanks to
    // null). So a blank model field crosses the wire as an empty string here.
    expect(onUpdateConfig).toHaveBeenCalledWith({
      userId: 'a1',
      systemPrompt: 'be extra careful',
      tools: ['read', 'bash'],
      readContextFiles: false,
      useRepoSkills: false,
      extensionIds: ['ext-1'],
      model: '',
    })
  })

  it('toggles readContextFiles / useRepoSkills checkboxes', () => {
    const { onUpdateConfig } = renderView()
    fireEvent.click(screen.getByText('Edit config'))
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0]) // Read CLAUDE.md
    fireEvent.click(checkboxes[1]) // Load repo skills
    fireEvent.click(screen.getByText('Save config'))

    expect(onUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        readContextFiles: true,
        useRepoSkills: true,
      }),
    )
  })
})
