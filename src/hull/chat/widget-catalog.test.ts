import { beforeEach, describe, expect, it } from 'vitest'

import {
  describeWidgetKinds,
  knownWidgetKinds,
  registerWidgetKinds,
  validateWidgetProps,
  type WidgetKindSpec,
} from './widget-catalog'

// The seam that lets the hull's agent-facing door TALK about kinds it may not
// import. What a kind means lives in the rigging registry; the composition root
// hands the vocabulary down. These tests pin the two things that matter: the
// prose an agent reads, and the refusal it gets for a blob that doesn't fit.

const note: WidgetKindSpec = {
  kind: 'note',
  summary: 'A small markdown card.',
  propsDoc: '{ text: string }',
  example: { text: 'Standup at 09:30' },
  validate: (props) =>
    typeof (props as { text?: unknown }).text === 'string'
      ? null
      : 'text must be a non-empty string',
}

const choice: WidgetKindSpec = {
  kind: 'choice',
  summary: 'A question with a fixed set of answers.',
  propsDoc: '{ question: string, options: string[] }',
  example: { question: 'Ship it?', options: ['Yes', 'No'] },
  validate: () => null,
}

beforeEach(() => {
  registerWidgetKinds([])
})

describe('the registered catalog', () => {
  it('is empty until the composition root registers one', () => {
    expect(knownWidgetKinds()).toEqual([])
  })

  it('hands back exactly what was registered, in order', () => {
    registerWidgetKinds([choice, note])
    expect(knownWidgetKinds().map((k) => k.kind)).toEqual(['choice', 'note'])
  })

  it('replaces the catalog rather than appending to it', () => {
    registerWidgetKinds([choice])
    registerWidgetKinds([note])
    expect(knownWidgetKinds().map((k) => k.kind)).toEqual(['note'])
  })
})

describe('describeWidgetKinds', () => {
  it('names every kind with its prop shape and a worked example', () => {
    const text = describeWidgetKinds([choice, note])
    expect(text).toContain('choice')
    expect(text).toContain('{ question: string, options: string[] }')
    expect(text).toContain('note')
    expect(text).toContain('{ text: string }')
    // The example is JSON, because that's what the agent has to write.
    expect(text).toContain('{"text":"Standup at 09:30"}')
  })

  it('says so out loud when nothing is registered', () => {
    // A silently empty list would leave an agent guessing at kind names. The
    // real ship always registers at boot, so this reads as the fault it is.
    expect(describeWidgetKinds([])).toMatch(/no widget kinds/i)
  })
})

describe('validateWidgetProps', () => {
  it('accepts a blob that fits its kind', () => {
    expect(validateWidgetProps([note], 'note', { text: 'hi' })).toBeNull()
  })

  it('refuses a kind this ship cannot render, listing the ones it can', () => {
    const fault = validateWidgetProps([choice, note], 'poll', {})
    expect(fault).toContain('poll')
    expect(fault).toContain('choice')
    expect(fault).toContain('note')
  })

  it('refuses a blob that does not fit, quoting the kind and the reason', () => {
    const fault = validateWidgetProps([note], 'note', { text: 7 })
    expect(fault).toContain('note')
    expect(fault).toContain('text must be a non-empty string')
  })

  it('refuses everything when no kind is registered', () => {
    // Loud, not silent: an unregistered catalog is a boot fault, and an agent
    // storing unrenderable rows because of it would be far harder to see.
    expect(validateWidgetProps([], 'choice', {})).toMatch(/no widget kinds/i)
  })
})
