// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AgentProfiles,
  type ExtensionSummary,
  formatToolList,
  parseToolList,
  type ProfileSummary,
} from './agent-profiles'
import { classTokensOf } from './test-support'

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

const EXTENSIONS: ExtensionSummary[] = [
  { id: 'ext-1', name: 'build-gates', description: 'mirrors the git hooks' },
]

const PROFILES: ProfileSummary[] = [
  {
    id: 'p-chat',
    name: 'chat',
    systemPrompt: 'pilot the ship',
    tools: ['read', 'bash'],
    readContextFiles: false,
    useRepoSkills: false,
    extensionIds: [],
    model: null,
  },
]

describe('AgentProfiles', () => {
  it('lists profiles and shows their tool summary', () => {
    render(
      <AgentProfiles
        profiles={PROFILES}
        extensions={EXTENSIONS}
        saving={false}
        onSave={vi.fn()}
      />,
    )
    expect(screen.getByText('chat')).toBeTruthy()
    expect(screen.getByText('read, bash')).toBeTruthy()
    // Profiles present → the "no profiles yet" placeholder is gone.
    expect(screen.queryByText(/no profiles yet/i)).toBeNull()
  })

  it('highlights the profile currently being edited', () => {
    const profiles: ProfileSummary[] = [
      { ...PROFILES[0], id: 'p-chat', name: 'chat' },
      { ...PROFILES[0], id: 'p-research', name: 'research' },
    ]
    render(
      <AgentProfiles
        profiles={profiles}
        extensions={EXTENSIONS}
        saving={false}
        onSave={vi.fn()}
      />,
    )
    // Nothing is highlighted until a profile is picked.
    expect(classTokensOf('chat', 'button')).not.toContain('bg-accent')
    fireEvent.click(screen.getByText('chat'))
    // Now the edited profile is highlighted, and only it.
    expect(classTokensOf('chat', 'button')).toContain('bg-accent')
    expect(classTokensOf('research', 'button')).not.toContain('bg-accent')
  })

  it('saves a new profile with parsed tools and selected extensions', () => {
    const onSave = vi.fn()
    render(
      <AgentProfiles
        profiles={PROFILES}
        extensions={EXTENSIONS}
        saving={false}
        onSave={onSave}
      />,
    )
    // The form defaults to "New profile" (no selection).
    fireEvent.change(screen.getByPlaceholderText('e.g. researcher'), {
      target: { value: 'researcher' },
    })
    fireEvent.change(screen.getByPlaceholderText('read, bash'), {
      target: { value: 'read, grep' },
    })
    fireEvent.click(screen.getByText('build-gates'))
    fireEvent.click(screen.getByText('Save profile'))

    expect(onSave).toHaveBeenCalledTimes(1)
    // The form sends raw text; the server normalizes (trims, folds blanks to
    // null). So blank fields cross the wire as empty strings here.
    expect(onSave).toHaveBeenCalledWith({
      name: 'researcher',
      systemPrompt: '',
      tools: ['read', 'grep'],
      readContextFiles: false,
      useRepoSkills: false,
      extensionIds: ['ext-1'],
      model: '',
    })
  })

  it('does not save without a name', () => {
    const onSave = vi.fn()
    render(
      <AgentProfiles
        profiles={[]}
        extensions={[]}
        saving={false}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByText('Save profile'))
    expect(onSave).not.toHaveBeenCalled()
  })

  it('clears via New and saves a fully-specified profile', () => {
    const onSave = vi.fn()
    render(
      <AgentProfiles
        profiles={PROFILES}
        extensions={EXTENSIONS}
        saving={false}
        onSave={onSave}
      />,
    )
    // Select an existing profile, then New must reset the form to blank.
    fireEvent.click(screen.getByText('chat'))
    fireEvent.click(screen.getByRole('button', { name: /new profile/i }))

    fireEvent.change(screen.getByPlaceholderText('e.g. researcher'), {
      target: { value: 'deep' },
    })
    fireEvent.change(screen.getByPlaceholderText('You pilot a Skylark ship…'), {
      target: { value: 'do research' },
    })
    fireEvent.change(screen.getByPlaceholderText('claude-sonnet-4-5'), {
      target: { value: 'claude-opus-4-5' },
    })
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0]) // Read CLAUDE.md
    fireEvent.click(checkboxes[1]) // Load repo skills
    fireEvent.click(screen.getByText('Save profile'))

    expect(onSave).toHaveBeenCalledWith({
      name: 'deep',
      systemPrompt: 'do research',
      tools: null,
      readContextFiles: true,
      useRepoSkills: true,
      extensionIds: [],
      model: 'claude-opus-4-5',
    })
  })

  it('shows a placeholder when no extensions are registered', () => {
    render(
      <AgentProfiles
        profiles={[]}
        extensions={[]}
        saving={false}
        onSave={vi.fn()}
      />,
    )
    expect(screen.getByText('None registered yet.')).toBeTruthy()
  })

  it('disables the form while a save is in flight', () => {
    render(
      <AgentProfiles
        profiles={[]}
        extensions={[]}
        saving={true}
        onSave={vi.fn()}
      />,
    )
    expect(screen.getByText('Saving…')).toBeTruthy()
  })

  it('loads an existing profile into the form when selected', () => {
    render(
      <AgentProfiles
        profiles={PROFILES}
        extensions={EXTENSIONS}
        saving={false}
        onSave={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByText('chat'))
    expect(screen.getByText('Edit chat')).toBeTruthy()
    // The system prompt seeded into the editable textarea.
    expect(screen.getByDisplayValue('pilot the ship')).toBeTruthy()
  })
})
