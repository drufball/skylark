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

/**
 * The two surfaces a widget can be on, and the division of labour between them:
 *
 * - **stack** — turn-shaped. Ephemeral, answer-shaped widgets the agent needs
 *   something from you about right now, above the composer, gone once answered.
 * - **canvas** — state-shaped. Persistent readouts and controls YOU arranged, on
 *   a page of the chat's canvas, staying put until you move them.
 *
 * `placement` is the discriminator, and a widget crosses between them by an
 * ordinary row update — deliberately not a special mechanism, because that plain
 * update is also how an agent RAISES a canvas widget into the stack when it needs
 * your attention.
 */
export const STACK_PLACEMENT = 'stack'
export const CANVAS_PLACEMENT = 'canvas'

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

// --- Canvas geometry -------------------------------------------------------
//
// Where a canvas widget sits on its page. Pure and node-free like the rest of
// this module, because BOTH sides need the same arithmetic: the doors clamp what
// an agent or a drag writes, and the browser draws the tile from the same
// numbers. One home for it, so a dragged tile and a stored row can't disagree.

/**
 * How many columns a canvas page is, on every screen that draws it as a grid.
 * Four, because a widget wants at least a quarter of the pane to be readable and
 * a phone renders the same page as ONE column anyway (in arrangement order) —
 * the column count is a desktop affordance, never a layout the row depends on.
 */
export const CANVAS_COLUMNS = 4

/** A widget's cell rectangle on a canvas page: top-left corner plus a span. */
export interface CanvasBox {
  gridX: number
  gridY: number
  gridW: number
  gridH: number
}

/** What a widget gets when nobody said where to put it: a half-width, squat tile. */
export const DEFAULT_CANVAS_BOX: CanvasBox = {
  gridX: 0,
  gridY: 0,
  gridW: 2,
  gridH: 2,
}

/** Round to a whole cell and hold it at or above `min` — the grid has no halves. */
function cell(
  value: number | undefined,
  fallback: number,
  min: number,
): number {
  const n = Math.round(value ?? fallback)
  return Number.isFinite(n) && n > min ? n : min
}

/**
 * Pull a box into the grid: whole cells, at least 1×1, never off an edge.
 *
 * **Clamped, never refused.** Agents write these coordinates by hand and will
 * overshoot; a tile the crew can then drag is a state they can see and fix,
 * whereas a rejected write teaches the writer nothing — the same reasoning that
 * stores a malformed props blob rather than rejecting it.
 */
export function clampCanvasBox(box: Partial<CanvasBox>): CanvasBox {
  const gridX = Math.min(
    cell(box.gridX, DEFAULT_CANVAS_BOX.gridX, 0),
    CANVAS_COLUMNS - 1,
  )
  return {
    gridX,
    gridY: cell(box.gridY, DEFAULT_CANVAS_BOX.gridY, 0),
    gridW: Math.min(
      cell(box.gridW, DEFAULT_CANVAS_BOX.gridW, 1),
      CANVAS_COLUMNS - gridX,
    ),
    gridH: cell(box.gridH, DEFAULT_CANVAS_BOX.gridH, 1),
  }
}

/** Do two boxes share a cell? */
function overlaps(a: CanvasBox, b: CanvasBox): boolean {
  return (
    a.gridX < b.gridX + b.gridW &&
    b.gridX < a.gridX + a.gridW &&
    a.gridY < b.gridY + b.gridH &&
    b.gridY < a.gridY + a.gridH
  )
}

/**
 * Where a widget lands when nobody said where — the first free slot, scanning
 * left-to-right then down. First-FIT rather than "below everything", so a narrow
 * tile fills the hole beside a wide one instead of leaving the page full of gaps
 * the crew has to tidy by hand. The scan is bounded by the page's own depth plus
 * one row, which always has room.
 */
export function nextCanvasSlot(
  taken: CanvasBox[],
  size: { gridW: number; gridH: number },
): { gridX: number; gridY: number } {
  const depth = taken.reduce(
    (low, box) => Math.max(low, box.gridY + box.gridH),
    0,
  )
  for (let gridY = 0; gridY <= depth; gridY++) {
    for (let gridX = 0; gridX + size.gridW <= CANVAS_COLUMNS; gridX++) {
      // Field by field, never a spread of `size`: a caller handing over a whole
      // box (which the place door does) would otherwise spread its own corner
      // back over the one we're testing, and every widget would land at 0,0.
      const candidate = { gridX, gridY, gridW: size.gridW, gridH: size.gridH }
      if (!taken.some((box) => overlaps(box, candidate))) {
        return { gridX, gridY }
      }
    }
  }
  /* v8 ignore next 2 -- unreachable: row `depth` is empty by construction, so
     the scan above always returns before falling out of it */
  return { gridX: 0, gridY: depth }
}

/**
 * The box a widget actually gets: the one asked for if those cells are free,
 * otherwise the first free slot of the same size.
 *
 * **The canvas never draws two tiles on top of each other.** CSS grid will
 * happily stack them, and the result reads as a rendering bug rather than a
 * layout — observed live, dragging one tile onto another. Refusing the write
 * would be worse (a drag that silently does nothing), and pushing the neighbours
 * around would rearrange a page somebody deliberately laid out, so the tile
 * being moved is the one that yields.
 */
export function freeCanvasBox(
  taken: CanvasBox[],
  desired: CanvasBox,
): CanvasBox {
  if (!taken.some((box) => overlaps(box, desired))) return desired
  return { ...desired, ...nextCanvasSlot(taken, desired) }
}
