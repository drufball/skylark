import type { EventRow } from './schema'
import type { NotifyPayload } from './bus'
import { canViewAudience, matchesTopic, REPLAY_PAGE_SIZE } from './service'
import { sseFrame, toStreamEvent } from './sse'

// The coordination behind the /api/stream SSE route, lifted out of the route so
// it can be unit-tested without a ReadableStream, a socket, or Postgres.
//
// The hard part isn't the wire format (that's sse.ts) or the replay query
// (that's service.ts) — it's the *ordering*: subscribe to the live bus BEFORE
// replaying history, buffer whatever arrives in the gap, then flush the buffer
// deduped against what replay already sent, and only then go live. Get that
// wrong and an event posted mid-replay is silently lost, or a boundary event is
// sent twice. That's exactly the seam worth pinning with tests.
//
// The impure edges — the ReadableStream controller, the heartbeat timer, the
// abort wiring — stay in the route. Everything here is driven through injected
// boundaries so a test can feed a fake bus + fake DB and assert the frames.

/** The injected boundaries the coordinator drives. */
export interface ShipLogStreamDeps {
  /** Subscribe to the live in-process bus; returns an unsubscribe. */
  subscribe: (listener: (note: NotifyPayload) => void) => () => void
  /**
   * A page of durable events newer than `sinceId` for these topics/audience.
   *
   * Paging contract: returns a FULL `REPLAY_PAGE_SIZE` page iff more may remain
   * — the coordinator keeps fetching until a short (or empty) page signals the
   * log is drained. (A fake simulating "there's more" must return exactly
   * `REPLAY_PAGE_SIZE` rows.) This mirrors `service.ts`'s `listEventsSince` cap.
   */
  listEventsSince: (opts: {
    topicPatterns: string[]
    audience: string
    sinceId?: string
  }) => Promise<EventRow[]>
  /** Read one durable event by id (live durable notes carry only an id). */
  getEventById: (id: string) => Promise<EventRow | undefined>
  /** Sink for SSE frames and comment lines. */
  send: (text: string) => void
}

export interface ShipLogStreamOpts {
  topicPatterns: string[]
  audience: string
  /** Resume point: only events strictly newer than this id are delivered. */
  lastEventId?: string
}

/**
 * Should a live note reach this stream? The pure gate: it must match one of the
 * requested topic patterns, be visible to the stream's audience, and be newer
 * than everything replay already sent (the dedup cutoff). Exported so the three
 * conditions can be pinned directly.
 */
export function noteIsVisible(
  note: NotifyPayload,
  opts: { topicPatterns: string[]; audience: string; lastReplayedId?: string },
): boolean {
  const topic = note.topic
  if (!topic) return false
  if (!opts.topicPatterns.some((pattern) => matchesTopic(topic, pattern)))
    return false
  // An absent audience is unrestricted; otherwise the viewer must be allowed.
  if (note.audience && !canViewAudience(note.audience, opts.audience))
    return false
  // Already covered by replay (id-ordered) → don't send it again.
  if (opts.lastReplayedId && note.id <= opts.lastReplayedId) return false
  return true
}

/**
 * Run the subscribe-first → replay → flush → live handshake, sending each SSE
 * frame through `deps.send`. Resolves with the unsubscribe handle once the
 * stream is live (a `: connected` comment has been sent); the caller owns
 * tear-down (heartbeat, abort, socket close). On a replay failure it
 * unsubscribes and rethrows so the caller can close the socket.
 */
export async function runShipLogStream(
  deps: ShipLogStreamDeps,
  opts: ShipLogStreamOpts,
): Promise<() => void> {
  const { topicPatterns, audience } = opts
  let replayed = false
  let lastReplayedId = opts.lastEventId
  const buffer: NotifyPayload[] = []

  const deliver = (note: NotifyPayload): void => {
    if (!noteIsVisible(note, { topicPatterns, audience, lastReplayedId }))
      return
    if (note.ephemeral) {
      // Ephemeral events never hit the DB — their full data rides the note.
      deps.send(
        sseFrame({
          id: note.id,
          type: note.type,
          topic: note.topic,
          audience: note.audience,
          source: note.ephemeral.source,
          payload: note.ephemeral.payload,
        }),
      )
    } else {
      // Durable live notes carry only an id; read the full row to frame it.
      // A DB blip that drops one live frame is recoverable — the next reconnect
      // replays from Last-Event-ID and catches it up — so swallow the rejection
      // rather than letting it surface as an unhandled one.
      void deps
        .getEventById(note.id)
        .then((row) => {
          if (row) deps.send(sseFrame(toStreamEvent(row)))
        })
        .catch(() => undefined)
    }
  }

  // Subscribe BEFORE replay so nothing lands in the gap; buffer until replay
  // finishes, then deliver the buffer deduped against what replay sent.
  const unsubscribe = deps.subscribe((note) => {
    if (replayed) deliver(note)
    else buffer.push(note)
  })

  try {
    // Drain replay in pages so a long absence (more than one page of missed
    // events) still loses nothing.
    for (;;) {
      const page = await deps.listEventsSince({
        topicPatterns,
        audience,
        sinceId: lastReplayedId,
      })
      for (const row of page) {
        deps.send(sseFrame(toStreamEvent(row)))
        lastReplayedId = row.id
      }
      if (page.length < REPLAY_PAGE_SIZE) break
    }
    replayed = true
    for (const note of buffer) deliver(note)
    deps.send(': connected\n\n')
    return unsubscribe
  } catch (err) {
    unsubscribe()
    throw err
  }
}
