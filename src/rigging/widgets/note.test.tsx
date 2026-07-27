// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { noteKind, noteHeadline } from './note'

afterEach(cleanup)

/** The view a good blob parses to, or a failure the test can read. */
function parse(props: unknown) {
  const result = noteKind.parse(props)
  if (!result.ok) throw new Error(`expected props to parse: ${result.detail}`)
  return result.view
}

describe('noteHeadline', () => {
  it('is the first line of the note', () => {
    expect(noteHeadline('Standup at 09:30\nbring the board')).toBe(
      'Standup at 09:30',
    )
  })

  it('skips leading blank lines rather than headlining with nothing', () => {
    expect(noteHeadline('\n\n  Standup at 09:30')).toBe('Standup at 09:30')
  })

  it('strips the markdown that would read as punctuation in a one-line tile', () => {
    expect(noteHeadline('# Standup')).toBe('Standup')
    expect(noteHeadline('- buy milk')).toBe('buy milk')
    expect(noteHeadline('* buy milk')).toBe('buy milk')
    expect(noteHeadline('> quoted')).toBe('quoted')
  })

  it('falls back to a label when the note is only whitespace', () => {
    // parse() refuses a blank note, so this is belt-and-braces: the headline
    // must never be an empty tap target with nothing in it.
    expect(noteHeadline('   \n  ')).toBe('Note')
  })
})

describe('note: parsing', () => {
  it('headlines with the first line and subscribes to nothing', () => {
    const view = parse({ text: '# Standup\nat 09:30' })
    expect(view.headline).toBe('Standup')
    // The trivial case on purpose: a note reads no service, so no topic.
    expect(view.topics).toEqual([])
  })

  it.each([
    ['null', null],
    ['a string', 'just the text'],
    ['a number', 7],
    ['an array', ['a note']],
  ])('refuses props that are %s, not an object', (_label, props) => {
    expect(noteKind.parse(props)).toEqual({
      ok: false,
      detail: 'expected an object of props',
    })
  })

  it.each([
    ['missing', {}],
    ['not a string', { text: 42 }],
    ['blank', { text: '   ' }],
  ])('refuses text that is %s', (_label, props) => {
    expect(noteKind.parse(props)).toEqual({
      ok: false,
      detail: 'text must be a non-empty string',
    })
  })

  it('parses its own documented example', () => {
    expect(noteKind.parse(noteKind.example).ok).toBe(true)
  })
})

describe('note: the body', () => {
  it('renders the note as markdown', () => {
    const { Body } = parse({ text: '# Standup\n\nBring the **board**.' })
    render(<Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />)
    expect(screen.getByRole('heading', { name: 'Standup' })).toBeTruthy()
    expect(screen.getByText('board').tagName).toBe('STRONG')
  })

  it('offers nothing to answer — a note is read, not decided', () => {
    const { Body } = parse({ text: 'Standup at 09:30' })
    render(<Body revision={0} onAnswer={vi.fn()} spent={false} answer={null} />)
    expect(screen.queryAllByRole('button')).toEqual([])
  })
})
