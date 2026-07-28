// @vitest-environment jsdom
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import {
  emptyThreadLine,
  seenByHandles,
  workingLabel,
  type ChatMsg,
} from './chat-thread'
import { ChatView } from './chat'
import {
  installChatTestBed,
  renderView,
  scrollIntoView,
} from './chat.test-support'
import { classTokensOf } from './test-support'

installChatTestBed()

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

describe('ChatView: the thread', () => {
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
