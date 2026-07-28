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
  emptyThreadLine,
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

  it('starts a chat from the empty state itself', () => {
    // On a phone the sidebar's New button is inside a closed drawer, so copy
    // that said "New to begin" pointed at a control that wasn't on the screen.
    setWidth(390)
    const { onNew } = renderView()
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(onNew).toHaveBeenCalled()
  })

  it('says what a fresh chat is for instead of showing a blank thread', () => {
    // Every other surface here has an empty state (the chat list, the canvas, a
    // canvas page); a brand-new thread had none, so the first thing a new crew
    // member saw was a void that reads as a broken ship.
    renderView({
      activeId: 'c1',
      members: [{ userId: 'a', handle: 'tilde', type: 'agent' }],
      messages: [],
    })
    expect(screen.getByTestId('thread-empty')).toBeTruthy()
  })

  it('drops the empty-thread state the moment anything is said', () => {
    renderView({
      activeId: 'c1',
      messages: [{ id: 'm1', authorHandle: 'dru', body: 'hi', mine: true }],
    })
    expect(screen.queryByTestId('thread-empty')).toBeNull()
  })

  it('folds the member roster away on a phone', () => {
    // Title, the Thread/Canvas toggle, Schedules and a chip per member wrapped
    // to four rows on a 390px screen — a quarter of the phone spent on chrome
    // before the conversation got a pixel.
    setWidth(390)
    renderView({
      activeId: 'c1',
      members: [{ userId: 'a', handle: 'tilde', type: 'agent' }],
    })
    expect(screen.queryByLabelText('Remove tilde')).toBeNull()
    fireEvent.click(screen.getByLabelText('More'))
    expect(screen.getByLabelText('Remove tilde')).toBeTruthy()
  })

  it('keeps the roster in the header on a desktop pane, where it fits', () => {
    setWidth(1280)
    renderView({
      activeId: 'c1',
      members: [{ userId: 'a', handle: 'tilde', type: 'agent' }],
    })
    expect(screen.getByLabelText('Remove tilde')).toBeTruthy()
    expect(screen.queryByLabelText('More')).toBeNull()
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
    answerValue: null,
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
    fireEvent.click(screen.getByLabelText('Open Ship the new theme?'))
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
    fireEvent.click(screen.getByLabelText('Dismiss Ship the new theme?'))
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

describe('emptyThreadLine', () => {
  it('tells a chat that has an agent in it what the agent can do', () => {
    // The blank screen is the one moment somebody will read an explanation of
    // the two surfaces, so it's the one place worth spending it.
    const line = emptyThreadLine([
      { userId: 'a', handle: 'dru', type: 'human' },
      { userId: 'b', handle: 'tilde', type: 'agent' },
    ])
    expect(line).toContain('canvas')
  })

  it('promises nothing about agents in a chat that has none', () => {
    const line = emptyThreadLine([
      { userId: 'a', handle: 'dru', type: 'human' },
    ])
    expect(line).not.toContain('agent')
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

describe('ChatView: the canvas lives inside the chat', () => {
  /** A chat with a canvas wired up, one page, one tile on it. */
  function withCanvas(props: Partial<ChatViewProps> = {}) {
    return renderView({
      activeId: 'c1',
      members: [{ userId: 'u1', handle: 'dru', type: 'human' }],
      canvasPages: [{ id: 'p1', title: 'Ops' }],
      canvasWidgets: [
        {
          id: 'w1',
          kind: 'note',
          props: { text: 'deploys today' },
          createdByHandle: 'tilde',
          answerValue: null,
          pageId: 'p1',
          gridX: 0,
          gridY: 0,
          gridW: 2,
          gridH: 2,
        },
      ],
      activePageId: 'p1',
      onSelectPage: vi.fn(),
      onNewPage: vi.fn(),
      onRenamePage: vi.fn(),
      onRemovePage: vi.fn(),
      onPlaceWidget: vi.fn(),
      onStackWidget: vi.fn(),
      onAnswerWidget: vi.fn(),
      onDismissWidget: vi.fn(),
      ...props,
    })
  }

  it('shows the canvas BESIDE the thread on a desktop pane', () => {
    // Not a destination, not a third route: you never leave the conversation to
    // look at the thing you built.
    setWidth(1280)
    withCanvas({
      messages: [{ id: 'm1', authorHandle: 'dru', body: 'hi', mine: true }],
    })
    expect(screen.getByText('hi')).toBeTruthy()
    expect(screen.getByTestId('widget-canvas')).toBeTruthy()
  })

  it('keeps the whole width for the thread in a chat with no canvas yet', () => {
    setWidth(1280)
    withCanvas({ canvasPages: [], canvasWidgets: [] })
    expect(screen.queryByTestId('widget-canvas')).toBeNull()
    // …and the header still offers it, so the surface is discoverable.
    fireEvent.click(screen.getByLabelText('Canvas'))
    expect(screen.getByTestId('widget-canvas')).toBeTruthy()
  })

  it('hides the desktop pane again when you toggle it off', () => {
    setWidth(1280)
    withCanvas()
    expect(screen.getByTestId('widget-canvas')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Canvas'))
    expect(screen.queryByTestId('widget-canvas')).toBeNull()
  })

  it('toggles between Thread and Canvas on a phone, never stranding either', () => {
    // 390px can't hold both. What it must never do is hide the way back.
    setWidth(390)
    withCanvas({
      messages: [{ id: 'm1', authorHandle: 'dru', body: 'hi', mine: true }],
    })
    expect(screen.getByText('hi')).toBeTruthy()
    expect(screen.queryByTestId('widget-canvas')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'canvas' }))
    expect(screen.getByTestId('widget-canvas')).toBeTruthy()
    expect(screen.queryByText('hi')).toBeNull()
    // The way back is on screen the whole time.
    fireEvent.click(screen.getByRole('button', { name: 'thread' }))
    expect(screen.getByText('hi')).toBeTruthy()
  })

  it('keeps the composer under the canvas on a phone', () => {
    // The thesis of the whole slice: the agent is right there beside the thing
    // you built, so you can say "what's this?" without navigating away.
    setWidth(390)
    withCanvas()
    fireEvent.click(screen.getByRole('button', { name: 'canvas' }))
    expect(screen.getByPlaceholderText('Message…')).toBeTruthy()
  })

  it('shows a stack widget and a canvas widget at the same time', () => {
    setWidth(1280)
    withCanvas({
      widgets: [
        {
          id: 'w2',
          kind: 'choice',
          props: { question: 'Ship it?', options: ['Yes', 'No'] },
          createdByHandle: 'tilde',
          answerValue: null,
        },
      ],
    })
    expect(screen.getByTestId('widget-stack')).toBeTruthy()
    expect(screen.getByTestId('widget-canvas')).toBeTruthy()
  })

  it('gives a phone’s canvas the whole screen, and counts what’s waiting in the thread', () => {
    // The shelf is turn-shaped and belongs with the thread. Left under the
    // canvas it took a quarter of a 390px screen off the surface you switched
    // to on purpose — so it goes with the thread, and the way back carries the
    // count so nothing an agent asked for goes quiet.
    setWidth(390)
    withCanvas({ widgets: [choiceWidget({ id: 'w2' })] })
    expect(screen.getByTestId('widget-stack')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'canvas' }))
    expect(screen.queryByTestId('widget-stack')).toBeNull()
    expect(screen.getByLabelText('Thread — 1 waiting')).toBeTruthy()
  })

  it('keeps the working line in sight when a phone is on the canvas', () => {
    // The status line lives in the thread, and on a phone the canvas replaces
    // the thread — so an agent mid-turn went completely silent on the device
    // this whole feature is aimed at.
    setWidth(390)
    withCanvas({ working: { handle: 'tilde', line: 'using bash…' } })
    fireEvent.click(screen.getByRole('button', { name: 'canvas' }))
    expect(screen.getByTestId('agent-working').textContent).toContain(
      '@tilde is working',
    )
  })

  it('offers no canvas at all when the host hasn’t wired one', () => {
    // Every canvas prop is optional, so a host that only wants a thread gets
    // exactly that — no dead toggle in the header.
    setWidth(1280)
    renderView({ activeId: 'c1' })
    expect(screen.queryByLabelText('Canvas')).toBeNull()
  })
})

describe('ChatView: moving a widget between the two surfaces', () => {
  it('pins a stack widget onto the page you have open', () => {
    // The human half of the agent's `place`: the same ordinary row update,
    // asked for with a thumb. No corner — the service finds a free slot.
    setWidth(1280)
    const onPlaceWidget = vi.fn()
    renderView({
      activeId: 'c1',
      widgets: [
        {
          id: 'w2',
          kind: 'note',
          props: { text: 'keep this' },
          createdByHandle: 'tilde',
          answerValue: null,
        },
      ],
      canvasPages: [
        { id: 'p1', title: 'Ops' },
        { id: 'p2', title: 'Numbers' },
      ],
      canvasWidgets: [],
      activePageId: 'p2',
      onSelectPage: vi.fn(),
      onNewPage: vi.fn(),
      onRenamePage: vi.fn(),
      onRemovePage: vi.fn(),
      onPlaceWidget,
      onStackWidget: vi.fn(),
      onAnswerWidget: vi.fn(),
      onDismissWidget: vi.fn(),
    })
    fireEvent.click(screen.getByLabelText('Keep keep this on the canvas'))
    expect(onPlaceWidget).toHaveBeenCalledWith('w2', { pageId: 'p2' })
  })

  it('offers no pin when there is nowhere to pin to', () => {
    // An affordance pointing at a canvas that doesn't exist yet is worse than
    // no affordance.
    setWidth(1280)
    renderView({
      activeId: 'c1',
      widgets: [
        {
          id: 'w2',
          kind: 'note',
          props: { text: 'keep this' },
          createdByHandle: 'tilde',
          answerValue: null,
        },
      ],
      canvasPages: [],
      canvasWidgets: [],
      activePageId: null,
      onSelectPage: vi.fn(),
      onNewPage: vi.fn(),
      onRenamePage: vi.fn(),
      onRemovePage: vi.fn(),
      onPlaceWidget: vi.fn(),
      onStackWidget: vi.fn(),
      onAnswerWidget: vi.fn(),
      onDismissWidget: vi.fn(),
    })
    expect(screen.queryByLabelText(/on the canvas/)).toBeNull()
  })
})

/**
 * A default room is the way in to the surface it replaced in the rail. Without
 * this link `/issues`, `/files` and `/inbox` are routes with nothing pointing
 * at them — alive, and unfindable.
 */
describe('ChatView: the room’s link to its own view', () => {
  const FakeLink: NonNullable<ChatViewProps['Link']> = ({
    to,
    className,
    children,
    ...rest
  }) => (
    <a href={to} className={className} {...rest}>
      {children}
    </a>
  )

  it('links a room through to the view it is the room for', () => {
    renderView({
      activeId: 'room-issues',
      title: 'Issues',
      viewLink: { to: '/issues', label: 'Board' },
      Link: FakeLink,
    })
    const link = screen.getByText('Board').closest('a')
    expect(link?.getAttribute('href')).toBe('/issues')
  })

  it('draws nothing for an ordinary chat', () => {
    renderView({ activeId: 'c1', viewLink: null, Link: FakeLink })
    expect(screen.queryByText('Board')).toBeNull()
  })

  it('keeps the link a thumb target on a phone', () => {
    // It's behind the header's overflow at 390px — see "the phone header" — but
    // it is still the one control that answers "where did the board go?", so it
    // is still a thumb target when you get to it.
    setWidth(390)
    renderView({
      activeId: 'room-files',
      title: 'Files',
      viewLink: { to: '/files', label: 'All files' },
      Link: FakeLink,
    })
    fireEvent.click(screen.getByLabelText('More'))
    expect(classTokensOf('All files', 'a')).toContain('min-h-11')
  })
})

/**
 * The chat chrome slice #cse7 flagged as "slice 7 territory": four controls a
 * thumb has to hit that were 32–36px tall. Every one of them is now on the
 * 44px floor the widget surfaces have used since #cse4.
 */
describe('ChatView: thumb targets on a phone', () => {
  it('gives the header controls and the composer a 44px floor', () => {
    setWidth(390)
    renderView({
      activeId: 'c1',
      crew: [{ id: 'z', handle: 'bix', displayName: 'Bix', type: 'agent' }],
      members: [
        { userId: 'a', handle: 'tilde', type: 'agent' },
        { userId: 'b', handle: 'dru', type: 'human' },
      ],
      schedules: [],
      onCreateSchedule: vi.fn(),
      onToggleSchedule: vi.fn(),
      onDeleteSchedule: vi.fn(),
    })
    const target = (label: string) =>
      screen.getByLabelText(label).className.split(/\s+/)
    expect(target('Open Chats')).toContain('min-h-11')
    expect(target('More')).toContain('min-h-11')
    expect(target('Send message')).toContain('min-h-11')
    fireEvent.click(screen.getByLabelText('More'))
    expect(target('Schedules')).toContain('min-h-11')
    // The roster's controls too: inside the overflow they're the only way to
    // change who's in a chat, and they have the room. The desktop header keeps
    // its dense chips — a 44px pill per member there would be the wrap again.
    expect(target('Remove tilde')).toContain('min-h-11')
    expect(target('Add member')).toContain('min-h-11')
  })

  it('keeps the desktop roster dense, where the row is the scarce thing', () => {
    setWidth(1280)
    renderView({
      activeId: 'c1',
      crew: [{ id: 'z', handle: 'bix', displayName: 'Bix', type: 'agent' }],
      members: [{ userId: 'a', handle: 'tilde', type: 'agent' }],
    })
    expect(
      screen.getByLabelText('Remove tilde').className.split(/\s+/),
    ).not.toContain('min-h-11')
  })
})

/**
 * The header, paid down a second time.
 *
 * #cse5 took it from four rows to two and #cse8 promptly spent the slack: the
 * name, People, the room's link, the Thread/Canvas toggle and Schedules all
 * shared 390px, one control away from wrapping to three rows again. Shaving
 * pixels off each of them is a debt you pay every slice, so this time the row
 * has a FIXED shape — the two things that carry state, and one overflow — and
 * anything new goes behind the overflow rather than into the row.
 */
describe('ChatView: the phone header', () => {
  const FakeLink: NonNullable<ChatViewProps['Link']> = ({
    to,
    className,
    children,
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  )

  /** A room, at 390px, with every control this header can carry. */
  function loadedRoom(over: Partial<ChatViewProps> = {}) {
    setWidth(390)
    return renderView({
      activeId: 'room-issues',
      title: 'Issues',
      members: [
        { userId: 'a', handle: 'tilde', type: 'agent' },
        { userId: 'b', handle: 'dru', type: 'human' },
      ],
      viewLink: { to: '/issues', label: 'Board' },
      Link: FakeLink,
      schedules: [],
      onCreateSchedule: vi.fn(),
      onToggleSchedule: vi.fn(),
      onDeleteSchedule: vi.fn(),
      canvasPages: [{ id: 'p1', title: 'Page 1' }],
      canvasWidgets: [],
      activePageId: 'p1',
      onSelectPage: vi.fn(),
      onNewPage: vi.fn(),
      onRenamePage: vi.fn(),
      onRemovePage: vi.fn(),
      onPlaceWidget: vi.fn(),
      onStackWidget: vi.fn(),
      onAnswerWidget: vi.fn(),
      ...over,
    })
  }

  it('carries exactly three controls in the row, however loaded the chat is', () => {
    loadedRoom()
    const header = document.querySelector('header')
    const inRow = [...(header?.querySelectorAll('button, a, select') ?? [])]
    // Thread, Canvas, More. Nothing else competes for the row's width, so the
    // next control somebody adds cannot wrap it.
    expect(inRow.map((el) => el.textContent.trim())).toEqual([
      'thread',
      'canvas',
      '',
    ])
  })

  it('keeps the surface toggle and the waiting count in the row', () => {
    // The two things that carry STATE. Behind an overflow, a raise you never
    // saw is a raise you never saw.
    loadedRoom({ widgets: [choiceWidget({ id: 'w1' })] })
    fireEvent.click(screen.getByRole('button', { name: 'canvas' }))
    expect(screen.getByLabelText('Thread — 1 waiting')).toBeTruthy()
  })

  it('puts the room link, the roster and Schedules behind the overflow', () => {
    loadedRoom()
    expect(screen.queryByText('Board')).toBeNull()
    expect(screen.queryByLabelText('Schedules')).toBeNull()
    expect(screen.queryByLabelText('Remove tilde')).toBeNull()

    fireEvent.click(screen.getByLabelText('More'))
    expect(screen.getByText('Board').closest('a')?.getAttribute('href')).toBe(
      '/issues',
    )
    expect(screen.getByLabelText('Schedules')).toBeTruthy()
    expect(screen.getByLabelText('Remove tilde')).toBeTruthy()
  })

  it('closes again, so the menu is never in the way', () => {
    loadedRoom()
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(screen.getByLabelText('More'))
    expect(screen.queryByLabelText('Schedules')).toBeNull()
  })

  it('opens the schedules panel from inside the overflow', () => {
    // The control moved behind the overflow, so the path from a thumb to the
    // panel is a new one — and a control you can reach but can't use would be
    // the worse half of folding it away.
    loadedRoom()
    fireEvent.click(screen.getByLabelText('More'))
    expect(screen.queryByPlaceholderText('Message to schedule…')).toBeNull()
    fireEvent.click(screen.getByLabelText('Schedules'))
    expect(screen.getByPlaceholderText('Message to schedule…')).toBeTruthy()
  })

  /**
   * `schedules` is a separate optional prop from the three callbacks that turn
   * the affordance on, so "the host has wired scheduling but hasn't loaded (or
   * has no) schedules" is a real state — the first render of every chat, in
   * fact. The control shows itself without a count rather than "(0)" or
   * "(undefined)", on both layouts.
   */
  it('shows the control with no count before any schedules have loaded', () => {
    for (const width of [390, 1280]) {
      setWidth(width)
      const { unmount } = renderView({
        activeId: 'c1',
        schedules: undefined,
        onCreateSchedule: vi.fn(),
        onToggleSchedule: vi.fn(),
        onDeleteSchedule: vi.fn(),
      })
      if (width === 390) fireEvent.click(screen.getByLabelText('More'))
      expect(screen.getByLabelText('Schedules').textContent).toBe('Schedules')
      unmount()
    }
  })

  it('leaves a desktop pane exactly as it was — one row, everything on it', () => {
    setWidth(1280)
    loadedRoom()
    setWidth(1280)
    expect(screen.queryByLabelText('More')).toBeNull()
    expect(screen.getByText('Board')).toBeTruthy()
    expect(screen.getByLabelText('Schedules')).toBeTruthy()
    expect(screen.getByLabelText('Remove tilde')).toBeTruthy()
  })
})
