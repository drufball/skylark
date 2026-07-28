import { useCallback, useState } from 'react'

import { useShipLog, type EventSourceFactory } from '@rigging/lib/use-ship-log'

import { resolveWidget } from './registry'

/**
 * The one live subscription a widget surface holds, and the counter it feeds.
 *
 * Every surface that renders widget rows — the stack, the chat canvas, the
 * home canvas — needs the same machinery: resolve each row through the
 * catalog, union the topics the kinds declare (a row that doesn't resolve
 * declares none), and open ONE `useShipLog` subscription over the lot instead
 * of one per widget. Each event bumps the returned `revision`; a live `Body`
 * refetches when it moves. Coarse on purpose — the same "something changed,
 * read it again" the chat route already does with `router.invalidate()` —
 * and no polling anywhere.
 *
 * The topics are recomputed each render rather than memoised: `useShipLog`
 * keys on the JOINED string, so a fresh array of the same topics never
 * reopens the connection. An empty union opens no connection at all.
 */
export function useWidgetLiveRevision(
  widgets: { kind: string; props: unknown }[],
  eventSourceFactory?: EventSourceFactory,
): number {
  const topics = [
    ...new Set(
      widgets.flatMap((widget) => {
        const resolution = resolveWidget(widget.kind, widget.props)
        return resolution.ok ? resolution.view.topics : []
      }),
    ),
  ]
  const [revision, setRevision] = useState(0)
  const onEvent = useCallback(() => {
    setRevision((n) => n + 1)
  }, [])
  useShipLog(topics, onEvent, eventSourceFactory)
  return revision
}
