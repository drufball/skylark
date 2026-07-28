// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HomeTileTarget } from '@hull/home-canvas/service'
import { MOBILE_BREAKPOINT } from '@rigging/lib/use-is-mobile'
import type { EventSourceLike } from '@rigging/lib/use-ship-log'

import { HomeCanvas, type HomeTileItem } from './home-canvas'

// Your own screen of POINTERS. The tests that matter are the ones a phone
// exercises — the whole promise is answering a question with a thumb without
// opening the chat — plus the two states a pointer can be in that a chat canvas
// tile never is: nothing raised, and no longer yours.

class FakeSource implements EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  close(): void {
    /* nothing to tear down in a fake */
  }
}
const factory = () => new FakeSource()

function setWidth(width: number) {
  window.innerWidth = width
  window.dispatchEvent(new Event('resize'))
}
const DESKTOP = MOBILE_BREAKPOINT + 400
const PHONE = 390

const CHAT = { id: 'c1', title: 'Deploys', memberHandles: ['dru', 'tilde'] }
const CHOICE = {
  id: 'w1',
  kind: 'choice',
  props: { question: 'Ship it?', options: ['Yes', 'No'] },
  createdByHandle: 'tilde',
  answerValue: null,
}

function tile(target: HomeTileTarget, over: Partial<HomeTileItem> = {}) {
  return {
    id: 't1',
    pageId: 'p1',
    gridX: 0,
    gridY: 0,
    gridW: 2,
    gridH: 2,
    target,
    ...over,
  }
}

/** A router-free stand-in for the Link the host injects. */
const Link = ({
  to,
  className,
  children,
  ...rest
}: {
  to: string
  className?: string
  'aria-label'?: string
  children: React.ReactNode
}) => (
  <a href={to} className={className} {...rest}>
    {children}
  </a>
)

function renderHome(over: { tiles?: HomeTileItem[]; pages?: unknown } = {}) {
  const handlers = {
    onSelectPage: vi.fn(),
    onNewPage: vi.fn(),
    onRenamePage: vi.fn(),
    onRemovePage: vi.fn(),
    onMoveTile: vi.fn(),
    onUnpinTile: vi.fn(),
    onAnswerWidget: vi.fn(),
    onPinChat: vi.fn(),
  }
  const view = render(
    <HomeCanvas
      pages={[
        { id: 'p1', title: 'Home' },
        { id: 'p2', title: 'Work' },
      ]}
      tiles={over.tiles ?? [tile({ mode: 'chat', chat: CHAT, widget: CHOICE })]}
      activePageId="p1"
      busy={false}
      chats={[CHAT]}
      chatHref={(chatId) => `/?chat=${chatId}`}
      Link={Link}
      eventSourceFactory={factory}
      {...handlers}
    />,
  )
  return { ...view, ...handlers }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setWidth(1024)
})

describe('HomeCanvas: a chat pointer is the whole promise', () => {
  it('shows whatever a pointed-at chat is asking, and answers it with one tap', () => {
    // An agent raises a question in a chat → it turns up here → a thumb answers
    // it → the host posts it into that chat as an ordinary message. No detour
    // through the conversation at any point.
    act(() => {
      setWidth(PHONE)
    })
    const { onAnswerWidget } = renderHome()
    expect(screen.getByText('Ship it?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(onAnswerWidget).toHaveBeenCalledWith('w1', 'Yes')
  })

  it('answers only once per tap-through, even on a double tap', () => {
    act(() => {
      setWidth(PHONE)
    })
    const { onAnswerWidget } = renderHome()
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(onAnswerWidget).toHaveBeenCalledTimes(1)
  })

  it('rests honestly when the chat has raised nothing', () => {
    // Not an error, not an empty box: the tile still names the conversation and
    // says what it's for, so it reads as intentional.
    renderHome({
      tiles: [tile({ mode: 'chat', chat: CHAT, widget: null })],
    })
    expect(screen.getByText(/Nothing raised right now/)).toBeTruthy()
    expect(screen.getByLabelText('Open the chat Deploys')).toBeTruthy()
  })

  it('always offers a way through to the owning chat', () => {
    // "Which conversation does this thing belong to?" is the question a home
    // screen makes people ask constantly, so every tile answers it in place.
    renderHome()
    const link = screen.getByLabelText('Open the chat Deploys')
    expect(link.getAttribute('href')).toBe('/?chat=c1')
  })

  it('names an untitled chat by its members, like the sidebar does', () => {
    renderHome({
      tiles: [
        tile({
          mode: 'chat',
          chat: { id: 'c2', title: null, memberHandles: ['dru', 'tilde'] },
          widget: null,
        }),
      ],
    })
    expect(screen.getByLabelText('Open the chat @dru, @tilde')).toBeTruthy()
  })
})

describe('HomeCanvas: a widget pointer', () => {
  it('shows that exact widget, with the decision it recorded', () => {
    renderHome({
      tiles: [
        tile({
          mode: 'widget',
          chat: CHAT,
          widget: { ...CHOICE, answerValue: 'Yes' },
        }),
      ],
    })
    expect(screen.getByText('Yes')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'No' })).toBeNull()
  })

  it('says so when the ship no longer knows the kind, and stays unpinnable-away', () => {
    renderHome({
      tiles: [
        tile({
          mode: 'widget',
          chat: CHAT,
          widget: {
            id: 'w9',
            kind: 'orrery',
            props: {},
            createdByHandle: 'tilde',
            answerValue: null,
          },
        }),
      ],
    })
    expect(screen.getByText(/doesn’t know this widget kind/)).toBeTruthy()
    expect(screen.getByLabelText('Unpin orrery from your home')).toBeTruthy()
  })
})

describe('HomeCanvas: a pointer you have lost access to', () => {
  it('degrades to an honest placeholder that names nothing', () => {
    // Safe HERE and only here: home is personal, so there is no third party to
    // leak the existence of a conversation to — and a tile silently vanishing
    // out of an arrangement you made is the worse outcome.
    renderHome({ tiles: [tile({ mode: 'lost' })] })
    expect(screen.getByText('You no longer have access to this.')).toBeTruthy()
    expect(screen.queryByText('Ship it?')).toBeNull()
    expect(screen.queryByText('Deploys')).toBeNull()
    expect(screen.queryByLabelText(/Open the chat/)).toBeNull()
  })

  it('can still be taken off your home', () => {
    const { onUnpinTile } = renderHome({ tiles: [tile({ mode: 'lost' })] })
    fireEvent.click(
      screen.getByLabelText('Unpin No longer available from your home'),
    )
    expect(onUnpinTile).toHaveBeenCalledWith('t1')
  })
})

describe('HomeCanvas: pages and arranging', () => {
  it('tabs between pages', () => {
    const { onSelectPage } = renderHome()
    fireEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(onSelectPage).toHaveBeenCalledWith('p2')
  })

  it('arranges from the keyboard on a desktop pane, committing one write', () => {
    act(() => {
      setWidth(DESKTOP)
    })
    const { onMoveTile } = renderHome()
    fireEvent.keyDown(screen.getByLabelText('Move Ship it?'), {
      key: 'ArrowRight',
    })
    expect(onMoveTile).toHaveBeenCalledWith('t1', {
      pageId: 'p1',
      gridX: 1,
      gridY: 0,
      gridW: 2,
      gridH: 2,
    })
  })

  it('gives a phone one column and no drag targets at all', () => {
    act(() => {
      setWidth(PHONE)
    })
    renderHome()
    expect(screen.getByTestId('home-column')).toBeTruthy()
    expect(screen.queryByTestId('home-grid')).toBeNull()
    expect(screen.queryByLabelText(/^Move /)).toBeNull()
    expect(screen.queryByLabelText(/^Resize /)).toBeNull()
  })

  it('pins a conversation from the picker', () => {
    const { onPinChat } = renderHome()
    fireEvent.click(screen.getByLabelText('Add a tile'))
    fireEvent.click(screen.getByRole('button', { name: 'Deploys' }))
    expect(onPinChat).toHaveBeenCalledWith('c1')
  })

  it('says so when there is nothing to pin yet', () => {
    render(
      <HomeCanvas
        pages={[{ id: 'p1', title: 'Home' }]}
        tiles={[]}
        activePageId="p1"
        busy={false}
        chats={[]}
        chatHref={(chatId) => `/?chat=${chatId}`}
        Link={Link}
        eventSourceFactory={factory}
        onSelectPage={vi.fn()}
        onNewPage={vi.fn()}
        onRenamePage={vi.fn()}
        onRemovePage={vi.fn()}
        onMoveTile={vi.fn()}
        onUnpinTile={vi.fn()}
        onAnswerWidget={vi.fn()}
        onPinChat={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByLabelText('Add a tile'))
    expect(screen.getByText(/No conversations yet/)).toBeTruthy()
  })

  it('invites you to make a page when there are none', () => {
    const onNewPage = vi.fn()
    render(
      <HomeCanvas
        pages={[]}
        tiles={[]}
        activePageId={null}
        busy={false}
        chats={[CHAT]}
        chatHref={(chatId) => `/?chat=${chatId}`}
        Link={Link}
        eventSourceFactory={factory}
        onSelectPage={vi.fn()}
        onNewPage={onNewPage}
        onRenamePage={vi.fn()}
        onRemovePage={vi.fn()}
        onMoveTile={vi.fn()}
        onUnpinTile={vi.fn()}
        onAnswerWidget={vi.fn()}
        onPinChat={vi.fn()}
      />,
    )
    expect(screen.getByText('Your home is empty')).toBeTruthy()
    vi.spyOn(window, 'prompt').mockReturnValue('Morning')
    fireEvent.click(screen.getByRole('button', { name: /New page/ }))
    expect(onNewPage).toHaveBeenCalledWith('Morning')
  })

  it('names every control after the tile, never after its row id', () => {
    act(() => {
      setWidth(DESKTOP)
    })
    renderHome({
      tiles: [
        tile(
          { mode: 'chat', chat: CHAT, widget: CHOICE },
          { id: '019fa5b1-f0f1-7000-8000-000000000001' },
        ),
      ],
    })
    for (const label of screen
      .getAllByLabelText(/./)
      .map((el) => el.getAttribute('aria-label') ?? '')) {
      expect(label).not.toContain('019fa5b1')
    }
  })
})
