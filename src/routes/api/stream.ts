import { createFileRoute } from '@tanstack/react-router'

import { db } from '@hull/db/client'
import { ensureShipLogListener, shipLogBus } from '@hull/events/bus'
import {
  getEventById,
  isScopeVisible,
  listEventsSince,
  REPLAY_PAGE_SIZE,
} from '@hull/events/service'
import { parseTopics, sseFrame } from '@hull/events/sse'
import { currentActor } from '@hull/users/actor'

// The ship's log, streamed. A GET here is a Server-Sent-Events connection: the
// browser's EventSource opens it, the server keeps it open, and every event the
// connection may see is pushed as it happens. This REPLACES polling — the client
// hook is useShipLog (rigging).
//
// Flow:
//   1. resolve the actor — the tunnel asks "who are you?" before replaying any
//      transcript. (Scope-level entitlement — "may THIS actor see session X?" —
//      waits on the crew-filter primitive; see hull/events/zine.md.)
//   2. parse the requested topics (scopes) from ?topics=
//   3. subscribe to the in-process bus FIRST, buffering, so no event slips
//      through the gap between the replay query and going live.
//   4. replay everything newer than Last-Event-ID for those scopes, draining
//      past the per-page cap so a long absence loses nothing.
//   5. flush the buffer (deduped by id) and stream live from then on.
//
// This is thin impure wiring (a route); the wire format, scope rule, and replay
// are pure and tested in hull/events (sse.ts, service.ts).

export const Route = createFileRoute('/api/stream')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // Who are you? Refuse before replaying anyone's transcript. Throws if
        // no actor resolves (e.g. crew unseeded) — a 500 is the right answer:
        // an unauthenticated caller gets no stream.
        await currentActor()

        ensureShipLogListener()

        const url = new URL(request.url)
        const scopes = parseTopics(url.searchParams.get('topics'))
        const lastEventId =
          request.headers.get('Last-Event-ID') ??
          url.searchParams.get('lastEventId') ??
          undefined

        const encoder = new TextEncoder()

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            let open = true
            let heartbeat: ReturnType<typeof setInterval> | undefined

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

            // Subscribe BEFORE replay so nothing lands in the gap. Until replay
            // finishes we buffer; the highest id we replay becomes the cutoff
            // that dedupes the buffer against the replayed page.
            let replayed = false
            let lastReplayedId = lastEventId
            const buffer: { id: string; scope?: string }[] = []
            const deliver = (id: string, scope?: string) => {
              if (scope && !isScopeVisible(scope, scopes)) return
              if (lastReplayedId && id <= lastReplayedId) return
              void getEventById(db, id).then((row) => {
                if (row) send(sseFrame(row))
              })
            }
            const unsubscribe = shipLogBus.subscribe((note) => {
              const eventScope = note.scope ?? note.topic
              if (replayed) deliver(note.id, eventScope)
              else buffer.push({ id: note.id, scope: eventScope })
            })

            try {
              // Drain the durable replay in pages so a long absence (more than
              // one page of missed events) still loses nothing.
              for (;;) {
                const page = await listEventsSince(db, {
                  scopes,
                  sinceId: lastReplayedId,
                })
                for (const row of page) {
                  send(sseFrame(row))
                  lastReplayedId = row.id
                }
                if (page.length < REPLAY_PAGE_SIZE) break
              }
              replayed = true
              for (const note of buffer) deliver(note.id, note.scope)

              // A comment line confirms the stream is open, and a recurring
              // heartbeat keeps it warm — and, if the connection has silently
              // died, eventually trips the browser's EventSource auto-reconnect
              // (which re-runs replay from Last-Event-ID and re-arms a listener).
              send(': connected\n\n')
              heartbeat = setInterval(() => {
                send(': ping\n\n')
              }, HEARTBEAT_MS)

              request.signal.addEventListener('abort', close)
            } catch {
              close()
            }
          },
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
