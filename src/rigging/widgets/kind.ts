import type { ComponentType } from 'react'

import type { JsonValue } from '@hull/chat/widgets'

/**
 * The contract one widget kind fulfils — the leaf both the kinds and the registry
 * import, so neither has to import the other (a cycle `architecture.test.ts`
 * would fail the build over).
 *
 * A kind is four things: prose an agent reads, a total prop parser, the ship-log
 * topics an instance needs to stay live, and a component. Nothing else — and
 * notably no data: a widget's CONTENTS are fetched fresh on render and never
 * stored on the row (see the chat zine), so `props` only ever hold the question.
 */

/** What the stack hands a kind's body every time it renders it. */
export interface WidgetBodyProps {
  /**
   * Bumped whenever an event lands on one of this widget's declared `topics`.
   * A body that reads live data refetches when it changes; a static kind ignores
   * it. This is how live updates ride the ONE subscription the stack already
   * holds instead of each widget opening its own — and why nothing here polls.
   */
  revision: number
  /**
   * Post an answer as an ordinary chat message. Only a kind that offers answers
   * calls it; the hull gates the value against the row's own offer
   * (`offeredAnswer`), so a body can't invent one.
   */
  onAnswer: (value: string) => void
  /** An answer is already in flight — the buttons are spent until it settles. */
  spent: boolean
  /**
   * The decision already recorded on this row (`chat_widgets.answer_value`), or
   * null if it hasn't been answered.
   *
   * Non-null only on a spatial surface. The stack takes an answered widget away
   * — the turn is over — while a canvas keeps it, because a tile that vanished
   * out of a layout somebody made left a hole in it. That rule is the HULL's
   * (`answerDismisses`), not a rendering trick; what a kind does with the value
   * is this deck's business, and for `choice` it's showing which button won.
   */
  answer: string | null
}

/** A parsed widget instance, bound and ready for the stack to render. */
export interface WidgetView {
  /**
   * The one-or-two-line summary the COMPACT tile shows — what you read without
   * opening it. Derived from the props alone, never from fetched contents, so a
   * closed tile costs nothing.
   */
  headline: string
  /**
   * The ship-log topic patterns this instance needs to stay live, `[]` for a
   * kind with no live data. Declared per INSTANCE, not per kind, so a widget
   * pinned to three issues subscribes to those three rather than all of them.
   */
  topics: string[]
  /** The expanded body. Rendered only while the tile is open. */
  Body: ComponentType<WidgetBodyProps>
}

/**
 * A kind's parse result. Only `bad-props` is a kind's to report — "this ship
 * doesn't know this kind" is the registry's answer, and a kind can't say it about
 * itself.
 */
export type WidgetParse =
  | { ok: true; view: WidgetView }
  | { ok: false; detail: string }

/** Everything this ship knows about one widget kind. */
export interface WidgetKind {
  /** One line: what this kind is FOR, as the agent reads it in `chat_widget`. */
  summary: string
  /** The prop shape, spelled for a model (e.g. `{ text: string }`). */
  propsDoc: string
  /** A minimal blob that parses — the agent copies this and edits it. */
  example: JsonValue
  /**
   * Read a props blob into a renderable view, or say why not. **Total**: every
   * input produces a result and nothing throws, because agents write these props
   * and get them wrong — a bad blob must cost one honest tile, never a white
   * screen.
   */
  parse: (props: unknown) => WidgetParse
}

/** The props blob as a plain record, or null if it isn't one (array included). */
export function asRecord(json: unknown): Record<string, unknown> | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    return null
  return json as Record<string, unknown>
}

/** A present, non-blank string — what every text field in a props blob must be. */
export function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}
