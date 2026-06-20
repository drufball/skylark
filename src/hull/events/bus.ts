import { sql } from 'drizzle-orm'
import postgres from 'postgres'

import { DEFAULT_DATABASE_URL, type Database } from '@hull/db/client'
import { errorMessage } from '@hull/lib/errors'

import { appendEvent, type AppendEventInput } from './service'
import type { EventRow } from './schema'

// The impure shell of the events service: the bridge between Postgres NOTIFY and
// the live SSE clients in this process.
//
// Emit (in service-callers) = insert the row + pg_notify('ship_log', tiny json).
// The web server holds ONE dedicated LISTEN connection (separate from the shared
// query `db`, because a LISTEN connection is occupied and can't also serve
// queries). On each notification it publishes to the InProcessBus, which fans
// out to every connected SSE stream. The NOTIFY payload is deliberately TINY —
// just {id,type,scope} — because Postgres caps a notification near 8KB; the full
// event lives in the row, which the SSE route reads by id.

/** The channel every emit notifies and the LISTEN connection subscribes to. */
export const SHIP_LOG_CHANNEL = 'ship_log'

/** The small body carried over NOTIFY — never the full payload (8KB cap). */
export interface NotifyPayload {
  id: string
  type: string
  scope: string
}

type Listener = (note: NotifyPayload) => void

/**
 * The in-process fan-out: every live SSE stream subscribes here, and each
 * Postgres notification is published to all of them. Pure and synchronous —
 * the network lives in the LISTEN connection, not here — so it's unit-tested
 * directly. A throwing subscriber is isolated so one broken stream can't starve
 * the others.
 */
export class InProcessBus {
  private listeners = new Set<Listener>()

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish(note: NotifyPayload): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(note)
      } catch {
        // One stream's failure must not stop the fan-out to the rest.
      }
    }
  }
}

/**
 * Emit an event: append the durable row, then announce it on the ship_log
 * channel so other processes (and this one's SSE clients) hear it. The NOTIFY
 * carries only {id,type,scope}; subscribers read the full row by id. This is the
 * one true "emit" services call — the row is the source of truth, the notify is
 * just the doorbell.
 */
export async function emitEvent(
  db: Database,
  input: AppendEventInput,
): Promise<EventRow> {
  const row = await appendEvent(db, input)
  const note: NotifyPayload = { id: row.id, type: row.type, scope: row.scope }
  // NOTIFY is a plain statement on the shared connection — no dedicated socket
  // needed to *send*, only to LISTEN. pg_notify takes (channel, text payload).
  await db.execute(
    sql`select pg_notify(${SHIP_LOG_CHANNEL}, ${JSON.stringify(note)})`,
  )
  return row
}

/* v8 ignore start -- live LISTEN wiring: a real Postgres connection, not unit-tested */
/** The process-wide bus every SSE stream subscribes to. */
export const shipLogBus = new InProcessBus()

let listening = false

/**
 * Open the one dedicated LISTEN connection for this process (idempotent), and
 * publish every ship_log notification onto the in-process bus. Called lazily by
 * the SSE route the first time a client connects, so a process that never
 * streams never opens the connection.
 *
 * Recovery is layered. postgres-js owns the socket: if Postgres blinks it
 * reconnects and re-issues LISTEN on its own (the `onlisten` callback re-fires).
 * If the *initial* listen rejects we reset the flag so the next SSE connection
 * re-arms. And if a blackout drops notifications entirely, the SSE route's
 * heartbeat trips the browser's EventSource auto-reconnect, which replays from
 * Last-Event-ID off the durable table — so a missed doorbell is caught up from
 * the source of truth, not lost.
 */
export function ensureShipLogListener(): void {
  if (listening) return
  listening = true

  const connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
  // A separate connection from the shared query `db`: a LISTEN connection is
  // occupied by the subscription and can't also run queries.
  const sql = postgres(connectionString, { max: 1 })

  void sql
    .listen(
      SHIP_LOG_CHANNEL,
      (raw) => {
        try {
          shipLogBus.publish(JSON.parse(raw) as NotifyPayload)
        } catch (err) {
          console.error(`ship_log: bad notify payload: ${errorMessage(err)}`)
        }
      },
      () => {
        console.info('ship_log: LISTEN connection (re)established')
      },
    )
    .catch((err: unknown) => {
      listening = false
      console.error(`ship_log: LISTEN failed: ${errorMessage(err)}`)
    })
}
/* v8 ignore stop */
