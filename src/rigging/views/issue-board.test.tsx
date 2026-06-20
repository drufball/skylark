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
      busy={false}
      onOpen={onOpen}
      onSelect={onSelect}
      {...props}
    />,
  )
  return { ...result, onOpen, onSelect }
}

describe('IssueBoardView', () => {
  it('invites the first issue when empty', () => {
    renderView()
    expect(screen.getByText(/No issues yet/i)).toBeTruthy()
  })

  it('groups by status with a count, building issues showing the status line', () => {
    renderView({
      issues: [
        issue({ id: 'a', status: 'open', title: 'open one' }),
        issue({
          id: 'b',
          status: 'building',
          title: 'build one',
          statusLine: 'running npm run check',
        }),
      ],
    })
    expect(screen.getByText(/Open · 1/)).toBeTruthy()
    expect(screen.getByText(/Building · 1/)).toBeTruthy()
    expect(screen.getByText('running npm run check')).toBeTruthy()
  })

  it('shows a comment count when there are comments', () => {
    renderView({
      issues: [issue({ id: 'a', title: 'chatty', commentCount: 3 })],
    })
    expect(screen.getByText('3')).toBeTruthy()
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
    expect(onOpen).toHaveBeenCalledWith('Brand new', 'with detail')
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
