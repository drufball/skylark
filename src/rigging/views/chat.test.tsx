// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  ChatView,
  type ChatMemberItem,
  type ChatMsg,
  type ChatViewProps,
  chatName,
  composerPlaceholder,
  scheduleSummary,
  seenByHandles,
  workingFromMembers,
  workingLabel,
} from './chat'
import type { WidgetItem } from '@rigging/widgets/stack'
import { classTokensOf } from './test-support'

/** jsdom has no scrollIntoView; the thread calls it to stay at the newest message. */
const scrollIntoView = vi.fn()
beforeAll(() => {
  Element.prototype.scrollIntoView = scrollIntoView
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

describe('workingLabel', () => {
  it('reads as a state, never as a promise of a reply', () => {
    expect(workingLabel({ handle: 'tilde', line: 'using bash…' })).toBe(
      '@tilde is working — using bash…',
    )
    // Nothing in the copy may suggest a message is on its way: an agent posts
    // from inside its turn, so it may have spoken already or say nothing at all.
    expect(workingLabel({ handle: 'tilde', line: 'thinking…' })).not.toMatch(
      /typing|replying|will/i,
    )
  })
})

describe('seenByHandles', () => {
  const messages = [
    { id: 'm1', authorHandle: 'dru', body: 'one', mine: true },
    { id: 'm2', authorHandle: 'dru', body: 'two', mine: true },
  ]

  it('names an agent whose turn read the last message without answering', () => {
    expect(
      seenByHandles(
        [
          {
            userId: 'a',
            handle: 'tilde',
            type: 'agent',
            lastSeenMessageId: 'm2',
          },
        ],
        messages,
      ),
    ).toEqual(['tilde'])
  })

  it('says nothing about an agent still behind the conversation', () => {
    expect(
      seenByHandles(
        [
          {
            userId: 'a',
            handle: 'tilde',
            type: 'agent',
            lastSeenMessageId: 'm1',
          },
          { userId: 'b', handle: 'bix', type: 'agent' },
          {
            userId: 'c',
            handle: 'zip',
            type: 'agent',
            lastSeenMessageId: null,
          },
        ],
        messages,
      ),
    ).toEqual([])
  })

  it('never names a human, and never names the last speaker', () => {
    // A human's reading is their own business (no watermark is written for
    // them); an agent that spoke has already shown it read the thread.
    expect(
      seenByHandles(
        [
          {
            userId: 'a',
            handle: 'dru',
            type: 'human',
            lastSeenMessageId: 'm2',
          },
          {
            userId: 'b',
            handle: 'tilde',
            type: 'agent',
            lastSeenMessageId: 'm2',
          },
        ],
        [
          ...messages,
          { id: 'm3', authorHandle: 'tilde', body: 'here', mine: false },
        ],
      ),
    ).toEqual([])
  })

  it('is empty for an empty thread', () => {
    expect(
      seenByHandles(
        [
          {
            userId: 'a',
            handle: 'tilde',
            type: 'agent',
            lastSeenMessageId: 'm2',
          },
        ],
        [],
      ),
    ).toEqual([])
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

  it('shows a mid-turn agent as a status line, not a pending message', () => {
    renderView({
      activeId: 'c1',
      working: { handle: 'tilde', line: 'thinking…' },
    })
    const line = screen.getByTestId('agent-working')
    expect(line.textContent).toContain('@tilde is working — thinking…')
    // Not message-shaped: it is a state, not an envelope about to be filled in.
    expect(classTokensOf('@tilde is working — thinking…')).not.toContain(
      'rounded-2xl',
    )
  })

  it('shows a mid-turn agent even after it has already posted', () => {
    // The honest case the inversion creates: the agent said its piece from
    // inside its turn and kept working. The message and the working line must
    // coexist — that is correct, not a stuck bubble.
    renderView({
      activeId: 'c1',
      members: [{ userId: 'a', handle: 'tilde', type: 'agent' }],
      messages: [
        { id: 'm1', authorHandle: 'tilde', body: 'found it', mine: false },
      ],
      working: { handle: 'tilde', line: 'using bash…' },
    })
    expect(screen.getByText('found it')).toBeTruthy()
    expect(screen.getByTestId('agent-working').textContent).toContain(
      'using bash…',
    )
    // While something is in flight we don't also claim it has finished reading.
    expect(screen.queryByTestId('agent-seen')).toBeNull()
  })

  it('says an agent read the last message when it chose not to answer', () => {
    // Silence is deliberate: nothing is auto-posted in the agent's name, and the
    // thread states the one fact it has instead of looking broken.
    renderView({
      activeId: 'c1',
      members: [
        {
          userId: 'a',
          handle: 'tilde',
          type: 'agent',
          lastSeenMessageId: 'm1',
        },
      ],
      messages: [{ id: 'm1', authorHandle: 'dru', body: 'fyi', mine: true }],
    })
    expect(screen.getByTestId('agent-seen').textContent).toBe('Seen by @tilde')
  })

  it('says nothing about seeing when the agent answered', () => {
    renderView({
      activeId: 'c1',
      members: [
        {
          userId: 'a',
          handle: 'tilde',
          type: 'agent',
          lastSeenMessageId: 'm1',
        },
      ],
      messages: [
        { id: 'm1', authorHandle: 'dru', body: 'fyi', mine: true },
        { id: 'm2', authorHandle: 'tilde', body: 'noted', mine: false },
      ],
    })
    // Its own message is the receipt.
    expect(screen.queryByTestId('agent-seen')).toBeNull()
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

describe('composerPlaceholder', () => {
  const dru: ChatMemberItem = { userId: 'a', handle: 'dru', type: 'human' }
  const tilde: ChatMemberItem = { userId: 'b', handle: 'tilde', type: 'agent' }
  const bix: ChatMemberItem = { userId: 'c', handle: 'bix', type: 'agent' }

  it('never advises "Enter to send" — a thumb’s Enter is a newline', () => {
    for (const members of [
      [dru, tilde],
      [dru, tilde, bix],
    ]) {
      expect(composerPlaceholder(members)).not.toMatch(/enter/i)
    }
  })

  it('stays short enough for one line on a 390px phone', () => {
    // The old copy wrapped to three lines in a one-row textarea. The composer
    // is ~260px wide once the dock and the send button have their share.
    for (const members of [
      [dru, tilde],
      [dru, tilde, bix],
    ]) {
      expect(composerPlaceholder(members).length).toBeLessThanOrEqual(26)
    }
  })

  it('keeps the @mention hint only in a group, where it is true', () => {
    // In a 1:1 the agent always answers, so "@mention an agent" is wrong
    // information filling the whole field.
    expect(composerPlaceholder([dru, tilde])).toBe('Message…')
    expect(composerPlaceholder([dru, tilde, bix])).toBe(
      'Message… @mention an agent',
    )
    expect(
      composerPlaceholder([dru, { ...dru, userId: 'z', handle: 'pip' }]),
    ).toBe('Message… @mention an agent')
  })
})

describe('ChatView: the thread stays at the newest thing', () => {
  function msg(id: string): ChatMsg {
    return { id, authorHandle: 'dru', body: `m${id}`, mine: true }
  }

  it('scrolls to the bottom on load', () => {
    scrollIntoView.mockClear()
    renderView({ activeId: 'c1', messages: [msg('1')] })
    expect(scrollIntoView).toHaveBeenCalled()
  })

  it('scrolls again when a message lands — including your own widget answer', () => {
    // The front door never did this, so answering a widget could post your reply
    // somewhere you couldn't see it. The Agents transcript has always done it.
    const { rerender } = renderView({ activeId: 'c1', messages: [msg('1')] })
    scrollIntoView.mockClear()
    rerender(
      <ChatView
        chats={[]}
        activeId="c1"
        title={null}
        members={[]}
        messages={[msg('1'), msg('2')]}
        working={null}
        crew={[]}
        composing={false}
        busy={false}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onSend={vi.fn()}
        onCreate={vi.fn()}
        onAddMember={vi.fn()}
        onRemoveMember={vi.fn()}
      />,
    )
    expect(scrollIntoView).toHaveBeenCalled()
  })
})

/** A choice widget as the loader hands it over. */
function choiceWidget(over: Partial<WidgetItem> = {}): WidgetItem {
  return {
    id: 'w1',
    kind: 'choice',
    props: { question: 'Ship the new theme?', options: ['Yes', 'No'] },
    createdByHandle: 'tilde',
    ...over,
  }
}

// The view's half of the widget shelf is only WIRING: is the band there, and do
// its callbacks reach the host? What each kind renders, the honest tiles, the
// live subscription and the tap targets belong to the shelf itself and are
// tested in rigging/widgets/stack.test.tsx — this view knows no kind by name.
describe('ChatView widget stack', () => {
  it('shows nothing at all when there are no widgets', () => {
    // Both callbacks wired, so an EMPTY list is the only reason the band is
    // gone — no chrome for a shelf with nothing on it.
    renderView({
      activeId: 'c1',
      widgets: [],
      onAnswerWidget: vi.fn(),
      onDismissWidget: vi.fn(),
    })
    expect(screen.queryByTestId('widget-stack')).toBeNull()
  })

  it('shows no stack without the widget callbacks, even with widgets', () => {
    renderView({ activeId: 'c1', widgets: [choiceWidget()] })
    expect(screen.queryByTestId('widget-stack')).toBeNull()
  })

  it('hands the shelf its widgets, in the order given', () => {
    renderView({
      activeId: 'c1',
      widgets: [
        choiceWidget({
          id: 'w1',
          props: { question: 'First?', options: ['Ok'] },
        }),
        choiceWidget({
          id: 'w2',
          props: { question: 'Second?', options: ['Ok'] },
        }),
      ],
      onAnswerWidget: vi.fn(),
      onDismissWidget: vi.fn(),
    })
    expect(
      screen.getAllByTestId('widget-headline').map((h) => h.textContent),
    ).toEqual(['First?', 'Second?'])
  })

  it('passes an answer back up to the host', () => {
    const onAnswerWidget = vi.fn()
    renderView({
      activeId: 'c1',
      widgets: [choiceWidget()],
      onAnswerWidget,
      onDismissWidget: vi.fn(),
    })
    fireEvent.click(screen.getByLabelText('Open widget w1'))
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(onAnswerWidget).toHaveBeenCalledWith('w1', 'No')
  })

  it('passes a dismissal back up to the host', () => {
    const onDismissWidget = vi.fn()
    renderView({
      activeId: 'c1',
      widgets: [choiceWidget()],
      onAnswerWidget: vi.fn(),
      onDismissWidget,
    })
    fireEvent.click(screen.getByLabelText('Dismiss widget w1'))
    expect(onDismissWidget).toHaveBeenCalledWith('w1')
  })

  it('sits between the thread and the composer, where your thumb already is', () => {
    const { container } = renderView({
      activeId: 'c1',
      widgets: [choiceWidget()],
      onAnswerWidget: vi.fn(),
      onDismissWidget: vi.fn(),
    })
    const order = [...container.querySelectorAll('[data-testid], textarea')]
      .map((el) => el.getAttribute('data-testid') ?? el.tagName.toLowerCase())
      .filter((name) => name === 'widget-stack' || name === 'textarea')
    expect(order).toEqual(['widget-stack', 'textarea'])
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
