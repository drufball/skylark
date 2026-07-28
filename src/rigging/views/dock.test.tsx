// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Dock, RAIL, type DockLink } from './dock'
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
  it('renders the four permanent rail links and the children', () => {
    render(
      <Dock active="home" Link={FakeLink} onLogout={() => undefined}>
        <p>surface</p>
      </Dock>,
    )
    const href = (label: string) =>
      screen.getByText(label).closest('a')?.getAttribute('href')
    expect(href('Home')).toBe('/')
    expect(href('Chats')).toBe('/chat')
    expect(href('Crew')).toBe('/agents')
    expect(href('Models')).toBe('/models')
    expect(screen.getByText('surface')).toBeTruthy()
  })

  /**
   * The correctness requirement of the whole slice. Navigation became DATA —
   * the chats you're in, the pages you made — and data can be deleted, so a
   * crew member can arrange their way into a corner where "where's my inbox?"
   * has no answer. The rail is the answer: it is hardcoded, it is on every
   * surface, and it does not consult a single row. A home with no pages and no
   * tiles still reaches every part of the ship.
   */
  it('still reaches every part of the ship when the home canvas is empty', () => {
    render(
      <Dock active="home" Link={FakeLink} onLogout={() => undefined}>
        {/* An empty home: no pages, no tiles, nothing to navigate by. */}
        <div data-testid="empty-home" />
      </Dock>,
    )
    const reachable = [...document.querySelectorAll('nav a')].map((a) =>
      a.getAttribute('href'),
    )
    for (const item of RAIL) expect(reachable).toContain(item.to)
    // And the way back OUT of the ship is here too, for the same reason.
    expect(screen.getByText('Log out')).toBeTruthy()
  })

  it('marks Chats active on the chat surface', () => {
    render(
      <Dock active="chats" Link={FakeLink} onLogout={() => undefined}>
        <span />
      </Dock>,
    )
    const link = screen.getByText('Chats').closest('a')
    expect(link?.querySelector('[aria-current="page"]')).toBeTruthy()
    expect(classTokensOf('Chats', 'a')).toContain('bg-accent')
  })

  it('flags only the active section for assistive tech', () => {
    render(
      <Dock active="chats" Link={FakeLink} onLogout={() => undefined}>
        <span />
      </Dock>,
    )
    const link = (text: string) => screen.getByText(text).closest('a')
    // Exactly the active link carries aria-current=page.
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
    expect(link('Chats')?.querySelector('[aria-current="page"]')).toBeTruthy()
    expect(link('Home')?.querySelector('[aria-current="page"]')).toBeNull()
  })

  /**
   * Issues, Files and Inbox left the rail when they got rooms, but their views
   * are still routes you can be standing on. Highlighting nothing is the honest
   * answer there — pretending one of the four is active would point somewhere
   * you aren't.
   */
  it('highlights nothing on a surface that has no rail entry', () => {
    render(
      <Dock Link={FakeLink} onLogout={() => undefined}>
        <span />
      </Dock>,
    )
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(0)
    expect(classTokensOf('Home', 'a')).not.toContain('bg-accent')
  })

  it('calls onLogout when the log-out control is clicked', () => {
    const onLogout = vi.fn()
    render(
      <Dock active="home" Link={FakeLink} onLogout={onLogout}>
        <span />
      </Dock>,
    )
    fireEvent.click(screen.getByText('Log out'))
    expect(onLogout).toHaveBeenCalledOnce()
  })

  /**
   * On a phone the rail is a bottom bar, not a 64px column stolen from a 390px
   * screen — the same call every phone OS makes, and it puts the ship's
   * navigation under the thumb that's holding it. One element, two layouts, in
   * CSS rather than a `useIsMobile` branch: the rail must be on screen from the
   * very first paint, and a measured breakpoint isn't known until after mount.
   */
  it('lays the rail out along the bottom on a phone and down the side on a desktop', () => {
    const { container } = render(
      <Dock active="home" Link={FakeLink} onLogout={() => undefined}>
        <span />
      </Dock>,
    )
    const shell = container.querySelector('nav')?.parentElement
    expect(shell?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['flex-col-reverse', 'md:flex-row']),
    )
    const nav = container.querySelector('nav')?.className.split(/\s+/)
    // Across the bottom by default; a column at the side from `md` up.
    expect(nav).toEqual(
      expect.arrayContaining(['flex-row', 'md:w-16', 'md:flex-col']),
    )
  })

  /** A thumb needs 44px, and the rail is the control it reaches for most. */
  it('gives every rail target a thumb-sized floor', () => {
    render(
      <Dock active="home" Link={FakeLink} onLogout={() => undefined}>
        <span />
      </Dock>,
    )
    for (const label of [...RAIL.map((i) => i.label), 'Log out']) {
      expect(classTokensOf(label, 'a, button')).toContain('min-h-14')
    }
  })

  it('pins the shell to exactly the viewport height with no page-level scroll', () => {
    const { container } = render(
      <Dock active="home" Link={FakeLink} onLogout={() => undefined}>
        <span />
      </Dock>,
    )
    // The outer row is exactly the viewport height (not a min-height), and
    // clips instead of letting a tall child drag the whole row down the page —
    // each side is responsible for its own internal scroll instead.
    const root = container.firstElementChild
    expect(root?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['h-screen', 'overflow-hidden']),
    )
    // The slot the active surface mounts into can't be pushed taller than the
    // row by its content — min-h-0 is what makes a flex child's own overflow
    // stay inside it rather than expanding the row past 100vh.
    const slot = container.querySelector('nav')?.nextElementSibling
    expect(slot?.className.split(/\s+/)).toContain('min-h-0')
  })

  /**
   * `/issues`, `/files` and `/inbox` left the rail for their rooms, and for one
   * slice they were a one-way door — the room linked in and nothing linked out,
   * so the only way back was the browser's own back button. That isn't
   * navigation, and it strands anybody who arrived by URL or by a link an agent
   * posted. The shell carries the way back, so all three get it identically.
   */
  it('carries a way back to the room a surface belongs to', () => {
    render(
      <Dock
        Link={FakeLink}
        onLogout={() => undefined}
        room={{ to: '/chat?chat=room-issues', label: 'Issues room' }}
      >
        <span />
      </Dock>,
    )
    const back = screen.getByText('Issues room').closest('a')
    expect(back?.getAttribute('href')).toBe('/chat?chat=room-issues')
    // A thumb target: it's the only way out of the surface on a phone.
    expect(classTokensOf('Issues room', 'a')).toContain('min-h-11')
  })

  it('draws no way back on a surface that is nobody’s room', () => {
    const { container } = render(
      <Dock active="models" Link={FakeLink} onLogout={() => undefined}>
        <span />
      </Dock>,
    )
    // Only the rail's own links — nothing extra above the surface.
    expect(container.querySelectorAll('a')).toHaveLength(RAIL.length)
  })

  it('renders nothing about staleness when behindOrigin is undefined, null, or 0', () => {
    for (const behindOrigin of [undefined, null, 0]) {
      const { container, unmount } = render(
        <Dock
          active="home"
          Link={FakeLink}
          onLogout={() => undefined}
          behindOrigin={behindOrigin}
        >
          <span />
        </Dock>,
      )
      expect(container.textContent).not.toContain('behind origin')
      unmount()
    }
  })

  it('shows the staleness banner when behind origin by one or more commits', () => {
    render(
      <Dock
        active="home"
        Link={FakeLink}
        onLogout={() => undefined}
        behindOrigin={3}
      >
        <span />
      </Dock>,
    )
    expect(screen.getByText(/ship is 3 commits behind origin/)).toBeTruthy()
  })

  it('singularizes the count for exactly one commit behind', () => {
    render(
      <Dock
        active="home"
        Link={FakeLink}
        onLogout={() => undefined}
        behindOrigin={1}
      >
        <span />
      </Dock>,
    )
    expect(screen.getByText(/ship is 1 commit behind origin/)).toBeTruthy()
  })
})
