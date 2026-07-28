// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@hull/issues/server', () => ({ listBoard: vi.fn() }))
import { listBoard } from '@hull/issues/server'

import { ResolvedWidgetBody } from './resolved-widget-body'

// The core every surface draws a widget row's body through: resolve the row via
// the catalog, mount the kind's Body, or show one of the two designed fault
// states. The chrome AROUND it (tile frame, compact/expanded shelf line) stays
// each surface's own.

afterEach(cleanup)
beforeEach(() => {
  vi.mocked(listBoard).mockReset()
  vi.mocked(listBoard).mockResolvedValue([])
})

const CHOICE = {
  kind: 'choice',
  props: { question: 'Ship it?', options: ['Yes', 'No'] },
  answerValue: null,
}

function paint(
  widget: { kind: string; props: unknown; answerValue: string | null },
  over: Partial<{
    revision: number
    spent: boolean
    onAnswer: (value: string) => void
  }> = {},
) {
  return (
    <ResolvedWidgetBody
      widget={widget}
      revision={over.revision ?? 0}
      spent={over.spent ?? false}
      onAnswer={over.onAnswer ?? vi.fn()}
    />
  )
}

describe('ResolvedWidgetBody', () => {
  it('renders the kind’s own body, wired to answer', () => {
    const onAnswer = vi.fn()
    render(paint(CHOICE, { onAnswer }))
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(onAnswer).toHaveBeenCalledWith('No')
  })

  it('hands the row’s recorded decision to the body', () => {
    render(paint({ ...CHOICE, answerValue: 'Yes' }))
    expect(screen.getByText('Yes')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('spends the buttons while an answer is in flight', () => {
    const onAnswer = vi.fn()
    render(paint(CHOICE, { onAnswer, spent: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    expect(onAnswer).not.toHaveBeenCalled()
  })

  it('draws the honest tile for a kind this ship doesn’t know, naming it', () => {
    render(paint({ kind: 'orrery', props: {}, answerValue: null }))
    expect(screen.getByText(/doesn’t know this widget kind/)).toBeTruthy()
    expect(screen.getByText(/orrery/)).toBeTruthy()
  })

  it('draws the honest tile for props that don’t parse, naming the field', () => {
    render(paint({ kind: 'note', props: { text: 7 }, answerValue: null }))
    expect(screen.getByText(/don’t parse/)).toBeTruthy()
    expect(screen.getByText(/text must be a non-empty string/)).toBeTruthy()
  })

  it('keeps a live body mounted across re-renders — no re-read, no remount', () => {
    // `parse` returns a FRESH Body closure per call, and a new component
    // identity would unmount the old one — throwing away fetched contents and
    // re-reading the service on every re-render. The memo inside is
    // load-bearing, so it's pinned.
    const widget = { kind: 'issue-list', props: {}, answerValue: null }
    const { rerender } = render(paint(widget))
    expect(vi.mocked(listBoard)).toHaveBeenCalledTimes(1)
    rerender(paint(widget, { spent: true }))
    rerender(paint(widget, { spent: false }))
    expect(vi.mocked(listBoard)).toHaveBeenCalledTimes(1)
  })
})
