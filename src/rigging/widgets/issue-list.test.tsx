// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BoardIssue } from '@hull/issues/server'

vi.mock('@hull/issues/server', () => ({ listBoard: vi.fn() }))
import { listBoard } from '@hull/issues/server'

import {
  DEFAULT_ISSUE_LIMIT,
  filterIssues,
  issueListKind,
  missingRefs,
} from './issue-list'

// `issue-list` is the kind that proves a widget can compose ANOTHER service's
// data with no hull cycle: the props hold only the filter, the issues are read
// fresh through the issues service's own door, and the tile goes live off the
// issues topic on the subscription the stack already holds.

afterEach(cleanup)
beforeEach(() => {
  vi.mocked(listBoard).mockReset()
})

function issue(over: Partial<BoardIssue> = {}): BoardIssue {
  return {
    id: 'i1',
    nano: 'a1b2',
    title: 'Teach the widgets to update themselves',
    status: 'open',
    authorHandle: 'dru',
    commentCount: 0,
    statusLine: null,
    statusLineAt: null,
    awaitingBackground: false,
    sessionRunning: false,
    batonHolder: null,
    updatedAt: '2026-07-27T09:00:00.000Z',
    ...over,
  }
}

/** The view a good blob parses to, or a failure the test can read. */
function parse(props: unknown) {
  const result = issueListKind.parse(props)
  if (!result.ok) throw new Error(`expected props to parse: ${result.detail}`)
  return result.view
}

describe('issue-list: parsing', () => {
  it('accepts an empty filter — every issue, newest first', () => {
    const view = parse({})
    expect(view.headline).toBe('Issues · all')
  })

  it('headlines with the statuses it filters on', () => {
    expect(parse({ statuses: ['open', 'building'] }).headline).toBe(
      'Issues · open, building',
    )
  })

  it('headlines a pinned list by its count', () => {
    expect(parse({ issueIds: ['i1', 'i2'] }).headline).toBe('Issues · 2 pinned')
  })

  it('subscribes to every issue, not just the ones showing now', () => {
    // The wildcard is load-bearing: a filter on `open` must notice an issue
    // MOVING INTO it, which a per-id subscription could never hear.
    expect(parse({ statuses: ['open'] }).topics).toEqual(['issue:*'])
    expect(parse({ issueIds: ['i1'] }).topics).toEqual(['issue:*'])
  })

  it.each([
    ['null', null],
    ['a string', 'open'],
    ['a number', 7],
    ['an array', ['open']],
  ])('refuses props that are %s, not an object', (_label, props) => {
    expect(issueListKind.parse(props)).toEqual({
      ok: false,
      detail: 'expected an object of props',
    })
  })

  it.each([
    ['not an array', { statuses: 'open' }],
    ['empty', { statuses: [] }],
    ['holding a non-string', { statuses: [3] }],
  ])('refuses statuses that are %s', (_label, props) => {
    expect(issueListKind.parse(props)).toMatchObject({ ok: false })
  })

  it('refuses a status this ship does not have, listing the real ones', () => {
    // The reason this parser lives in RIGGING: it validates against the issues
    // service's own status vocabulary, which the hull's chat service may not
    // import without inviting a cycle.
    const result = issueListKind.parse({ statuses: ['blocked'] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.detail).toContain('blocked')
    expect(result.detail).toContain('open')
    expect(result.detail).toContain('building')
  })

  it.each([
    ['not an array', { issueIds: 'i1' }],
    ['empty', { issueIds: [] }],
    ['holding a blank string', { issueIds: ['i1', ' '] }],
  ])('refuses issueIds that are %s', (_label, props) => {
    expect(issueListKind.parse(props)).toMatchObject({ ok: false })
  })

  it.each([
    ['not a number', { limit: 'five' }],
    ['zero', { limit: 0 }],
    ['negative', { limit: -2 }],
    ['fractional', { limit: 2.5 }],
    ['absurd', { limit: 5000 }],
  ])('refuses a limit that is %s', (_label, props) => {
    expect(issueListKind.parse(props)).toMatchObject({ ok: false })
  })

  it('parses its own documented example', () => {
    expect(issueListKind.parse(issueListKind.example).ok).toBe(true)
  })
})

describe('filterIssues', () => {
  const open = issue({ id: 'i1', nano: 'aaaa', status: 'open' })
  const building = issue({ id: 'i2', nano: 'bbbb', status: 'building' })
  const done = issue({ id: 'i3', nano: 'cccc', status: 'done' })

  it('keeps everything when the filter is empty', () => {
    expect(filterIssues([open, building, done], {})).toEqual([
      open,
      building,
      done,
    ])
  })

  it('keeps only the named statuses', () => {
    expect(
      filterIssues([open, building, done], { statuses: ['building'] }),
    ).toEqual([building])
  })

  it('keeps a pinned set, matching either the id or the short nano', () => {
    // An agent working from `npm run issue` sees nanos, so accepting both is
    // the difference between a widget that works and one that shows nothing.
    expect(
      filterIssues([open, building, done], { issueIds: ['cccc', 'i1'] }),
    ).toEqual([open, done])
  })

  it('applies both filters together — a pin AND a status', () => {
    expect(
      filterIssues([open, building, done], {
        issueIds: ['i1', 'i2'],
        statuses: ['building'],
      }),
    ).toEqual([building])
  })

  it('caps the list at the limit, defaulting to a shelf-sized handful', () => {
    const many = Array.from({ length: 12 }, (_, n) =>
      issue({ id: `i${String(n)}` }),
    )
    expect(filterIssues(many, {})).toHaveLength(DEFAULT_ISSUE_LIMIT)
    expect(filterIssues(many, { limit: 2 })).toHaveLength(2)
  })
})

describe('missingRefs', () => {
  it('is empty when nothing was pinned', () => {
    expect(missingRefs([issue()], undefined)).toEqual([])
  })

  it('names the pinned references nothing answers to any more', () => {
    // There is deliberately no foreign key from a widget to what it shows, so a
    // referent CAN vanish (or never have existed — an agent invents an id).
    expect(
      missingRefs([issue({ id: 'i1', nano: 'aaaa' })], ['i1', 'zzzz']),
    ).toEqual(['zzzz'])
  })
})

describe('issue-list: the body', () => {
  it('reads the issues fresh through the issues service’s own door', async () => {
    vi.mocked(listBoard).mockResolvedValue([
      issue({ id: 'i1', nano: 'aaaa', title: 'Widget catalog' }),
    ])
    const { Body } = parse({ statuses: ['open'] })
    render(<Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />)
    expect(await screen.findByText('Widget catalog')).toBeTruthy()
    expect(screen.getByText('aaaa')).toBeTruthy()
  })

  it('re-reads when the ship’s log says an issue moved', async () => {
    vi.mocked(listBoard)
      .mockResolvedValueOnce([issue({ title: 'Before' })])
      .mockResolvedValueOnce([issue({ title: 'After' })])
    const { Body } = parse({})
    const { rerender } = render(
      <Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />,
    )
    expect(await screen.findByText('Before')).toBeTruthy()
    // The stack bumps `revision` off the ONE subscription it already holds —
    // no second EventSource, no polling.
    rerender(
      <Body revision={1} onAnswer={vi.fn()} spent={false} answer={null} />,
    )
    expect(await screen.findByText('After')).toBeTruthy()
  })

  it('says the filter matches nothing rather than showing an empty box', async () => {
    vi.mocked(listBoard).mockResolvedValue([issue({ status: 'done' })])
    const { Body } = parse({ statuses: ['building'] })
    render(<Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />)
    expect(await screen.findByText(/no issues match/i)).toBeTruthy()
  })

  it('says so honestly when a pinned issue is gone now', async () => {
    vi.mocked(listBoard).mockResolvedValue([issue({ id: 'i1', nano: 'aaaa' })])
    const { Body } = parse({ issueIds: ['i1', 'zzzz'] })
    render(<Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />)
    // It still shows the issue that IS there, and names the one that isn't.
    expect(await screen.findByText('aaaa')).toBeTruthy()
    expect(screen.getByText(/gone now/i)).toBeTruthy()
    expect(screen.getByText(/zzzz/)).toBeTruthy()
  })

  it('says every pinned issue is gone rather than rendering nothing at all', async () => {
    vi.mocked(listBoard).mockResolvedValue([])
    const { Body } = parse({ issueIds: ['zzzz'] })
    render(<Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />)
    expect(await screen.findByText(/gone now/i)).toBeTruthy()
  })

  it('degrades to an honest line when the door fails, never a white screen', async () => {
    vi.mocked(listBoard).mockRejectedValue(new Error('database: down'))
    const { Body } = parse({})
    render(<Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />)
    await waitFor(() => {
      expect(screen.getByText(/couldn’t read the issues/i)).toBeTruthy()
    })
  })
})
