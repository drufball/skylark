// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { InboxItem } from '@hull/notifications/server'

vi.mock('@hull/notifications/server', () => ({ myInbox: vi.fn() }))
import { myInbox } from '@hull/notifications/server'

import { inboxKind, pickEntries } from './inbox'

// `inbox` is the per-viewer kind: a notification belongs to a PERSON, so the
// same widget row in a shared chat must show each member their own inbox and
// never anybody else's. The isolation test below is the point of this file.

afterEach(cleanup)
beforeEach(() => {
  vi.mocked(myInbox).mockReset()
})

function entry(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'n1',
    label: '@bix commented on an issue',
    issueId: 'i1',
    at: '2026-07-27T09:00:00.000Z',
    read: false,
    ...over,
  }
}

/** What one viewer's `myInbox` comes back with. */
function inboxOf(handle: string, items: InboxItem[]) {
  return {
    me: { id: `u-${handle}`, handle },
    items,
    unread: items.filter((i) => !i.read).length,
  }
}

function parse(props: unknown) {
  const result = inboxKind.parse(props)
  if (!result.ok) throw new Error(`expected props to parse: ${result.detail}`)
  return result.view
}

function body(props: unknown) {
  const { Body } = parse(props)
  return <Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />
}

describe('inbox: parsing', () => {
  it('accepts an empty blob — your whole inbox', () => {
    expect(parse({}).headline).toBe('Inbox')
  })

  it('headlines an unread-only tile as such', () => {
    expect(parse({ unreadOnly: true }).headline).toBe('Inbox · unread')
  })

  it.each([
    ['null', null],
    ['a string', 'mine'],
    ['a number', 7],
    ['an array', []],
  ])('refuses props that are %s, not an object', (_label, props) => {
    expect(inboxKind.parse(props)).toEqual({
      ok: false,
      detail: 'expected an object of props',
    })
  })

  it.each([
    ['not a number', { limit: 'five' }],
    ['zero', { limit: 0 }],
    ['fractional', { limit: 2.5 }],
    ['absurd', { limit: 5000 }],
  ])('refuses a limit that is %s', (_label, props) => {
    expect(inboxKind.parse(props)).toMatchObject({ ok: false })
  })

  it('refuses unreadOnly that is not a boolean', () => {
    expect(inboxKind.parse({ unreadOnly: 'yes' })).toMatchObject({ ok: false })
  })

  it.each([
    ['userId', { userId: 'u-bix' }],
    ['handle', { handle: 'bix' }],
  ])('refuses a blob that tries to aim the tile with %s', (_label, props) => {
    // Refused LOUDLY rather than ignored: an agent that writes `userId` has a
    // wrong idea about what this widget is, and quietly dropping the key would
    // leave it believing it had pointed the tile at somebody.
    const result = inboxKind.parse(props)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toMatch(/own inbox|whoever is looking|viewer/i)
  })

  it('parses its own documented example', () => {
    expect(inboxKind.parse(inboxKind.example).ok).toBe(true)
  })
})

describe('inbox: which topics keep it live', () => {
  it('watches the notification namespace, not one person’s topic', () => {
    // The props can't name a viewer, so the instance can't name a topic either.
    // The wildcard is safe by construction: every event on the stream is gated
    // per-topic by `canSeeTopic`, and `notify:<userId>` admits exactly that
    // user — so two members on one row each hear only their own.
    expect(parse({}).topics).toEqual(['notify:*'])
  })
})

describe('pickEntries', () => {
  const unread = entry({ id: 'n1', read: false })
  const read = entry({ id: 'n2', read: true })

  it('keeps everything by default', () => {
    expect(pickEntries([unread, read], {})).toEqual([unread, read])
  })

  it('keeps only the unread ones when asked', () => {
    expect(pickEntries([unread, read], { unreadOnly: true })).toEqual([unread])
  })

  it('caps at the limit, defaulting to a tile-sized handful', () => {
    const many = Array.from({ length: 30 }, (_, n) =>
      entry({ id: `n${String(n)}` }),
    )
    expect(pickEntries(many, {}).length).toBeLessThan(many.length)
    expect(pickEntries(many, { limit: 3 })).toHaveLength(3)
  })
})

describe('inbox: the body', () => {
  it('reads through the notifications service’s own per-viewer door', async () => {
    vi.mocked(myInbox).mockResolvedValue(
      inboxOf('dru', [entry({ label: '@bix commented on #a1b2' })]),
    )
    render(body({}))
    expect(await screen.findByText('@bix commented on #a1b2')).toBeTruthy()
  })

  it('says an empty inbox is empty rather than drawing a void', async () => {
    vi.mocked(myInbox).mockResolvedValue(inboxOf('dru', []))
    render(body({}))
    expect(await screen.findByText(/nothing in your inbox/i)).toBeTruthy()
  })

  it('says so when only the unread filter is empty', async () => {
    vi.mocked(myInbox).mockResolvedValue(
      inboxOf('dru', [entry({ read: true })]),
    )
    render(body({ unreadOnly: true }))
    expect(await screen.findByText(/nothing unread/i)).toBeTruthy()
  })

  it('re-reads when the ship’s log says a notification landed', async () => {
    vi.mocked(myInbox)
      .mockResolvedValueOnce(inboxOf('dru', [entry({ label: 'first' })]))
      .mockResolvedValueOnce(
        inboxOf('dru', [entry({ label: 'first' }), entry({ label: 'second' })]),
      )
    const { Body } = parse({})
    const { rerender } = render(
      <Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />,
    )
    expect(await screen.findByText('first')).toBeTruthy()
    rerender(
      <Body revision={1} onAnswer={vi.fn()} spent={false} answer={null} />,
    )
    expect(await screen.findByText('second')).toBeTruthy()
  })

  it('degrades to an honest line when the door fails, never a white screen', async () => {
    vi.mocked(myInbox).mockRejectedValue(new Error('database: down'))
    render(body({}))
    await waitFor(() => {
      expect(screen.getByText(/couldn’t read your inbox/i)).toBeTruthy()
    })
  })
})

describe('inbox: one row, two viewers', () => {
  it('shows each member their OWN notifications and never the other’s', async () => {
    // THE test for this kind. The same widget row (one `parse`, one `Body`) is
    // rendered for two different people; the door resolves `currentActor()`
    // server-side and RLS scopes the rows to their owner
    // (hull/notifications/access.test.ts pins that half), so what a tile shows
    // is a property of who is LOOKING, never of the row.
    const { Body } = parse({})

    vi.mocked(myInbox).mockResolvedValue(
      inboxOf('dru', [entry({ id: 'n1', label: 'dru’s only notification' })]),
    )
    const dru = render(
      <Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />,
    )
    expect(await screen.findByText('dru’s only notification')).toBeTruthy()
    expect(screen.getByText(/@dru/)).toBeTruthy()
    dru.unmount()

    vi.mocked(myInbox).mockResolvedValue(
      inboxOf('bix', [entry({ id: 'n2', label: 'bix’s only notification' })]),
    )
    render(<Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />)
    expect(await screen.findByText('bix’s only notification')).toBeTruthy()
    expect(screen.getByText(/@bix/)).toBeTruthy()
    expect(screen.queryByText('dru’s only notification')).toBeNull()
  })
})
