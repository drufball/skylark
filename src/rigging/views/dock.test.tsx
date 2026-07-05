// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  it('renders the chat, issues, files, agents, and models links and the children', () => {
    render(
      <Dock active="issues" Link={FakeLink} onLogout={() => undefined}>
        <p>surface</p>
      </Dock>,
    )
    expect(screen.getByText('Chat').closest('a')?.getAttribute('href')).toBe(
      '/',
    )
    expect(screen.getByText('Issues').closest('a')?.getAttribute('href')).toBe(
      '/issues',
    )
    expect(screen.getByText('Files').closest('a')?.getAttribute('href')).toBe(
      '/files',
    )
    expect(screen.getByText('Inbox').closest('a')?.getAttribute('href')).toBe(
      '/inbox',
    )
    expect(screen.getByText('Agents').closest('a')?.getAttribute('href')).toBe(
      '/agents',
    )
    expect(screen.getByText('Models').closest('a')?.getAttribute('href')).toBe(
      '/models',
    )
    expect(screen.getByText('surface')).toBeTruthy()
  })

  it('marks Files active on the files surface', () => {
    render(
      <Dock active="files" Link={FakeLink} onLogout={() => undefined}>
        <span />
      </Dock>,
    )
    const link = screen.getByText('Files').closest('a')
    expect(link?.querySelector('[aria-current="page"]')).toBeTruthy()
    expect(classTokensOf('Files', 'a')).toContain('bg-accent')
  })

  it('flags only the active section for assistive tech', () => {
    render(
      <Dock active="issues" Link={FakeLink} onLogout={() => undefined}>
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
      <Dock active="issues" Link={FakeLink} onLogout={() => undefined}>
        <span />
      </Dock>,
    )
    expect(classTokensOf('Issues', 'a')).toContain('bg-accent')
    expect(classTokensOf('Chat', 'a')).not.toContain('bg-accent')
  })

  it('calls onLogout when the log-out control is clicked', () => {
    const onLogout = vi.fn()
    render(
      <Dock active="issues" Link={FakeLink} onLogout={onLogout}>
        <span />
      </Dock>,
    )
    fireEvent.click(screen.getByText('Log out'))
    expect(onLogout).toHaveBeenCalledOnce()
  })
})
