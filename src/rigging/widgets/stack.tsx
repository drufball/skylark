import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight, X } from 'lucide-react'

import { useShipLog, type EventSourceFactory } from '@rigging/lib/use-ship-log'
import { cn } from '@rigging/lib/utils'

import { TAP_TARGET } from './kind'
import { resolveWidget, type WidgetResolution } from './registry'

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
}

export interface WidgetStackProps {
  widgets: WidgetItem[]
  busy: boolean
  onAnswerWidget: (widgetId: string, value: string) => void
  onDismissWidget: (widgetId: string) => void
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
  eventSourceFactory,
}: WidgetStackProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Which widget this crew member has just answered. The server's own event
  // refreshes the stack a moment later; until then the buttons are spent, so a
  // double tap can't fire a second answer the door would only refuse. (The host
  // usually flips `busy` too, but a rigging component shouldn't need it to
  // avoid double-firing.)
  const [answered, setAnswered] = useState<string[]>([])

  // Forget what's spent the moment the host stops being busy. On a successful
  // answer the widget is gone from the stack anyway; on a FAILED one it's still
  // here, and it has to be answerable again rather than sitting there with dead
  // buttons forever. Compared during render so the first paint after the
  // request settles is already right.
  const [wasBusy, setWasBusy] = useState(busy)
  if (wasBusy !== busy) {
    setWasBusy(busy)
    if (!busy) setAnswered([])
  }

  const resolved = widgets.map((widget) => ({
    widget,
    resolution: resolveWidget(widget.kind, widget.props),
  }))

  // Every topic any open widget needs, deduped. A shelf of static widgets asks
  // for none, and `useShipLog` opens no connection at all for an empty set.
  const topics = [
    ...new Set(
      resolved.flatMap(({ resolution }) =>
        resolution.ok ? resolution.view.topics : [],
      ),
    ),
  ]
  // One counter for the whole shelf: a widget refetches when it moves. Coarse on
  // purpose — the same "something changed, read it again" the chat route already
  // does with `router.invalidate()`, and far simpler than routing each event to
  // the widget that asked for it.
  const [revision, setRevision] = useState(0)
  const onEvent = useCallback(() => {
    setRevision((n) => n + 1)
  }, [])
  useShipLog(topics, onEvent, eventSourceFactory)

  return (
    <div
      data-testid="widget-stack"
      className="max-h-52 shrink-0 overflow-y-auto border-t bg-muted/20 px-4 py-2"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-2">
        {resolved.map(({ widget, resolution }) => (
          <ChatWidget
            key={widget.id}
            widget={widget}
            resolution={resolution}
            revision={revision}
            expanded={expandedId === widget.id}
            spent={busy || answered.includes(widget.id)}
            onToggle={() => {
              setExpandedId((id) => (id === widget.id ? null : widget.id))
            }}
            onAnswer={(value) => {
              setAnswered((ids) => [...ids, widget.id])
              onAnswerWidget(widget.id, value)
            }}
            onDismiss={() => {
              onDismissWidget(widget.id)
            }}
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
  resolution,
  revision,
  expanded,
  spent,
  onToggle,
  onAnswer,
  onDismiss,
}: {
  widget: WidgetItem
  resolution: WidgetResolution
  revision: number
  expanded: boolean
  spent: boolean
  onToggle: () => void
  onAnswer: (value: string) => void
  onDismiss: () => void
}) {
  // Bring an opening tile to the top of the band. The shelf is height-capped on
  // purpose (it must never push the thread off a phone), which on a 390px screen
  // meant tapping the third tile opened a body almost entirely below the fold.
  // Only one tile is expanded at a time, so scrolling it to `start` hands it the
  // whole shelf without the shelf growing.
  const tileRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (expanded) tileRef.current?.scrollIntoView({ block: 'start' })
  }, [expanded])

  const dismiss = (
    <button
      type="button"
      aria-label={`Dismiss widget ${widget.id}`}
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
        {dismiss}
      </div>
    )
  }

  const { headline, Body } = resolution.view
  return (
    <div ref={tileRef} className="rounded-lg border bg-background">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`Open widget ${widget.id}`}
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
        {dismiss}
      </div>
      {/* The body mounts only while the tile is open, so a live kind isn't
          reading a service for a tile nobody has looked at. */}
      {expanded && (
        <Body revision={revision} onAnswer={onAnswer} spent={spent} />
      )}
    </div>
  )
}
