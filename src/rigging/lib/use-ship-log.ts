import { useEffect, useRef } from 'react'

// The client half of the ship's log: subscribe to live events over SSE and run
// a callback when one arrives. This REPLACES polling — a view re-renders only
// when the server says something actually changed, not on a timer. The durable
// log behind the stream (hull/events) means a dropped connection replays what it
// missed via Last-Event-ID — the browser's EventSource sends that header for us.

/** One event as it comes off the wire (the `data:` JSON from the SSE route). */
export interface ShipLogEvent {
  id: string
  type: string
  source: string
  scope: string
  payload: unknown
}

/** Open an SSE connection to the ship's log. Pulled out so tests can inject a fake. */
export type EventSourceFactory = (url: string) => EventSourceLike

/** The slice of the DOM EventSource the hook uses — a real EventSource satisfies it. */
export interface EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null
  close: () => void
}

/**
 * Subscribe to the ship's log for the given topics (scopes), invoking `onEvent`
 * for each event. Reopens the connection only when the topic set changes, and
 * closes it on unmount. `topics` is joined into the `?topics=` query the SSE
 * route parses; an empty set subscribes to nothing (no connection opened).
 *
 * `onEvent` is read through a ref so a fresh closure each render never tears the
 * connection down — only a real change in topics does. `factory` defaults to the
 * browser's EventSource and exists so tests can drive the hook without a server.
 */
export function useShipLog(
  topics: string[],
  onEvent: (event: ShipLogEvent) => void,
  factory: EventSourceFactory = defaultFactory,
): void {
  const key = topics.join(',')
  const onEventRef = useRef(onEvent)
  // Keep the ref pointed at the latest callback (in an effect, not during
  // render) so the subscription effect below can read fresh without re-running.
  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    if (key === '') return
    const source = factory(`/api/stream?topics=${encodeURIComponent(key)}`)
    source.onmessage = (e: MessageEvent<string>) => {
      try {
        onEventRef.current(JSON.parse(e.data) as ShipLogEvent)
      } catch {
        // Ignore a malformed frame rather than killing the subscription.
      }
    }
    return () => {
      source.close()
    }
  }, [key, factory])
}

/* v8 ignore start -- browser EventSource construction, exercised in the real app not jsdom */
const defaultFactory: EventSourceFactory = (url) => new EventSource(url)
/* v8 ignore stop */
