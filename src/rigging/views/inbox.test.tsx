// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { InboxItem } from '@hull/notifications/server'
import { InboxView, type InboxViewProps } from './inbox'

afterEach(cleanup)

function entry(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'n1',
    label: '@tilde opened "Fix the mast"',
    issueId: 'i1',
    at: '2026-07-02T12:00:00.000Z',
    read: false,
    ...over,
  }
}

function renderView(props: Partial<InboxViewProps> = {}) {
  const onMarkAllRead = vi.fn()
  const onOpenIssue = vi.fn()
  const result = render(
    <InboxView
      entries={[]}
      unread={0}
      busy={false}
      onMarkAllRead={onMarkAllRead}
      onOpenIssue={onOpenIssue}
      {...props}
    />,
  )
  return { ...result, onMarkAllRead, onOpenIssue }
}

describe('InboxView', () => {
  it('shows the caught-up empty state with mark-all-read disabled', () => {
    renderView()
    expect(screen.getByText(/all caught up/i)).toBeTruthy()
    expect(screen.getByText(/nothing yet/i)).toBeTruthy()
    expect(screen.getByText('Mark all read').closest('button')?.disabled).toBe(
      true,
    )
  })

  it('marks unread entries and counts them in the header', () => {
    renderView({
      entries: [entry(), entry({ id: 'n2', read: true, label: 'old news' })],
      unread: 1,
    })
    expect(screen.getByText(/1 unread/)).toBeTruthy()
    expect(screen.getAllByLabelText('unread')).toHaveLength(1)
  })

  it('opens the issue an entry concerns', () => {
    const { onOpenIssue } = renderView({ entries: [entry()], unread: 1 })
    fireEvent.click(screen.getByText('@tilde opened "Fix the mast"'))
    expect(onOpenIssue).toHaveBeenCalledWith('i1')
  })

  it('renders a non-issue entry as plain text, not a dead button', () => {
    const { onOpenIssue } = renderView({
      entries: [entry({ issueId: null, label: 'something elsewhere' })],
      unread: 1,
    })
    fireEvent.click(screen.getByText('something elsewhere'))
    expect(onOpenIssue).not.toHaveBeenCalled()
  })

  it('mark-all-read fires when there is something to clear', () => {
    const { onMarkAllRead } = renderView({ entries: [entry()], unread: 1 })
    fireEvent.click(screen.getByText('Mark all read'))
    expect(onMarkAllRead).toHaveBeenCalledTimes(1)
  })
})
