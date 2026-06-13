// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ShipStatus } from './ship-status'

// Covers the route → view wiring's destination: the view renders correctly for
// both branches of the ShipHealth union it's handed.
describe('ShipStatus', () => {
  it('shows the database up, with a healthy dot', () => {
    const { container } = render(<ShipStatus health={{ db: 'up' }} />)

    expect(container.textContent).toContain('database: up')
    expect(container.querySelector('.bg-emerald-500')).not.toBeNull()
    expect(container.textContent).not.toContain('asleep')
  })

  it('shows the database down, with a destructive dot', () => {
    const { container } = render(
      <ShipStatus health={{ db: 'down', error: 'the ship is asleep' }} />,
    )

    expect(container.textContent).toContain('database: down')
    expect(container.querySelector('.bg-destructive')).not.toBeNull()
    expect(container.textContent).toContain('npm run db:up')
  })
})
