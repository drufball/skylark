import { useMemo } from 'react'
import { AlertTriangle } from 'lucide-react'

import { resolveWidget } from './registry'

/**
 * A widget row's body, resolved through the catalog — the core every surface
 * shares. A good row mounts its kind's own `Body`; a bad one gets one of the
 * two designed fault states (`unknown-kind` / `bad-props`), which are
 * different things to fix and so say which they are. The chrome AROUND the
 * body — a tile frame, the stack's compact/expanded shelf line — stays each
 * surface's own; only the resolve-and-render is one piece.
 */
export function ResolvedWidgetBody({
  widget,
  revision,
  spent,
  onAnswer,
}: {
  widget: { kind: string; props: unknown; answerValue: string | null }
  revision: number
  spent: boolean
  onAnswer: (value: string) => void
}) {
  // Memoised, and that's load-bearing rather than an optimisation: `parse`
  // returns a FRESH `Body` closure every call, and React treats a new
  // component identity as a different component — so re-resolving on each
  // render would unmount and remount the body, throwing away a live kind's
  // fetched contents and re-reading the service every time the surface
  // re-rendered. Keyed on the row's own fields, so it does remount when the
  // ROW actually changes, which is right — a route's `props` come straight off
  // loader data, whose identity moves only when the loader re-runs.
  const resolution = useMemo(
    () => resolveWidget(widget.kind, widget.props),
    [widget.kind, widget.props],
  )
  if (!resolution.ok) {
    return (
      <p className="flex items-start gap-1 p-2 text-xs text-muted-foreground">
        <AlertTriangle className="size-4 shrink-0" />
        {resolution.fault === 'unknown-kind'
          ? 'This ship doesn’t know this widget kind'
          : 'These props don’t parse'}
        : {resolution.detail}
      </p>
    )
  }
  return (
    <resolution.view.Body
      revision={revision}
      onAnswer={onAnswer}
      spent={spent}
      answer={widget.answerValue}
    />
  )
}
