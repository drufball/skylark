// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Models, type ModelsProps } from './models'

afterEach(cleanup)

function props(overrides: Partial<ModelsProps> = {}): ModelsProps {
  return {
    defaultRef: 'ollama/qwen3-coder:30b',
    installed: [{ name: 'qwen3-coder:30b', sizeBytes: 19_000_000_000 }],
    catalog: [
      { model: 'qwen3:4b', minMemGB: 3, label: 'Qwen3 4B', notes: 'small' },
      {
        model: 'qwen3-coder:30b',
        minMemGB: 20,
        label: 'Qwen3-Coder 30B',
        notes: 'coder',
      },
    ],
    recommended: {
      model: 'qwen3-coder:30b',
      modelRef: 'ollama/qwen3-coder:30b',
      usableMemGB: 36,
      hardware: {
        platform: 'darwin',
        arch: 'arm64',
        totalMemGB: 51,
        isUnifiedMemory: true,
        cpuCount: 16,
      },
      fitsComfortably: true,
      reason: 'plenty of room',
    },
    providers: [
      {
        id: 'anthropic',
        label: 'Anthropic (Claude)',
        consoleUrl: 'https://console.anthropic.com',
        configured: true,
      },
      {
        id: 'openai',
        label: 'OpenAI (GPT)',
        consoleUrl: 'https://platform.openai.com/api-keys',
        configured: false,
      },
    ],
    pulling: [],
    onPull: vi.fn(),
    onSaveKey: vi.fn(),
    onRemoveKey: vi.fn(),
    ...overrides,
  }
}

describe('Models', () => {
  it('shows the default and an installed model as installed (no Pull)', () => {
    render(<Models {...props()} />)
    expect(screen.getByText('ollama/qwen3-coder:30b')).toBeTruthy()
    // The installed coder shows "installed", the un-installed 4B offers Pull.
    expect(screen.getAllByText(/installed/i).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /pull/i })).toBeTruthy()
  })

  it('pulls a model that is not installed', () => {
    const onPull = vi.fn()
    render(<Models {...props({ onPull })} />)
    fireEvent.click(screen.getByRole('button', { name: /pull/i }))
    expect(onPull).toHaveBeenCalledWith('qwen3:4b')
  })

  it('shows a spinner and disables the button while pulling', () => {
    render(<Models {...props({ pulling: ['qwen3:4b'] })} />)
    const btn = screen.getByRole('button', { name: /pulling/i })
    expect(btn.hasAttribute('disabled')).toBe(true)
  })

  it('marks a provider with a key configured and one without', () => {
    render(<Models {...props()} />)
    expect(screen.getByText(/key configured/i)).toBeTruthy()
    expect(screen.getByText(/^no key$/i)).toBeTruthy()
  })

  it('saves a key only when one is entered, then clears the field', () => {
    const onSaveKey = vi.fn()
    render(<Models {...props({ onSaveKey })} />)
    const input = screen.getByLabelText('OpenAI (GPT) API key')
    const saveBtn = input.parentElement?.querySelector('button')
    if (!saveBtn) throw new Error('no save button')
    expect(saveBtn.hasAttribute('disabled')).toBe(true) // empty → disabled
    fireEvent.change(input, { target: { value: 'sk-test' } })
    fireEvent.click(saveBtn)
    expect(onSaveKey).toHaveBeenCalledWith('openai', 'sk-test')
  })

  it('removes a configured provider key', () => {
    const onRemoveKey = vi.fn()
    render(<Models {...props({ onRemoveKey })} />)
    fireEvent.click(screen.getByText('Remove', { selector: 'button' }))
    expect(onRemoveKey).toHaveBeenCalledWith('anthropic')
  })
})
