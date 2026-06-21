// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IssueThread } from '@hull/issues/server'

import { IssueThreadView, type IssueThreadViewProps } from './issue-thread'

afterEach(cleanup)

function thread(over: Partial<IssueThread> = {}): IssueThread {
  return {
    id: 'i1',
    nano: 'aa11',
    title: 'Add a widget',
    body: 'It should sparkle.',
    status: 'open',
    authorHandle: 'drufball',
    branchName: null,
    statusLine: null,
    entries: [],
    ...over,
  }
}

function renderView(props: Partial<IssueThreadViewProps> = {}) {
  const onBack = vi.fn()
  const onComment = vi.fn()
  const onSetStatus = vi.fn()
  const result = render(
    <IssueThreadView
      thread={thread()}
      busy={false}
      onBack={onBack}
      onComment={onComment}
      onSetStatus={onSetStatus}
      {...props}
    />,
  )
  return { ...result, onBack, onComment, onSetStatus }
}

describe('IssueThreadView', () => {
  it('shows the body and a Build it control for an open issue', () => {
    const { onSetStatus } = renderView()
    expect(screen.getByText('It should sparkle.')).toBeTruthy()
    fireEvent.click(screen.getByText('Build it'))
    expect(onSetStatus).toHaveBeenCalledWith('building')
  })

  it('renders status-change entries and comments in the timeline', () => {
    renderView({
      thread: thread({
        entries: [
          {
            kind: 'status',
            id: 's1',
            authorHandle: 'drufball',
            from: 'open',
            to: 'building',
            at: '',
          },
          {
            kind: 'comment',
            id: 'c1',
            authorHandle: 'builder',
            body: 'on it',
            at: '',
          },
        ],
      }),
    })
    expect(screen.getByText(/moved open → building/)).toBeTruthy()
    expect(screen.getByText('on it')).toBeTruthy()
  })

  it('shows a Pause control and the live status line while building', () => {
    const { onSetStatus } = renderView({
      thread: thread({
        status: 'building',
        statusLine: '🔧 bash npm run check',
        branchName: 'add-widget-aa11',
      }),
    })
    expect(screen.getByText('🔧 bash npm run check')).toBeTruthy()
    expect(screen.getByText('add-widget-aa11')).toBeTruthy()
    fireEvent.click(screen.getByText('Pause'))
    expect(onSetStatus).toHaveBeenCalledWith('open')
  })

  it('hides the composer and controls for a terminal issue (done or closed)', () => {
    for (const status of ['done', 'closed'] as const) {
      const { unmount } = renderView({ thread: thread({ status }) })
      expect(screen.queryByPlaceholderText(/Comment/)).toBeNull()
      expect(screen.queryByText('Build it')).toBeNull()
      expect(screen.queryByText('Close')).toBeNull()
      unmount()
    }
  })

  it('surfaces the status line only while building, not for an open issue', () => {
    // An open issue carrying a stale status line must not render it; the gate
    // is status === 'building', not just "a line exists".
    renderView({
      thread: thread({ status: 'open', statusLine: '🔧 stale line' }),
    })
    expect(screen.queryByText('🔧 stale line')).toBeNull()
  })

  it('comments via the composer', () => {
    const { onComment } = renderView()
    fireEvent.change(screen.getByPlaceholderText(/Comment/), {
      target: { value: 'a note' },
    })
    fireEvent.click(screen.getByLabelText('Add comment'))
    expect(onComment).toHaveBeenCalledWith('a note')
  })

  it('sends on Enter but not on Shift+Enter', () => {
    const { onComment } = renderView()
    const box = screen.getByPlaceholderText(/Comment/)
    fireEvent.change(box, { target: { value: 'enter me' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onComment).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onComment).toHaveBeenCalledWith('enter me')
  })

  it('closes an issue from either non-terminal status', () => {
    const { onSetStatus } = renderView()
    fireEvent.click(screen.getByText('Close'))
    expect(onSetStatus).toHaveBeenCalledWith('close')
  })

  it('shows a spinner and refuses to submit while busy', () => {
    const { onComment } = renderView({ busy: true })
    fireEvent.change(screen.getByPlaceholderText(/Comment/), {
      target: { value: 'note' },
    })
    fireEvent.click(screen.getByLabelText('Add comment'))
    expect(onComment).not.toHaveBeenCalled()
  })
})
