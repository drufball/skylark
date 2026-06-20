import { createFileRoute } from '@tanstack/react-router'

import { db } from '@hull/db/client'
import { ensureShipLogListener, shipLogBus } from '@hull/events/bus'
import {
  getEventById,
  isScopeVisible,
  listEventsSince,
} from '@hull/events/service'
import { parseTopics, sseFrame } from '@hull/events/sse'

// The ship's log, streamed. A GET here is a Server-Sent-Events connection: the
// browser's EventSource opens it, the server keeps it open, and every event the
// connection may see is pushed as it happens. This REPLACES polling — the client
// hook is useShipLog (rigging).
//
// Flow:
//   1. parse the requested topics (scopes) from ?topics=
//   2. on (re)connect, replay any events newer than Last-Event-ID for those
//      scopes, straight from the durable table — so a dropped connection loses
//      nothing.
//   3. subscribe to the in-process bus (fed by the one LISTEN connection) and
//      forward every notification whose scope is visible, reading the full row
//      by id.
//
// This is thin impure wiring (a route); the wire format and scope rules are pure
// and tested in hull/events (sse.ts, service.ts).

export const Route = createFileRoute('/api/stream')({
  server: {
    handlers: {
      GET: ({ request }) => {
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
            const send = (text: string) => {
              if (open) controller.enqueue(encoder.encode(text))
            }

            // Replay what was missed since the cursor, in order.
            const missed = await listEventsSince(db, {
              scopes,
              sinceId: lastEventId,
            })
            for (const row of missed) send(sseFrame(row))

            // A comment line keeps the connection warm and confirms it's open.
            send(': connected\n\n')

            const unsubscribe = shipLogBus.subscribe((note) => {
              if (!isScopeVisible(note.scope, scopes)) return
              // The notify is tiny ({id,type,scope}); read the full row by id.
              void getEventById(db, note.id).then((row) => {
                if (row) send(sseFrame(row))
              })
            })

            const close = () => {
              if (!open) return
              open = false
              unsubscribe()
              try {
                controller.close()
              } catch {
                // already closed
              }
            }
            request.signal.addEventListener('abort', close)
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
