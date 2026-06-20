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
    expect(onSave).toHaveBeenCalledWith({
      name: 'researcher',
      systemPrompt: null,
      tools: ['read', 'grep'],
      readContextFiles: false,
      useRepoSkills: false,
      extensionIds: ['ext-1'],
      model: null,
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
