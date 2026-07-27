/**
 * What a widget's `props` blob means — the pure half of the widget contract,
 * shared by the doors (which validate an answer against it) and the view (which
 * renders it). No database, no node builtins: a leaf like topic.ts, so the
 * browser can import it.
 *
 * The design constraint that shapes everything here: **agents write these props,
 * and agents get them wrong.** So `parseProps` never throws and never returns a
 * half-parsed shape — it returns either a fully-typed `props` or an honest
 * refusal the view renders as a tile ("these props don't parse", "this ship
 * doesn't know this widget kind"). A malformed blob costs you one dud tile, not
 * a white screen.
 *
 * The unknown-kind case is deliberate, not defensive: later slices let a ship
 * define its own widget kinds, so a row WILL outlive the definition that made
 * it. A widget whose kind no longer exists must still say so out loud.
 */

/** The placements a widget can take. Only the stack above the composer exists yet. */
export const STACK_PLACEMENT = 'stack'

/**
 * Anything a props blob may hold. "Opaque" in the row's sense, but spelled out
 * rather than left as `unknown`, because props cross the client/server line: a
 * `createServerFn` door only carries a type it can prove is serializable.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Every widget kind this ship knows how to parse and render. */
export const WIDGET_KINDS = ['choice'] as const

/** `choice`: one question, a fixed set of answers. Yes/no is `['Yes','No']`. */
export interface ChoiceProps {
  question: string
  options: string[]
}

/**
 * Why a props blob was refused. `unknown-kind` means the row names a widget
 * this ship can't render at all; `bad-props` means the kind is known but the
 * blob doesn't fit it. Two different tiles, because they're two different
 * things to fix.
 */
export type WidgetFault = 'unknown-kind' | 'bad-props'

/**
 * A parsed widget, or the reason it isn't one. `detail` is the technical half
 * (the offending kind, or which field is wrong) — the view supplies the
 * human-facing headline around it.
 */
export type ParsedWidget =
  | { ok: true; kind: 'choice'; props: ChoiceProps }
  | { ok: false; fault: WidgetFault; detail: string }

/** A parsed widget, narrowed to the ones that parsed. */
export type GoodWidget = Extract<ParsedWidget, { ok: true }>

function refuse(fault: WidgetFault, detail: string): ParsedWidget {
  return { ok: false, fault, detail }
}

/** A present, non-blank string — what every text field in a props blob must be. */
function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** The props blob as a plain record, or null if it isn't one (array included). */
function asRecord(json: unknown): Record<string, unknown> | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    return null
  return json as Record<string, unknown>
}

function parseChoice(json: unknown): ParsedWidget {
  const record = asRecord(json)
  if (!record) return refuse('bad-props', 'expected an object of props')
  if (!isFilledString(record.question))
    return refuse('bad-props', 'question must be a non-empty string')
  const { options } = record
  if (
    !Array.isArray(options) ||
    options.length === 0 ||
    !options.every(isFilledString)
  ) {
    return refuse(
      'bad-props',
      'options must be a non-empty array of non-empty strings',
    )
  }
  // Rebuilt field by field, not spread: an agent's extra keys never become props.
  return {
    ok: true,
    kind: 'choice',
    props: { question: record.question, options },
  }
}

/**
 * Read a widget row's `kind` + `props` into something renderable, or say why
 * not. Total: every input produces a result, nothing throws. `kind` is matched
 * exactly — a near-miss like `Choice` is an unknown kind, not a typo we guess
 * at, because guessing would render a different widget than the row claims.
 */
export function parseProps(kind: string, json: unknown): ParsedWidget {
  switch (kind) {
    case 'choice':
      return parseChoice(json)
    default:
      return refuse('unknown-kind', kind)
  }
}

/**
 * The answers a parsed widget will accept — the whitelist `answerWidget` checks
 * a submitted value against, so a value an agent never offered can never be
 * posted. One kind today, so it's a direct read; when a second kind lands this
 * becomes a switch over `parsed.kind`, and a kind that isn't answerable at all
 * has to say so here rather than defaulting to "anything goes".
 */
export function answerOptions(parsed: GoodWidget): string[] {
  return parsed.props.options
}

/**
 * The body of the ordinary chat message an answer posts. The question is quoted
 * above the answer so the transcript stands on its own forever — the widget row
 * is dismissed and gone from the stack, but the conversation still reads as a
 * question and its answer. Every line of the question is quoted, or a
 * multi-line question's tail would read as the answer.
 */
export function answerMessageBody(question: string, value: string): string {
  const quoted = question
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `${quoted}\n\n${value}`
}
