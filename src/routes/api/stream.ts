import { createFileRoute } from '@tanstack/react-router'

import { db } from '@hull/db/client'
import { ensureShipLogListener, shipLogBus } from '@hull/events/bus'
import {
  getEventById,
  listEventsSince,
  MEMBERS_AUDIENCE,
} from '@hull/events/service'
import { runShipLogStream } from '@hull/events/replay-stream'
import { parseTopics } from '@hull/events/sse'
import { canSeeTopic } from '@hull/access/visibility'
import { currentActor } from '@hull/users/actor'

// The ship's log, streamed. A GET here is a Server-Sent-Events connection: the
// browser's EventSource opens it, the server keeps it open, and every event the
// connection may see is pushed as it happens. This REPLACES polling — the client
// hook is useShipLog (rigging).
//
// Flow:
//   1. resolve the actor — the tunnel asks "who are you?" before replaying any
//      transcript, and gates every event by per-topic entitlement (canSeeTopic)
//      so subscribing to a chat's topic isn't enough to read it — you must be a
//      member. Topic patterns say what you asked for; entitlement says what
//      you're allowed.
//   2. parse the requested topic patterns from ?topics=
//   3. subscribe to the in-process bus FIRST, buffering, so no event slips
//      through the gap between the replay query and going live.
//   4. replay everything newer than Last-Event-ID for those topics, draining
//      past the per-page cap so a long absence loses nothing.
//   5. flush the buffer (deduped by id) and stream live from then on.
//
// This is thin impure wiring (a route); the wire format, topic rule, and replay
// are pure and tested in hull/events (sse.ts, service.ts).

export const Route = createFileRoute('/api/stream')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Who are you? Refuse before replaying anyone's transcript. Throws if
        // no actor resolves (e.g. crew unseeded) — a 500 is the right answer:
        // an unauthenticated caller gets no stream. The id gates entitlement.
        const actor = await currentActor()

        ensureShipLogListener()

        const url = new URL(request.url)
        // Parse topics as patterns (e.g., "issue:*", "chat:123")
        const topicPatterns = parseTopics(url.searchParams.get('topics'))
        // For now, all authenticated users see 'members' audience (single-crew)
        const audience = MEMBERS_AUDIENCE
        const lastEventId =
          request.headers.get('Last-Event-ID') ??
          url.searchParams.get('lastEventId') ??
          undefined

        const encoder = new TextEncoder()

        const stream = new ReadableStream<Uint8Array>({
          /* v8 ignore start -- impure ReadableStream lifecycle: controller,
             encoder, heartbeat timer, abort + dead-socket teardown. The
             subscribe/replay/flush coordination it drives is runShipLogStream,
             unit-tested in replay-stream.test.ts. */
          async start(controller) {
            let open = true
            let heartbeat: ReturnType<typeof setInterval> | undefined
            let unsubscribe: () => void = () => undefined

            const close = () => {
              if (!open) return
              open = false
              if (heartbeat) clearInterval(heartbeat)
              unsubscribe()
              try {
                controller.close()
              } catch {
                // already closed
              }
            }

            // Enqueue, and tear the stream down if the socket has gone away
            // (a throwing enqueue on a dead/slow client that never fired abort).
            const send = (text: string) => {
              if (!open) return
              try {
                controller.enqueue(encoder.encode(text))
              } catch {
                close()
              }
            }

            try {
              unsubscribe = await runShipLogStream(
                {
                  subscribe: (listener) => shipLogBus.subscribe(listener),
                  listEventsSince: (opts) => listEventsSince(db, opts),
                  getEventById: (id) => getEventById(db, id),
                  canSee: (topic) => canSeeTopic(db, actor.id, topic),
                  send,
                },
                { topicPatterns, audience, lastEventId },
              )

              // A recurring heartbeat keeps the stream warm — and, if the
              // connection has silently died, eventually trips the browser's
              // EventSource auto-reconnect (which re-runs replay from
              // Last-Event-ID and re-arms a listener).
              heartbeat = setInterval(() => {
                send(': ping\n\n')
              }, HEARTBEAT_MS)

              request.signal.addEventListener('abort', close)
            } catch {
              close()
            }
          },
          /* v8 ignore stop */
        })

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
          },
        })
      },
    },
  },
})

/** How often to send a heartbeat comment on an otherwise-idle stream. */
const HEARTBEAT_MS = 25_000
