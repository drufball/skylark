// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { Dock, type DockLink } from './dock'
import { classTokensOf } from './test-support'

afterEach(cleanup)

// A stand-in for the router's Link — just an anchor — so the dock renders
// without a router.
const FakeLink: DockLink = ({ to, className, children }) => (
  <a href={to} className={className}>
    {children}
  </a>
)

describe('Dock', () => {
  it('renders the chat, issues, and agents links and the children', () => {
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
    expect(screen.getByText('Agents').closest('a')?.getAttribute('href')).toBe(
      '/agents',
    )
    expect(screen.getByText('surface')).toBeTruthy()
  })

  it('flags only the active section for assistive tech', () => {
    render(
      <Dock active="issues" Link={FakeLink}>
        <span />
      </Dock>,
    )
    const link = (text: string) => screen.getByText(text).closest('a')
    // Exactly the active link carries aria-current=page.
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
    expect(link('Issues')?.querySelector('[aria-current="page"]')).toBeTruthy()
    expect(link('Chat')?.querySelector('[aria-current="page"]')).toBeNull()
  })

  it('highlights only the active section', () => {
    render(
      <Dock active="issues" Link={FakeLink}>
        <span />
      </Dock>,
    )
    expect(classTokensOf('Issues', 'a')).toContain('bg-accent')
    expect(classTokensOf('Chat', 'a')).not.toContain('bg-accent')
  })
})
