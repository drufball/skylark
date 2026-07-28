// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  chatName,
  composerPlaceholder,
  workingFromMembers,
  type ChatCanvas,
  type ChatMemberItem,
  type ChatStack,
  type ChatViewProps,
} from './chat'
import type { WidgetItem } from '@rigging/widgets/stack'
import { installChatTestBed, renderView, setWidth } from './chat.test-support'
import { classTokensOf } from './test-support'

installChatTestBed()

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

  it('sends a message from the composer', () => {
    const { onSend } = renderView({ activeId: 'c1' })
    const box = screen.getByPlaceholderText(/message/i)
    fireEvent.change(box, { target: { value: '  hey  ' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hey')
  })

  it('does not send on Shift+Enter', () => {
    const { onSend } = renderView({ activeId: 'c1' })
    const box = screen.getByPlaceholderText(/message/i)
    fireEvent.change(box, { target: { value: 'multi' } })
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
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

  it('pins the view to exactly the viewport height with its own overflow, so the sidebar and content pane each scroll independently instead of the whole row dragging away', () => {
    const { container } = renderView()
    expect(container.firstElementChild?.className).toContain('h-full')
    expect(container.firstElementChild?.className).toContain('overflow-hidden')
    expect(container.querySelector('aside')?.className).toContain('min-h-0')
    expect(container.querySelector('section')?.className).toContain('min-h-0')
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

/** A wired shelf — both callbacks present, so the widgets are the variable. */
function stackGroup(widgets: WidgetItem[] = []): ChatStack {
  return { widgets, onAnswerWidget: vi.fn(), onDismissWidget: vi.fn() }
}

/** A canvas wired the way the route wires it: one page, one tile on it. */
function canvasGroup(over: Partial<ChatCanvas> = {}): ChatCanvas {
  return {
    pages: [{ id: 'p1', title: 'Ops' }],
    widgets: [
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
      stack: stackGroup(),
    })
    expect(screen.queryByTestId('widget-stack')).toBeNull()
  })

  it('shows no stack when the host has not wired the shelf', () => {
    renderView({ activeId: 'c1' })
    expect(screen.queryByTestId('widget-stack')).toBeNull()
  })

  it('hands the shelf its widgets, in the order given', () => {
    renderView({
      activeId: 'c1',
      stack: stackGroup([
        choiceWidget({
          id: 'w1',
          props: { question: 'First?', options: ['Ok'] },
        }),
        choiceWidget({
          id: 'w2',
          props: { question: 'Second?', options: ['Ok'] },
        }),
      ]),
    })
    expect(
      screen.getAllByTestId('widget-headline').map((h) => h.textContent),
    ).toEqual(['First?', 'Second?'])
  })

  it('passes an answer back up to the host', () => {
    const onAnswerWidget = vi.fn()
    renderView({
      activeId: 'c1',
      stack: {
        widgets: [choiceWidget()],
        onAnswerWidget,
        onDismissWidget: vi.fn(),
      },
    })
    fireEvent.click(screen.getByLabelText('Open Ship the new theme?'))
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(onAnswerWidget).toHaveBeenCalledWith('w1', 'No')
  })

  it('passes a dismissal back up to the host', () => {
    const onDismissWidget = vi.fn()
    renderView({
      activeId: 'c1',
      stack: {
        widgets: [choiceWidget()],
        onAnswerWidget: vi.fn(),
        onDismissWidget,
      },
    })
    fireEvent.click(screen.getByLabelText('Dismiss Ship the new theme?'))
    expect(onDismissWidget).toHaveBeenCalledWith('w1')
  })

  it('sits between the thread and the composer, where your thumb already is', () => {
    const { container } = renderView({
      activeId: 'c1',
      stack: stackGroup([choiceWidget()]),
    })
    const order = [...container.querySelectorAll('[data-testid], textarea')]
      .map((el) => el.getAttribute('data-testid') ?? el.tagName.toLowerCase())
      .filter((name) => name === 'widget-stack' || name === 'textarea')
    expect(order).toEqual(['widget-stack', 'textarea'])
  })
})

describe('ChatView: the canvas lives inside the chat', () => {
  /** A chat with a canvas wired up, one page, one tile on it. */
  function withCanvas(props: Partial<ChatViewProps> = {}) {
    return renderView({
      activeId: 'c1',
      members: [{ userId: 'u1', handle: 'dru', type: 'human' }],
      canvas: canvasGroup(),
      stack: stackGroup(),
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
    withCanvas({ canvas: canvasGroup({ pages: [], widgets: [] }) })
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
      stack: stackGroup([
        {
          id: 'w2',
          kind: 'choice',
          props: { question: 'Ship it?', options: ['Yes', 'No'] },
          createdByHandle: 'tilde',
          answerValue: null,
        },
      ]),
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
    withCanvas({ stack: stackGroup([choiceWidget({ id: 'w2' })]) })
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
    // The whole canvas group is optional, so a host that only wants a thread
    // gets exactly that — no dead toggle in the header.
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
      stack: stackGroup([
        {
          id: 'w2',
          kind: 'note',
          props: { text: 'keep this' },
          createdByHandle: 'tilde',
          answerValue: null,
        },
      ]),
      canvas: canvasGroup({
        pages: [
          { id: 'p1', title: 'Ops' },
          { id: 'p2', title: 'Numbers' },
        ],
        widgets: [],
        activePageId: 'p2',
        onPlaceWidget,
      }),
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
      stack: stackGroup([
        {
          id: 'w2',
          kind: 'note',
          props: { text: 'keep this' },
          createdByHandle: 'tilde',
          answerValue: null,
        },
      ]),
      canvas: canvasGroup({ pages: [], widgets: [], activePageId: null }),
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
      schedules: {
        items: [],
        onCreate: vi.fn(),
        onToggle: vi.fn(),
        onDelete: vi.fn(),
      },
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
      schedules: {
        items: [],
        onCreate: vi.fn(),
        onToggle: vi.fn(),
        onDelete: vi.fn(),
      },
      canvas: canvasGroup({
        pages: [{ id: 'p1', title: 'Page 1' }],
        widgets: [],
      }),
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
    loadedRoom({ stack: stackGroup([choiceWidget({ id: 'w1' })]) })
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
