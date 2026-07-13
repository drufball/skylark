// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BoardIssue } from '@hull/issues/server'

import { IssueBoardView, type IssueBoardViewProps } from './issue-board'

afterEach(cleanup)

function issue(over: Partial<BoardIssue> = {}): BoardIssue {
  return {
    id: 'i1',
    nano: 'aa11',
    title: 'Add a widget',
    status: 'open',
    authorHandle: 'drufball',
    commentCount: 0,
    statusLine: null,
    statusLineAt: null,
    awaitingBackground: false,
    sessionRunning: false,
    updatedAt: new Date().toISOString(),
    ...over,
  }
}

function renderView(props: Partial<IssueBoardViewProps> = {}) {
  const onOpen = vi.fn()
  const onSelect = vi.fn()
  const result = render(
    <IssueBoardView
      issues={[]}
      playbooks={[]}
      busy={false}
      onOpen={onOpen}
      onSelect={onSelect}
      {...props}
    />,
  )
  return { ...result, onOpen, onSelect }
}

describe('IssueBoardView', () => {
  it("fills its container height with its own clipped scroll, so a tall board can't drag the dock away with it", () => {
    const { container } = renderView()
    expect(container.firstElementChild?.className).toContain('h-full')
    expect(container.firstElementChild?.className).toContain('overflow-hidden')
    expect(
      container.querySelector('[data-slot="scroll-area"]')?.className,
    ).toContain('min-h-0')
  })

  it('invites the first issue when empty', () => {
    renderView()
    expect(screen.getByText(/No issues yet/i)).toBeTruthy()
  })

  it('groups by status with a count, hiding empty groups', () => {
    renderView({
      issues: [
        issue({ id: 'a', status: 'open', title: 'open one' }),
        issue({ id: 'b', status: 'building', title: 'build one' }),
      ],
    })
    expect(screen.getByText(/Open · 1/)).toBeTruthy()
    expect(screen.getByText(/Building · 1/)).toBeTruthy()
    // Statuses with no issues render no section header (group.length === 0).
    expect(screen.queryByText(/Done ·/)).toBeNull()
    expect(screen.queryByText(/Closed ·/)).toBeNull()
  })

  it('shows the status line only for a building issue', () => {
    renderView({
      issues: [
        // An open issue with a stale status line must not surface it…
        issue({
          id: 'a',
          status: 'open',
          title: 'open one',
          statusLine: 'stale',
        }),
        // …only the building issue's line shows.
        issue({
          id: 'b',
          status: 'building',
          title: 'build one',
          statusLine: 'running npm run check',
          statusLineAt: new Date().toISOString(),
          sessionRunning: true,
        }),
      ],
    })
    expect(screen.getByText('running npm run check')).toBeTruthy()
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('shows a waiting line (not a bare status line) when the session paused for a background job', () => {
    renderView({
      issues: [
        issue({
          id: 'a',
          status: 'building',
          title: 'waiting one',
          statusLine: '⏳ waiting on PR #12 CI…',
          statusLineAt: new Date().toISOString(),
          awaitingBackground: true,
          sessionRunning: false,
        }),
      ],
    })
    expect(screen.getByText('⏳ waiting on PR #12 CI…')).toBeTruthy()
  })

  it('shows an alarming "stalled" line — not the raw status line — once a session has gone silent too long', () => {
    const longAgo = new Date(Date.now() - 25 * 60_000).toISOString()
    renderView({
      issues: [
        issue({
          id: 'a',
          status: 'building',
          title: 'stalled one',
          statusLine: 'thinking…',
          statusLineAt: longAgo,
          awaitingBackground: false,
          sessionRunning: false,
        }),
      ],
    })
    expect(screen.getByText(/^⚠ stalled \d+m$/)).toBeTruthy()
    expect(screen.queryByText('thinking…')).toBeNull()
  })

  it('shows a comment count only when there are comments', () => {
    renderView({
      issues: [
        issue({ id: 'a', title: 'chatty', commentCount: 3 }),
        issue({ id: 'b', title: 'quiet', commentCount: 0 }),
      ],
    })
    expect(screen.getByText('3')).toBeTruthy()
    // A zero-comment issue shows no count badge.
    expect(screen.queryByText('0')).toBeNull()
  })

  it('selects an issue on click', () => {
    const { onSelect } = renderView({
      issues: [issue({ id: 'pick-me', title: 'pick me' })],
    })
    fireEvent.click(screen.getByText('pick me'))
    expect(onSelect).toHaveBeenCalledWith('pick-me')
  })

  it('opens a new issue from the composer, body and all', () => {
    const { onOpen } = renderView()
    fireEvent.click(screen.getByText('New issue'))
    fireEvent.change(screen.getByPlaceholderText('Title'), {
      target: { value: 'Brand new' },
    })
    fireEvent.change(screen.getByPlaceholderText(/Describe the work/), {
      target: { value: 'with detail' },
    })
    fireEvent.click(screen.getByText('Open issue'))
    // No playbooks offered → the ship default (undefined resolves to build).
    expect(onOpen).toHaveBeenCalledWith('Brand new', 'with detail', undefined)
  })

  it('files under a chosen playbook, defaulting to build', () => {
    const playbooks = [
      {
        id: 'p-build',
        name: 'build',
        description: 'Implement it.',
        isDefault: true,
      },
      {
        id: 'p-general',
        name: 'general',
        description: 'One agent, no script.',
        isDefault: false,
      },
    ]
    const { onOpen } = renderView({ playbooks })
    fireEvent.click(screen.getByText('New issue'))
    fireEvent.change(screen.getByPlaceholderText('Title'), {
      target: { value: 'Summarize the logs' },
    })
    fireEvent.change(screen.getByLabelText('Playbook'), {
      target: { value: 'p-general' },
    })
    fireEvent.click(screen.getByText('Open issue'))
    expect(onOpen).toHaveBeenCalledWith('Summarize the logs', '', 'p-general')

    // Left alone, the select means "build (default)" — no explicit id sent.
    fireEvent.click(screen.getByText('New issue'))
    fireEvent.change(screen.getByPlaceholderText('Title'), {
      target: { value: 'Fix the mast' },
    })
    fireEvent.click(screen.getByText('Open issue'))
    expect(onOpen).toHaveBeenLastCalledWith('Fix the mast', '', undefined)
  })

  it('will not open while busy even with a title', () => {
    const { onOpen } = renderView({ busy: true })
    fireEvent.click(screen.getByText('New issue'))
    fireEvent.change(screen.getByPlaceholderText('Title'), {
      target: { value: 'Has a title' },
    })
    fireEvent.click(screen.getByText('Open issue'))
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('cancels the composer without opening anything', () => {
    const { onOpen } = renderView()
    fireEvent.click(screen.getByText('New issue'))
    fireEvent.click(screen.getByText('Cancel'))
    expect(onOpen).not.toHaveBeenCalled()
    // Back to the collapsed state — the title field is gone.
    expect(screen.queryByPlaceholderText('Title')).toBeNull()
  })

  it('will not open a blank-title issue', () => {
    const { onOpen } = renderView()
    fireEvent.click(screen.getByText('New issue'))
    // With an empty title, the submit button does nothing (disabled + guarded).
    fireEvent.click(screen.getByText('Open issue'))
    expect(onOpen).not.toHaveBeenCalled()
  })
})
