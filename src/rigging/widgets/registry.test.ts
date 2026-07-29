import { describe, expect, it } from 'vitest'

import {
  describeWidgetKinds,
  validateWidgetProps,
} from '@hull/chat/widget-catalog'

import { resolveWidget, WIDGET_REGISTRY, widgetKindSpecs } from './registry'

// The catalog: kind → what it renders as, what its props mean, which topics keep
// it live. It lives in RIGGING because it knows every service's topic grammar —
// in the hull it would import every service with a widget, and the day `issues`
// wants one that's a cycle architecture.test.ts fails the build over.

describe('resolveWidget', () => {
  it('resolves every kind in the registry from its own example', () => {
    // The example is what an agent copies out of the tool description; if a
    // kind's own example doesn't resolve, the vocabulary is lying.
    for (const [kind, entry] of Object.entries(WIDGET_REGISTRY)) {
      expect(resolveWidget(kind, entry.example).ok, kind).toBe(true)
    }
  })

  it('refuses a kind this ship cannot render, naming it', () => {
    expect(resolveWidget('orrery', {})).toEqual({
      ok: false,
      fault: 'unknown-kind',
      detail: 'orrery',
    })
  })

  it('refuses the empty kind rather than guessing', () => {
    expect(resolveWidget('', {})).toMatchObject({ fault: 'unknown-kind' })
  })

  it('is case-sensitive — "Choice" is not "choice"', () => {
    // Kinds are opaque strings written by agents; matching loosely would render
    // a different widget than the row says it is.
    expect(
      resolveWidget('Choice', { question: 'q', options: ['a'] }),
    ).toMatchObject({ fault: 'unknown-kind' })
  })

  it('separates "unknown kind" from "bad props" — two different things to fix', () => {
    expect(resolveWidget('note', { text: 7 })).toEqual({
      ok: false,
      fault: 'bad-props',
      detail: 'text must be a non-empty string',
    })
  })

  it('never throws, whatever the props are', () => {
    for (const kind of [...Object.keys(WIDGET_REGISTRY), 'orrery']) {
      for (const props of [null, undefined, 7, 'x', [], {}, { a: { b: 1 } }]) {
        expect(() => resolveWidget(kind, props)).not.toThrow()
      }
    }
  })

  it('carries the kinds this slice promised', () => {
    expect(Object.keys(WIDGET_REGISTRY).sort()).toEqual([
      'choice',
      'config',
      'files',
      'inbox',
      'issue-list',
      'note',
    ])
  })
})

describe('widgetKindSpecs — the vocabulary handed to the hull', () => {
  it('describes every registered kind, generated from the entry itself', () => {
    const specs = widgetKindSpecs()
    expect(specs.map((s) => s.kind)).toEqual(Object.keys(WIDGET_REGISTRY))
    for (const spec of specs) {
      expect(spec.summary.length).toBeGreaterThan(0)
      expect(spec.propsDoc.length).toBeGreaterThan(0)
    }
  })

  it('is what the agent-facing description is built out of', () => {
    // A kind added to the registry shows up in the tool with no second edit —
    // that is the whole point of the seam.
    const text = describeWidgetKinds(widgetKindSpecs())
    for (const kind of Object.keys(WIDGET_REGISTRY)) {
      expect(text).toContain(kind)
    }
  })

  it('validates through each kind’s own parser', () => {
    const specs = widgetKindSpecs()
    expect(validateWidgetProps(specs, 'note', { text: 'hi' })).toBeNull()
    expect(validateWidgetProps(specs, 'note', {})).toContain(
      'text must be a non-empty string',
    )
    expect(
      validateWidgetProps(specs, 'issue-list', { statuses: ['nope'] }),
    ).toContain('not an issue status')
  })
})
