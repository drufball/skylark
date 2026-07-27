// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { offeredAnswer } from '@hull/chat/widgets'

import { choiceKind } from './choice'

afterEach(cleanup)

// `choice` is the interactive kind: a question with a fixed set of answers. The
// exhaustive cases here are the malformed ones — agents write these props.

/** The view a good blob parses to, or a failure the test can read. */
function parse(props: unknown) {
  const result = choiceKind.parse(props)
  if (!result.ok) throw new Error(`expected props to parse: ${result.detail}`)
  return result.view
}

describe('choice: parsing', () => {
  it('headlines with the question and subscribes to nothing', () => {
    const view = parse({ question: 'Ship it?', options: ['Yes', 'No'] })
    expect(view.headline).toBe('Ship it?')
    // Zero service coupling: a choice needs no live data, so it needs no topic.
    expect(view.topics).toEqual([])
  })

  it('keeps a single option — a one-button acknowledgement is legal', () => {
    expect(choiceKind.parse({ question: 'Seen?', options: ['Ok'] }).ok).toBe(
      true,
    )
  })

  it.each([
    ['null', null],
    ['a string', '{"question":"q"}'],
    ['a number', 7],
    ['an array', [{ question: 'q' }]],
  ])('refuses props that are %s, not an object', (_label, props) => {
    expect(choiceKind.parse(props)).toEqual({
      ok: false,
      detail: 'expected an object of props',
    })
  })

  it.each([
    ['missing', {}],
    ['not a string', { question: 42, options: ['Yes'] }],
    ['blank', { question: '   ', options: ['Yes'] }],
  ])('refuses a question that is %s', (_label, props) => {
    expect(choiceKind.parse(props)).toEqual({
      ok: false,
      detail: 'question must be a non-empty string',
    })
  })

  it.each([
    ['missing', { question: 'q' }],
    ['not an array', { question: 'q', options: 'Yes' }],
    ['empty', { question: 'q', options: [] }],
    ['holding a non-string', { question: 'q', options: ['Yes', 3] }],
    ['holding a blank string', { question: 'q', options: ['Yes', ' '] }],
  ])('refuses options that are %s', (_label, props) => {
    expect(choiceKind.parse(props)).toEqual({
      ok: false,
      detail: 'options must be a non-empty array of non-empty strings',
    })
  })

  it('reports the question fault first when both are wrong', () => {
    // One fault at a time, in field order: the tile shows one honest line.
    expect(choiceKind.parse({})).toMatchObject({
      detail: 'question must be a non-empty string',
    })
  })

  it('parses its own documented example', () => {
    // The example is what an agent copies out of the tool description, so it had
    // better be a blob this ship can render.
    expect(choiceKind.parse(choiceKind.example).ok).toBe(true)
  })
})

describe('choice: the buttons and the door agree', () => {
  it('offers exactly the answers the hull will accept back', () => {
    // The load-bearing cross-deck invariant. The buttons come from THIS parser;
    // the whitelist the answer door checks against comes from the hull's
    // structural `offeredAnswer` on the same row. If they ever disagreed, a tap
    // would be refused by the very door that drew the button — so it's pinned
    // here, where both sides are in scope, rather than trusted to stay in step.
    const props = { question: 'Ship it?', options: ['Yes', 'Not yet'] }
    const { Body } = parse(props)
    render(<Body revision={0} onAnswer={vi.fn()} spent={false} />)
    const labels = screen.getAllByRole('button').map((b) => b.textContent)
    expect(labels).toEqual(offeredAnswer(props)?.options)
  })

  it('is refused by the door in exactly the cases it refuses to render', () => {
    for (const props of [
      {},
      { question: 'q' },
      { question: 'q', options: [] },
      { question: ' ', options: ['Yes'] },
      { question: 'q', options: ['Yes', ' '] },
    ]) {
      expect(choiceKind.parse(props).ok).toBe(false)
      expect(offeredAnswer(props)).toBeNull()
    }
  })
})

describe('choice: the body', () => {
  it('offers every option as a tappable button', () => {
    const { Body } = parse({ question: 'Ship it?', options: ['Yes', 'No'] })
    const onAnswer = vi.fn()
    render(<Body revision={0} onAnswer={onAnswer} spent={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(onAnswer).toHaveBeenCalledWith('No')
  })

  it('spends the buttons while an answer is in flight', () => {
    const { Body } = parse({ question: 'Ship it?', options: ['Yes'] })
    const onAnswer = vi.fn()
    render(<Body revision={0} onAnswer={onAnswer} spent />)
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(onAnswer).not.toHaveBeenCalled()
  })
})
