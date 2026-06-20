// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Dock, type DockLink } from './dock'

afterEach(cleanup)

// A stand-in for the router's Link — just an anchor — so the dock renders
// without a router.
const FakeLink: DockLink = ({ to, className, children }) => (
  <a href={to} className={className}>
    {children}
  </a>
)

describe('Dock', () => {
  it('renders the chat and issues links and the children', () => {
    render(
      <Dock active="issues" Link={FakeLink}>
        <p>surface</p>
      </Dock>,
    )
    expect(screen.getByText('Chat').closest('a')?.getAttribute('href')).toBe(
      '/',
    )
    expect(screen.getByText('Issues').closest('a')?.getAttribute('href')).toBe(
      '/issues',
    )
    expect(screen.getByText('surface')).toBeTruthy()
  })

  it('marks the agents slot as a disabled placeholder (no link)', () => {
    render(
      <Dock active="chat" Link={FakeLink}>
        <span />
      </Dock>,
    )
    const agents = screen.getByText('Agents')
    // The placeholder is not a navigating link.
    expect(agents.closest('a')).toBeNull()
    expect(agents.closest('[aria-disabled="true"]')).toBeTruthy()
  })

  it('flags the active section for assistive tech', () => {
    render(
      <Dock active="issues" Link={FakeLink}>
        <span />
      </Dock>,
    )
    expect(document.querySelector('[aria-current="page"]')).toBeTruthy()
  })
})
