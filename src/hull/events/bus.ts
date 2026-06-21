import { uuidv7 } from '@earendil-works/pi-agent-core'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'

import { type Database } from '@hull/db/client'
import { resolveAppUrl } from '@hull/db/url'
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
// just {id,type,topic,audience} — because Postgres caps a notification near 8KB;
// the full event lives in the row, which the SSE route reads by id.
//
// notifyOnly is in-process only: it publishes to the in-process bus (so live SSE
// subscribers receive it) without firing pg_notify or persisting a row. For
// transient UI that shouldn't clutter the log or replay on reconnect.

/** The channel every emit notifies and the LISTEN connection subscribes to. */
export const SHIP_LOG_CHANNEL = 'ship_log'

/** The small body carried over NOTIFY — never the full payload (8KB cap). */
export interface NotifyPayload {
  id: string
  type: string
  /** The entity stream (e.g. "issue:123"). */
  topic?: string
  /** Who may see this ("public" | "members"). */
  audience?: string
  /** For ephemeral (in-process only) events: the full event data. */
  ephemeral?: {
    source: string
    payload: unknown
  }
}

type Listener = (note: NotifyPayload) => void

/**
 * A service that reacts to the ship's log: a `handleBusNote` that drives one
 * note (it reads the full event by id and decides what to do) and a `reconcile`
 * that recovers work a restart missed. The chat and issues orchestrators both
 * implement this; `subscribeToShipLog` wires either one in the same way.
 */
export interface ShipLogReactor {
  handleBusNote(note: NotifyPayload): Promise<void>
  reconcile(): Promise<void>
}

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
 * carries only {id,type,topic,audience}; subscribers read the full row by id.
 * This is the one true "emit" services call — the row is the source of truth,
 * the notify is just the doorbell.
 */
export async function emitEvent(
  db: Database,
  input: AppendEventInput,
): Promise<EventRow> {
  const row = await appendEvent(db, input)
  const note: NotifyPayload = {
    id: row.id,
    type: row.type,
    topic: row.topic ?? undefined,
    audience: row.audience ?? undefined,
  }
  // NOTIFY is a plain statement on the shared connection — no dedicated socket
  // needed to *send*, only to LISTEN. pg_notify takes (channel, text payload).
  await db.execute(
    sql`select pg_notify(${SHIP_LOG_CHANNEL}, ${JSON.stringify(note)})`,
  )
  return row
}

/**
 * Notify-only emit: publish to the in-process bus without persisting a row or
 * firing pg_notify. For transient UI (chat.agent_progress, status-line ticks)
 * that shouldn't clutter the log, replay on reconnect, or cross processes. Live
 * SSE subscribers in this process receive it; other processes and reconnecting
 * clients don't. Returns the ephemeral id.
 *
 * Carries the same topic + audience facets as a durable emit, so the SSE
 * route's topic-match and audience gates apply identically — an ephemeral note
 * must not slip past an access check just because it isn't persisted.
 */
export function notifyOnly(
  _db: Database,
  input: Pick<
    AppendEventInput,
    'type' | 'source' | 'topic' | 'audience' | 'payload'
  >,
): string {
  const id = uuidv7()
  shipLogBus.publish({
    id,
    type: input.type,
    topic: input.topic,
    audience: input.audience,
    ephemeral: {
      source: input.source,
      payload: input.payload,
    },
  })
  return id
}

/** The process-wide bus every SSE stream subscribes to. */
export const shipLogBus = new InProcessBus()

/* v8 ignore start -- live LISTEN wiring: a real Postgres connection, not unit-tested */

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

  // Same target as the query client (incl. the smoke db in test mode) so NOTIFY
  // and LISTEN never split across databases — and as the same app_user role
  // (LISTEN needs no special privilege). A separate connection from the shared
  // query `db`: a LISTEN connection is occupied and can't also run queries.
  const sql = postgres(resolveAppUrl(), { max: 1 })

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

/**
 * Wire a reactor to the ship's log: ensure the LISTEN connection is open,
 * subscribe its bus-note handler (a throwing handler is isolated + logged), and
 * kick reconcile in the BACKGROUND. Recovery is background work — it must never
 * gate the door that booted the orchestrator — so reconcile is `void`, not
 * awaited. The subscription itself is registered synchronously before this
 * returns, so no note is missed.
 */
export function subscribeToShipLog(
  reactor: ShipLogReactor,
  label: string,
): void {
  ensureShipLogListener()
  shipLogBus.subscribe((note) => {
    void reactor.handleBusNote(note).catch((err: unknown) => {
      console.error(`${label} bus handler failed: ${errorMessage(err)}`)
    })
  })
  void reactor.reconcile().catch((err: unknown) => {
    console.error(`${label} reconcile failed: ${errorMessage(err)}`)
  })
}
/* v8 ignore stop */
