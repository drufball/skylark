/**
 * What a widget ROW means to the hull — and deliberately nothing more.
 *
 * **Hull holds the row; rigging holds the meaning.** The table keeps a `kind`
 * string and an opaque `props` blob (schema.ts); what a kind renders as, and
 * which services it reads, lives in the rigging catalog
 * ([`@rigging/widgets`](../../rigging/widgets/zine.md)). That's a structural
 * requirement, not a preference: a catalog in the hull would have to import every
 * service that has a widget, and the day `issues` wants one you get
 * `hull/issues → hull/widgets → hull/issues` — a cycle `architecture.test.ts`
 * fails the build over, correctly. Rigging may import every hull service freely.
 *
 * So the hull keeps exactly the two things that are properties of the ROW rather
 * than of any kind:
 *
 * - **the answer contract** (`offeredAnswer`) — you may only post back a value
 *   the row itself offered. Read structurally from the blob, so hull enforces it
 *   without knowing a single kind by name;
 * - **the answer's shape as a message** (`answerMessageBody`) — because the
 *   answer is an ordinary chat message, and composing it is chat's job.
 *
 * No database, no node builtins: a leaf like topic.ts, so the browser can import
 * it too.
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

/**
 * What a row puts on offer to be answered: the question it asked and the exact
 * values it will accept back.
 */
export interface WidgetOffer {
  question: string
  options: string[]
}

/** A present, non-blank string — what every text field in a props blob must be. */
function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The answers this row offers, or null if it offers none.
 *
 * This is the **answer convention every answerable kind spells the same way**: a
 * `question` string plus a non-empty `options` array of non-empty strings. Stated
 * as a property of the blob rather than of a kind, which is precisely what lets
 * the hull enforce "you may only post back a value the row offered" while knowing
 * nothing about `choice` or anything else. A kind that offers no answers (a
 * `note`, an `issue-list`) simply has no options on its blob, so answering it is
 * refused for free — and so is answering a blob an agent malformed.
 *
 * Total: every input returns an offer or null, nothing throws.
 */
export function offeredAnswer(props: unknown): WidgetOffer | null {
  if (typeof props !== 'object' || props === null || Array.isArray(props))
    return null
  const record = props as Record<string, unknown>
  if (!isFilledString(record.question)) return null
  const { options } = record
  if (
    !Array.isArray(options) ||
    options.length === 0 ||
    !options.every(isFilledString)
  ) {
    return null
  }
  // Rebuilt field by field, not spread: an agent's extra keys never become
  // part of the offer.
  return { question: record.question, options }
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
