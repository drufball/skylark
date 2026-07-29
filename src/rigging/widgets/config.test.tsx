// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hull/agent/server', () => ({ getDefaultModel: vi.fn() }))
vi.mock('@hull/issues/server', () => ({ listPlaybooksView: vi.fn() }))
vi.mock('@hull/users/server', () => ({ listCrew: vi.fn() }))
import { getDefaultModel } from '@hull/agent/server'
import { listPlaybooksView } from '@hull/issues/server'
import { listCrew } from '@hull/users/server'

import { configKind, configHeadline, crewLine, playbookLine } from './config'

afterEach(cleanup)
beforeEach(() => {
  vi.mocked(getDefaultModel).mockReset()
  vi.mocked(listPlaybooksView).mockReset()
  vi.mocked(listCrew).mockReset()
})

function parse(props: unknown) {
  const result = configKind.parse(props)
  if (!result.ok) throw new Error(`expected props to parse: ${result.detail}`)
  return result.view
}

function body(props: unknown = {}) {
  const { Body } = parse(props)
  return <Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />
}

describe('config: parsing', () => {
  it('accepts an empty blob — the whole ship, nothing filtered', () => {
    expect(parse({}).headline).toBe(configHeadline())
  })

  it('refuses a non-object blob', () => {
    expect(configKind.parse('nope')).toEqual({
      ok: false,
      detail: 'expected an object of props',
    })
  })

  it('carries no live topics of its own kind — every value it shows already lives elsewhere', () => {
    expect(parse({}).topics).toEqual([])
  })
})

describe('crewLine', () => {
  it('names an agent with a customized system prompt', () => {
    expect(
      crewLine({
        id: '1',
        handle: 'tilde',
        displayName: 'Tilde',
        type: 'agent',
        systemPrompt: 'custom',
      } as never),
    ).toBe('@tilde — custom prompt')
  })

  it('says "default" for an agent with no custom prompt', () => {
    expect(
      crewLine({
        id: '1',
        handle: 'keel',
        displayName: 'Keel',
        type: 'agent',
        systemPrompt: null,
      } as never),
    ).toBe('@keel — default')
  })
})

describe('playbookLine', () => {
  it('names the roster and marks the ship default', () => {
    expect(
      playbookLine({
        id: '1',
        name: 'build',
        memberHandles: ['builder', 'babysitter'],
        isDefault: true,
      } as never),
    ).toBe('build (default) — builder, babysitter')
  })

  it('leaves off the default marker for any other playbook', () => {
    expect(
      playbookLine({
        id: '2',
        name: 'general',
        memberHandles: ['hand'],
        isDefault: false,
      } as never),
    ).toBe('general — hand')
  })
})

describe('config: body', () => {
  it('shows the default model, playbooks, and crew personas once all three doors answer', async () => {
    vi.mocked(getDefaultModel).mockResolvedValue({ ref: 'claude-sonnet-5' })
    vi.mocked(listPlaybooksView).mockResolvedValue([
      {
        id: 'p1',
        name: 'build',
        description: '',
        memberIds: [],
        memberHandles: ['builder', 'babysitter'],
        entrypointId: 'e1',
        entrypointHandle: 'builder',
        memberInstructions: {},
        isDefault: true,
      },
    ])
    vi.mocked(listCrew).mockResolvedValue([
      {
        id: 'u1',
        handle: 'tilde',
        displayName: 'Tilde',
        type: 'agent',
        systemPrompt: null,
        tools: null,
        readContextFiles: false,
        useRepoSkills: false,
        extensionIds: [],
        model: null,
        createdAt: new Date(),
      },
    ] as never)

    render(body())

    await waitFor(() => {
      expect(screen.getByText('claude-sonnet-5')).toBeDefined()
    })
    expect(screen.getByText(/build \(default\)/)).toBeDefined()
    expect(screen.getByText(/@tilde/)).toBeDefined()
  })

  it('reads "just now" state before the doors answer', () => {
    vi.mocked(getDefaultModel).mockReturnValue(new Promise(() => undefined))
    vi.mocked(listPlaybooksView).mockReturnValue(new Promise(() => undefined))
    vi.mocked(listCrew).mockReturnValue(new Promise(() => undefined))
    render(body())
    expect(screen.getByText(/reading/i)).toBeDefined()
  })
})
