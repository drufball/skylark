// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Models, type ModelsData } from './models'

afterEach(cleanup)

function props(overrides: Partial<ModelsData> = {}): ModelsData {
  return {
    defaultRef: 'claude-sonnet-5',
    gateway: {
      ok: true,
      models: ['claude-sonnet-5', 'claude-haiku-4-5'],
    },
    ...overrides,
  }
}

describe('Models', () => {
  it('shows the default ref and lists the gateway models, tagging the default', () => {
    render(<Models {...props()} />)
    expect(screen.getAllByText('claude-sonnet-5').length).toBeGreaterThan(0)
    expect(screen.getByText('claude-haiku-4-5')).toBeDefined()
    expect(screen.getByText('default')).toBeDefined()
    expect(screen.getByText('reachable')).toBeDefined()
  })

  it('renders a down gateway as guidance, not an error', () => {
    render(<Models {...props({ gateway: { ok: false, models: [] } })} />)
    expect(screen.getByText('unreachable')).toBeDefined()
    expect(screen.getByText(/npm run gateway:up/)).toBeDefined()
  })

  it('does not tag a default the gateway happens not to list', () => {
    render(
      <Models
        {...props({ gateway: { ok: true, models: ['claude-haiku-4-5'] } })}
      />,
    )
    expect(screen.queryByText('default')).toBeNull()
  })
})
