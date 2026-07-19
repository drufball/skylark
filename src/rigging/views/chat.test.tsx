// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  ChatView,
  type ChatViewProps,
  chatName,
  scheduleSummary,
  workingFromMembers,
} from './chat'
import { classTokensOf } from './test-support'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

function setWidth(width: number) {
  act(() => {
    window.innerWidth = width
    window.dispatchEvent(new Event('resize'))
  })
}
const originalWidth = window.innerWidth
afterEach(() => {
  setWidth(originalWidth)
})

describe('chatName', () => {
  it('uses the title, else the members, else a fallback', () => {
    expect(chatName({ title: 'design', memberHandles: ['a'] })).toBe('design')
    expect(chatName({ title: null, memberHandles: ['tilde', 'bix'] })).toBe(
      '@tilde, @bix',
    )
    expect(chatName({ title: null, memberHandles: [] })).toBe('New chat')
  })
})

describe('workingFromMembers', () => {
  it('is null when no member has a persisted progress line', () => {
    expect(
      workingFromMembers([
        { userId: 'a', handle: 'tilde', type: 'agent' },
        { userId: 'b', handle: 'dru', type: 'human' },
      ]),
    ).toBeNull()
  })

  it('is null when progressLine is explicitly null', () => {
    expect(
      workingFromMembers([
        { userId: 'a', handle: 'tilde', type: 'agent', progressLine: null },
      ]),
    ).toBeNull()
  })

  it('surfaces the handle + line of the member mid-turn', () => {
    expect(
      workingFromMembers([
        { userId: 'a', handle: 'tilde', type: 'agent', progressLine: null },
        {
          userId: 'b',
          handle: 'bix',
          type: 'agent',
          progressLine: 'using bash…',
        },
      ]),
    ).toEqual({ handle: 'bix', line: 'using bash…' })
  })
})

function renderView(props: Partial<ChatViewProps> = {}) {
  const handlers = {
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onSend: vi.fn(),
    onCreate: vi.fn(),
    onAddMember: vi.fn(),
    onRemoveMember: vi.fn(),
  }
  const result = render(
    <ChatView
      chats={[]}
      title={null}
      members={[]}
      messages={[]}
      working={null}
      crew={[]}
      composing={false}
      busy={false}
      {...handlers}
      {...props}
    />,
  )
  return { ...result, ...handlers }
}

describe('ChatView', () => {
  it('lists chats and selects one', () => {
    const { onSelect } = renderView({
      chats: [{ id: 'c1', title: null, memberHandles: ['tilde'] }],
    })
    // With chats present the "no chats yet" sidebar placeholder is gone.
    expect(screen.queryByText(/no chats yet/i)).toBeNull()
    fireEvent.click(screen.getByText('@tilde'))
    expect(onSelect).toHaveBeenCalledWith('c1')
  })

  it('highlights only the active chat in the list', () => {
    renderView({
      activeId: 'c1',
      chats: [
        { id: 'c1', title: null, memberHandles: ['tilde'] },
        { id: 'c2', title: null, memberHandles: ['bix'] },
      ],
    })
    // The active row carries the accent class; the inactive one does not.
    expect(classTokensOf('@tilde')).toContain('bg-accent')
    expect(classTokensOf('@bix')).not.toContain('bg-accent')
  })

  it('does not highlight any chat while composing a new one', () => {
    // composing wins over activeId: the list shows no selection. (zara is only
    // in the chat list, never the crew picker, so the lookup is unambiguous.)
    renderView({
      activeId: 'c1',
      composing: true,
      chats: [{ id: 'c1', title: null, memberHandles: ['zara'] }],
      crew: [{ id: 'a', handle: 'tilde', displayName: 'Tilde', type: 'agent' }],
    })
    expect(classTokensOf('@zara')).not.toContain('bg-accent')
  })

  it('renders messages, attributing only others (not mine)', () => {
    renderView({
      activeId: 'c1',
      members: [{ userId: 'a', handle: 'tilde', type: 'agent' }],
      messages: [
        { id: 'm1', authorHandle: 'dru', body: 'hi', mine: true },
        { id: 'm2', authorHandle: 'tilde', body: 'hello', mine: false },
      ],
    })
    expect(screen.getByText('hi')).toBeTruthy()
    expect(screen.getByText('hello')).toBeTruthy()
    // The other party is labelled (header chip + the message author line)…
    expect(screen.getAllByText('@tilde').length).toBeGreaterThan(0)
    // …but my own message is not prefixed with my handle.
    expect(screen.queryByText('@dru')).toBeNull()
  })

  it('shows a working placeholder for a mid-reply agent', () => {
    renderView({
      activeId: 'c1',
      working: { handle: 'tilde', line: 'thinking…' },
    })
    expect(screen.getByText('thinking…')).toBeTruthy()
  })

  it('sends a message from the composer', () => {
    const { onSend } = renderView({ activeId: 'c1' })
    const box = screen.getByPlaceholderText(/message/i)
    fireEvent.change(box, { target: { value: '  hey  ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hey')
  })

  it('composes a new chat by picking members (with toggle-off)', () => {
    const { onCreate } = renderView({
      composing: true,
      crew: [
        { id: 'a', handle: 'tilde', displayName: 'Tilde', type: 'agent' },
        { id: 'b', handle: 'bix', displayName: 'Bix', type: 'agent' },
        { id: 'c', handle: 'sam', displayName: 'Sam', type: 'human' },
      ],
    })
    fireEvent.change(screen.getByPlaceholderText(/title/i), {
      target: { value: 'planning' },
    })
    fireEvent.click(screen.getByText('@tilde')) // select
    fireEvent.click(screen.getByText('@tilde')) // deselect (toggle off)
    fireEvent.click(screen.getByText('@bix'))
    fireEvent.click(screen.getByText('Start chat'))
    expect(onCreate).toHaveBeenCalledWith(['b'], 'planning')
  })

  it('does not send on Shift+Enter', () => {
    const { onSend } = renderView({ activeId: 'c1' })
    const box = screen.getByPlaceholderText(/message/i)
    fireEvent.change(box, { target: { value: 'multi' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows the empty state with no chats and not composing', () => {
    renderView()
    expect(screen.getByText(/start a conversation/i)).toBeTruthy()
  })

  it('does not send a blank message', () => {
    const { onSend } = renderView({ activeId: 'c1' })
    const box = screen.getByPlaceholderText(/message/i)
    fireEvent.change(box, { target: { value: '   ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('disables Start chat until a member is picked', () => {
    const { onCreate } = renderView({
      composing: true,
      crew: [{ id: 'a', handle: 'tilde', displayName: 'Tilde', type: 'agent' }],
    })
    fireEvent.click(screen.getByText('Start chat'))
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('pins the view to exactly the viewport height with its own overflow, so the sidebar and content pane each scroll independently instead of the whole row dragging away', () => {
    const { container } = renderView()
    expect(container.firstElementChild?.className).toContain('h-full')
    expect(container.firstElementChild?.className).toContain('overflow-hidden')
    expect(container.querySelector('aside')?.className).toContain('min-h-0')
    expect(container.querySelector('section')?.className).toContain('min-h-0')
  })

  it('adds and removes members', () => {
    const { onAddMember, onRemoveMember } = renderView({
      activeId: 'c1',
      members: [{ userId: 'a', handle: 'tilde', type: 'agent' }],
      crew: [
        { id: 'a', handle: 'tilde', displayName: 'Tilde', type: 'agent' },
        { id: 'b', handle: 'bix', displayName: 'Bix', type: 'agent' },
      ],
    })
    fireEvent.change(screen.getByLabelText('Add member'), {
      target: { value: 'b' },
    })
    expect(onAddMember).toHaveBeenCalledWith('b')

    fireEvent.click(screen.getByLabelText('Remove tilde'))
    expect(onRemoveMember).toHaveBeenCalledWith('a')
  })

  it('on mobile, hides the chat list behind a trigger and opens it as a drawer', () => {
    setWidth(500)
    renderView({
      chats: [{ id: 'c1', title: null, memberHandles: ['tilde'] }],
    })
    expect(screen.queryByText('@tilde')).toBeNull()
    fireEvent.click(screen.getByLabelText(/open chats/i))
    expect(screen.getByText('@tilde')).toBeTruthy()
  })

  it('on mobile, selecting a chat closes the drawer', () => {
    setWidth(500)
    const { onSelect } = renderView({
      chats: [{ id: 'c1', title: null, memberHandles: ['tilde'] }],
    })
    fireEvent.click(screen.getByLabelText(/open chats/i))
    fireEvent.click(screen.getByText('@tilde'))
    expect(onSelect).toHaveBeenCalledWith('c1')
    expect(screen.queryByText('@tilde')).toBeNull()
  })

  it('on desktop, the chat list stays docked with no trigger', () => {
    setWidth(1024)
    renderView({
      chats: [{ id: 'c1', title: null, memberHandles: ['tilde'] }],
    })
    expect(screen.getByText('@tilde')).toBeTruthy()
    expect(screen.queryByLabelText(/open chats/i)).toBeNull()
  })

  it('shows no Schedules affordance without the schedule callbacks', () => {
    renderView({ activeId: 'c1' })
    expect(screen.queryByLabelText('Schedules')).toBeNull()
  })

  it('toggles the schedules panel and creates a recurring schedule', () => {
    const onCreateSchedule = vi.fn()
    renderView({
      activeId: 'c1',
      schedules: [],
      onCreateSchedule,
      onToggleSchedule: vi.fn(),
      onDeleteSchedule: vi.fn(),
    })
    fireEvent.click(screen.getByLabelText('Schedules'))
    fireEvent.change(screen.getByPlaceholderText('Message to schedule…'), {
      target: { value: 'stand up' },
    })
    fireEvent.change(screen.getByLabelText('Schedule mode'), {
      target: { value: 'repeat' },
    })
    fireEvent.change(screen.getByLabelText('Interval minutes'), {
      target: { value: '15' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add/i }))
    expect(onCreateSchedule).toHaveBeenCalledWith({
      body: 'stand up',
      intervalMinutes: 15,
    })
  })

  it('creates a one-shot schedule from a fire time', () => {
    const onCreateSchedule = vi.fn()
    renderView({
      activeId: 'c1',
      schedules: [],
      onCreateSchedule,
      onToggleSchedule: vi.fn(),
      onDeleteSchedule: vi.fn(),
    })
    fireEvent.click(screen.getByLabelText('Schedules'))
    fireEvent.change(screen.getByPlaceholderText('Message to schedule…'), {
      target: { value: 'launch' },
    })
    // Default mode is 'once'; give it a fire time and add.
    fireEvent.change(screen.getByLabelText('Fire time'), {
      target: { value: '2026-07-20T09:00' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add/i }))
    expect(onCreateSchedule).toHaveBeenCalledTimes(1)
    const arg = onCreateSchedule.mock.calls[0][0] as {
      body: string
      fireAt?: string
      intervalMinutes?: number
    }
    expect(arg.body).toBe('launch')
    expect(arg.intervalMinutes).toBeUndefined()
    expect(new Date(arg.fireAt ?? '').getMinutes()).toBe(0)
  })

  it('deletes a schedule from the panel', () => {
    const onDeleteSchedule = vi.fn()
    renderView({
      activeId: 'c1',
      schedules: [
        {
          id: 's1',
          authorHandle: 'dru',
          body: 'ping',
          enabled: true,
          intervalMinutes: 30,
          fireAt: null,
          nextFireAt: '2026-07-18T13:00:00.000Z',
        },
      ],
      onCreateSchedule: vi.fn(),
      onToggleSchedule: vi.fn(),
      onDeleteSchedule,
    })
    fireEvent.click(screen.getByLabelText('Schedules'))
    fireEvent.click(screen.getByLabelText('Delete schedule s1'))
    expect(onDeleteSchedule).toHaveBeenCalledWith('s1')
  })

  it('toggles a schedule on/off from the panel', () => {
    const onToggleSchedule = vi.fn()
    renderView({
      activeId: 'c1',
      schedules: [
        {
          id: 's1',
          authorHandle: 'dru',
          body: 'ping',
          enabled: true,
          intervalMinutes: 30,
          fireAt: null,
          nextFireAt: '2026-07-18T13:00:00.000Z',
        },
      ],
      onCreateSchedule: vi.fn(),
      onToggleSchedule,
      onDeleteSchedule: vi.fn(),
    })
    fireEvent.click(screen.getByLabelText('Schedules'))
    fireEvent.click(screen.getByLabelText('Disable schedule s1'))
    expect(onToggleSchedule).toHaveBeenCalledWith('s1', false)
  })
})

describe('scheduleSummary', () => {
  it('summarizes a recurring schedule with its cadence', () => {
    expect(
      scheduleSummary({
        intervalMinutes: 30,
        fireAt: null,
        nextFireAt: '2026-07-18T13:00:00.000Z',
      }),
    ).toContain('every 30 min')
  })

  it('summarizes a one-shot schedule', () => {
    expect(
      scheduleSummary({
        intervalMinutes: null,
        fireAt: '2026-07-18T13:00:00.000Z',
        nextFireAt: null,
      }),
    ).toContain('once')
  })
})
