import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight, LayoutGrid, X } from 'lucide-react'

import { TAP_TARGET } from '@rigging/lib/tap-target'
import type { EventSourceFactory } from '@rigging/lib/use-ship-log'
import { cn } from '@rigging/lib/utils'

import { useAnswerGuard } from './answer-guard'
import { resolveWidget, type WidgetResolution } from './registry'
import { ResolvedWidgetBody } from './resolved-widget-body'
import { useWidgetLiveRevision } from './use-widget-live-revision'

/**
 * The widget stack: the live little views a chat is keeping open, sitting directly
 * above the composer where the next thing you'd touch belongs.
 *
 * It is deliberately a THIN band. One widget expands at a time and the rest stay
 * a clamped line each, and the whole band is height-capped and scrollable — so
 * five open widgets can never push the message thread off a phone screen. The
 * stack is a shelf, not a second pane.
 *
 * It knows no kind by name. Every row goes through `resolveWidget`, so adding a
 * kind is a registry edit and nothing here (or in `chat.tsx`) moves. The stack
 * owns exactly one thing the kinds can't: the ONE ship-log subscription over the
 * union of its widgets' declared topics. A bumped `revision` is how a live kind
 * hears about it — one `EventSource` for the whole shelf instead of one per
 * widget, and no polling anywhere.
 */

/**
 * A widget as the loader hands it over: a `kind` and an opaque `props` blob,
 * exactly as the row holds them. The STACK is what resolves it — so a blob an
 * agent got wrong is one honest tile in the shelf, not a failed page load.
 */
export interface WidgetItem {
  id: string
  kind: string
  props: unknown
  /** Who put it here — a widget is always somebody's judgment, so it's named. */
  createdByHandle: string
  /**
   * The decision recorded on the row, or null. Almost always null in the shelf,
   * because answering a STACK widget dismisses it — but a canvas tile that was
   * answered and then sent back up would otherwise re-draw live buttons the
   * door can only refuse.
   */
  answerValue: string | null
}

export interface WidgetStackProps {
  widgets: WidgetItem[]
  busy: boolean
  onAnswerWidget: (widgetId: string, value: string) => void
  onDismissWidget: (widgetId: string) => void
  /**
   * Send a widget down to the canvas page the viewer has open — the human half
   * of the move an agent makes with `chat_widget`'s `place`. Omitted when there
   * is no page to send it to (a chat with no canvas yet), so the affordance
   * never appears with nowhere to go.
   */
  onPinWidget?: (widgetId: string) => void
  /**
   * How the ship-log subscription opens its stream. Defaults to the browser's
   * `EventSource`; exists so a test can drive the live path without a server,
   * exactly as `useShipLog`'s own factory does.
   */
  eventSourceFactory?: EventSourceFactory
}

export function WidgetStack({
  widgets,
  busy,
  onAnswerWidget,
  onDismissWidget,
  onPinWidget,
  eventSourceFactory,
}: WidgetStackProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Which widget this crew member has just answered: the buttons are spent until
  // the refreshed rows arrive, so a double tap can't fire a second answer the
  // door would only refuse. Shared with the canvas, which answers the same rows.
  const answers = useAnswerGuard(busy)

  // One counter for the whole shelf, fed by the ONE subscription over every
  // topic any widget here declares: a live widget refetches when it moves.
  const revision = useWidgetLiveRevision(widgets, eventSourceFactory)

  return (
    <div
      data-testid="widget-stack"
      className="max-h-52 shrink-0 overflow-y-auto border-t bg-muted/20 px-4 py-2"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {widgets.map((widget) => (
          <ChatWidget
            key={widget.id}
            widget={widget}
            revision={revision}
            expanded={expandedId === widget.id}
            spent={answers.spent(widget.id)}
            onToggle={() => {
              setExpandedId((id) => (id === widget.id ? null : widget.id))
            }}
            onAnswer={(value) => {
              answers.mark(widget.id)
              onAnswerWidget(widget.id, value)
            }}
            onDismiss={() => {
              onDismissWidget(widget.id)
            }}
            onPin={
              onPinWidget &&
              (() => {
                onPinWidget(widget.id)
              })
            }
          />
        ))}
      </div>
    </div>
  )
}

/**
 * One widget, rendered two ways: **compact** (the kind's headline, clamped, plus
 * who asked) and **expanded** (the same line plus the kind's own body). Clicking
 * the compact line expands it.
 *
 * A widget whose props don't parse, or whose kind this ship doesn't know, gets an
 * honest tile instead — it says which of the two it is, and it can still be
 * dismissed, so a bad blob is never a dead end you can't clear. Those two tiles
 * are designed states, not error handling: rows outlive the kinds that made them.
 */
function ChatWidget({
  widget,
  revision,
  expanded,
  spent,
  onToggle,
  onAnswer,
  onDismiss,
  onPin,
}: {
  widget: WidgetItem
  revision: number
  expanded: boolean
  spent: boolean
  onToggle: () => void
  onAnswer: (value: string) => void
  onDismiss: () => void
  onPin?: () => void
}) {
  // Resolved here only for the tile's own chrome — the headline and the honest
  // fault tile below. The body itself is `ResolvedWidgetBody`, which owns the
  // load-bearing memoisation of the resolve.
  const resolution: WidgetResolution = resolveWidget(widget.kind, widget.props)
  // What every control on this tile is NAMED after. It used to be the row's
  // primary key — "Dismiss widget 019fa5b1-f0f1-…" — which is a database column
  // escaping into the UI, and the only thing a screen reader user would hear
  // about the tile. A failed resolution has no headline, so it falls back to the
  // kind, exactly as the canvas grip already did.
  const label = resolution.ok ? resolution.view.headline : widget.kind

  // Bring an opening tile to the top of the band. The shelf is height-capped on
  // purpose (it must never push the thread off a phone), which on a 390px screen
  // meant tapping the third tile opened a body almost entirely below the fold.
  // Only one tile is expanded at a time, so scrolling it to `start` hands it the
  // whole shelf without the shelf growing.
  const tileRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (expanded) tileRef.current?.scrollIntoView({ block: 'start' })
  }, [expanded])

  // Keeping it is the state-shaped move: this stops being something to answer
  // and becomes something you watch. Sits beside dismiss because they are the
  // two ways a widget leaves the shelf.
  const pin = onPin ? (
    <button
      type="button"
      aria-label={`Keep ${label} on the canvas`}
      onClick={onPin}
      className={cn(
        'flex shrink-0 items-center justify-center px-2',
        'text-muted-foreground hover:text-foreground',
        TAP_TARGET,
      )}
    >
      <LayoutGrid className="size-4" />
    </button>
  ) : null

  const dismiss = (
    <button
      type="button"
      aria-label={`Dismiss ${label}`}
      onClick={onDismiss}
      className={cn(
        'flex shrink-0 items-center justify-center px-3',
        'text-muted-foreground hover:text-destructive',
        TAP_TARGET,
      )}
    >
      <X className="size-4" />
    </button>
  )

  if (!resolution.ok) {
    return (
      <div className="flex items-center gap-1 rounded-lg border border-dashed bg-background px-3 py-1">
        <AlertTriangle className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 py-1">
          <p className="text-sm">
            {resolution.fault === 'unknown-kind'
              ? 'This ship doesn’t know this widget kind'
              : 'These props don’t parse'}
          </p>
          {/* `detail` carries the technical half either way — the offending
              kind, or which field is wrong. */}
          <p className="truncate text-xs text-muted-foreground">
            {resolution.detail}
          </p>
        </div>
        {pin}
        {dismiss}
      </div>
    )
  }

  const { headline } = resolution.view
  return (
    <div ref={tileRef} className="rounded-lg border bg-background">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`Open ${label}`}
          aria-expanded={expanded}
          onClick={onToggle}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-3 text-left',
            TAP_TARGET,
          )}
        >
          <ChevronRight
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90',
            )}
          />
          {/* Two lines, not one: on a 390px phone a single truncated line left
              about five words of the question readable, which is no question at
              all. Clamped rather than free-flowing so the tile stays a tile. */}
          <span
            data-testid="widget-headline"
            className="min-w-0 flex-1 line-clamp-2 py-1 text-sm"
          >
            {headline}
          </span>
          {/* Who asked is context, not the point — the first thing to go when
              the screen is narrow, so the headline gets the width. */}
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            @{widget.createdByHandle}
          </span>
        </button>
        {pin}
        {dismiss}
      </div>
      {/* The body mounts only while the tile is open, so a live kind isn't
          reading a service for a tile nobody has looked at. */}
      {expanded && (
        <ResolvedWidgetBody
          widget={widget}
          revision={revision}
          spent={spent}
          onAnswer={onAnswer}
        />
      )}
    </div>
  )
}
