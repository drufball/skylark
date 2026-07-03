// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ChatItem } from '@hull/agent/transcript'

import { AgentChatView, type AgentChatViewProps } from './agent-chat'
import { classTokensOf } from './test-support'

// jsdom has no layout engine, so the transcript's auto-scroll call is a no-op.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

function renderView(props: Partial<AgentChatViewProps> = {}) {
  const onSend = vi.fn()
  const onCancel = vi.fn()
  const onSelect = vi.fn()
  const result = render(
    <AgentChatView
      sessions={[]}
      items={[]}
      running={false}
      busy={false}
      emptyTitle="Session monitor"
      emptyHint="Pick a session to watch."
      onSend={onSend}
      onCancel={onCancel}
      onSelect={onSelect}
      {...props}
    />,
  )
  return { ...result, onSend, onCancel, onSelect }
}

describe('AgentChatView', () => {
  it('shows the empty-state copy with no active session', () => {
    renderView()
    expect(screen.getByText('Session monitor')).toBeDefined()
    expect(screen.getByText('Pick a session to watch.')).toBeDefined()
  })

  it('renders each kind of transcript item', () => {
    const items: ChatItem[] = [
      { kind: 'user', text: 'read the readme' },
      { kind: 'thinking', text: 'let me look' },
      {
        kind: 'toolCall',
        id: 't1',
        name: 'read',
        args: '{"path":"README.md"}',
      },
      { kind: 'toolResult', name: 'read', isError: false, text: 'contents' },
      { kind: 'assistant', text: 'here you go' },
    ]
    const { container } = renderView({ activeId: 's1', items })

    expect(container.textContent).toContain('read the readme')
    expect(container.textContent).toContain('let me look')
    expect(container.textContent).toContain('🔧 read')
    expect(container.textContent).toContain('contents')
    expect(container.textContent).toContain('here you go')
  })

  it('lists sessions, falls back to (untitled), and marks a running one', () => {
    const { container, onSelect } = renderView({
      sessions: [
        { id: 'a', title: 'first', status: 'idle' },
        { id: 'b', title: 'second', status: 'running' },
        { id: 'c', title: null, status: 'idle' },
      ],
      activeId: 'a',
    })

    // Sessions present → the "no conversations yet" placeholder is gone.
    expect(screen.queryByText(/no conversations yet/i)).toBeNull()
    expect(container.querySelector('.animate-spin')).not.toBeNull()
    expect(screen.getByText('(untitled)')).toBeDefined()
    fireEvent.click(screen.getByText('second'))
    expect(onSelect).toHaveBeenCalledWith('b')
  })

  it('highlights only the active session in the sidebar', () => {
    renderView({
      sessions: [
        { id: 'a', title: 'first', status: 'idle' },
        { id: 'b', title: 'second', status: 'idle' },
      ],
      activeId: 'a',
    })
    expect(classTokensOf('first', 'button')).toContain('bg-accent')
    expect(classTokensOf('second', 'button')).not.toContain('bg-accent')
  })

  it('marks an errored tool result distinctly', () => {
    const items: ChatItem[] = [
      { kind: 'toolResult', name: 'bash', isError: true, text: 'boom' },
    ]
    const { container } = renderView({ activeId: 's1', items })
    expect(container.querySelector('.text-destructive')).not.toBeNull()
    expect(container.textContent).toContain('boom')
  })

  it('marks an errored session in the sidebar', () => {
    const { container } = renderView({
      sessions: [{ id: 'a', title: 'broke', status: 'error' }],
    })
    expect(container.querySelector('.text-destructive')).not.toBeNull()
  })

  it('sends a trimmed message on Enter and clears the box', () => {
    const { onSend } = renderView({ activeId: 's1' })
    const box = screen.getByPlaceholderText(/message your first mate/i)

    fireEvent.change(box, { target: { value: '  hello  ' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('hello')
    expect((box as HTMLTextAreaElement).value).toBe('')
  })

  it('does not send on Shift+Enter', () => {
    const { onSend } = renderView({ activeId: 's1' })
    const box = screen.getByPlaceholderText(/message your first mate/i)

    fireEvent.change(box, { target: { value: 'multi' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('does not send blank messages', () => {
    const { onSend } = renderView({ activeId: 's1' })
    const box = screen.getByPlaceholderText(/message your first mate/i)

    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.keyDown(box, { key: 'Enter' })

    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows a stop button while running and cancels', () => {
    const { onCancel } = renderView({ activeId: 's1', running: true })
    fireEvent.click(screen.getByRole('button', { name: /stop the agent/i }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('surfaces an error message', () => {
    renderView({ activeId: 's1', error: 'overloaded' })
    expect(screen.getByText('overloaded')).toBeDefined()
  })
})
