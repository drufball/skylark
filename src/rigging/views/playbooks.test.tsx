// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  Playbooks,
  type PlaybookSummary,
  type PlaybooksProps,
} from './playbooks'

afterEach(cleanup)

const AGENTS = [
  { id: 'u-builder', handle: 'builder' },
  { id: 'u-hand', handle: 'hand' },
  { id: 'u-tilde', handle: 'tilde' },
]

function playbook(over: Partial<PlaybookSummary> = {}): PlaybookSummary {
  return {
    id: 'p1',
    name: 'build',
    description: 'Implement it.',
    memberIds: ['u-builder'],
    memberHandles: ['builder'],
    entrypointId: 'u-builder',
    entrypointHandle: 'builder',
    memberInstructions: {},
    ...over,
  }
}

function renderView(props: Partial<PlaybooksProps> = {}) {
  const onSave = vi.fn()
  const result = render(
    <Playbooks
      playbooks={[]}
      agents={AGENTS}
      saving={false}
      onSave={onSave}
      {...props}
    />,
  )
  return { ...result, onSave }
}

describe('Playbooks', () => {
  it('lists each playbook with its roster and entrypoint', () => {
    renderView({ playbooks: [playbook()] })
    expect(screen.getByText('build')).toBeDefined()
    expect(
      screen.getByText(/crew @builder · starts with @builder/),
    ).toBeDefined()
  })

  it('creates a playbook: pick crew, pick who starts, save', () => {
    const { onSave } = renderView()
    fireEvent.click(screen.getByText('New playbook'))
    fireEvent.change(screen.getByLabelText('Playbook name'), {
      target: { value: 'review' },
    })
    fireEvent.click(screen.getByLabelText('@hand'))
    fireEvent.click(screen.getByLabelText('@tilde'))
    fireEvent.change(screen.getByLabelText('Entrypoint agent'), {
      target: { value: 'u-hand' },
    })
    fireEvent.click(screen.getByText('Save playbook'))
    expect(onSave).toHaveBeenCalledWith({
      name: 'review',
      description: '',
      memberIds: ['u-hand', 'u-tilde'],
      entrypointId: 'u-hand',
      memberInstructions: {},
    })
  })

  it('sets a per-member role brief, trimmed, only for members on the roster', () => {
    const { onSave } = renderView()
    fireEvent.click(screen.getByText('New playbook'))
    fireEvent.change(screen.getByLabelText('Playbook name'), {
      target: { value: 'review' },
    })
    fireEvent.click(screen.getByLabelText('@hand'))
    fireEvent.change(screen.getByLabelText('Role for @hand on this playbook'), {
      target: { value: '  Review for security holes only.  ' },
    })
    fireEvent.change(screen.getByLabelText('Entrypoint agent'), {
      target: { value: 'u-hand' },
    })
    fireEvent.click(screen.getByText('Save playbook'))
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        memberInstructions: { 'u-hand': 'Review for security holes only.' },
      }),
    )
  })

  it('loads existing role briefs when editing a playbook', () => {
    renderView({
      playbooks: [
        playbook({ memberInstructions: { 'u-builder': 'lead the build' } }),
      ],
    })
    fireEvent.click(screen.getByText('build'))
    expect(
      screen.getByLabelText<HTMLTextAreaElement>(
        'Role for @builder on this playbook',
      ).value,
    ).toBe('lead the build')
  })

  it('cannot save without an entrypoint from the roster', () => {
    renderView()
    fireEvent.click(screen.getByText('New playbook'))
    fireEvent.change(screen.getByLabelText('Playbook name'), {
      target: { value: 'review' },
    })
    fireEvent.click(screen.getByLabelText('@hand'))
    // No entrypoint picked yet → disabled.
    expect(screen.getByText<HTMLButtonElement>('Save playbook').disabled).toBe(
      true,
    )
  })

  it('dropping the entrypoint from the crew clears the pick', () => {
    renderView()
    fireEvent.click(screen.getByText('New playbook'))
    fireEvent.click(screen.getByLabelText('@hand'))
    fireEvent.change(screen.getByLabelText('Entrypoint agent'), {
      target: { value: 'u-hand' },
    })
    fireEvent.click(screen.getByLabelText('@hand')) // un-check the entrypoint
    expect(
      screen.getByLabelText<HTMLSelectElement>('Entrypoint agent').value,
    ).toBe('')
  })

  it('editing an existing playbook locks the name — it is the upsert key', () => {
    renderView({ playbooks: [playbook()] })
    fireEvent.click(screen.getByText('build'))
    const name = screen.getByLabelText<HTMLInputElement>('Playbook name')
    expect(name.value).toBe('build')
    expect(name.disabled).toBe(true)
  })
})
