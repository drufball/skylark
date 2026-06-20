import { PUBLIC_SCOPE } from './service'
import type { EventRow } from './schema'

// The wire-format half of the SSE endpoint, kept pure so it's unit-tested
// without a server. The route (src/routes/api/stream.ts) is the thin impure
// shell that opens the ReadableStream and pipes rows through `sseFrame`.

/** The shape the client receives in each event's `data:` line. */
export interface StreamEvent {
  id: string
  type: string
  source: string
  /** DEPRECATED: use topic. For backward compat. */
  scope?: string
  /** The entity stream (e.g. "issue:123"). */
  topic?: string
  /** Who may see this ("public" | "members"). */
  audience?: string
  payload: unknown
}

/**
 * One Server-Sent-Events frame for an event row. `id:` is the UUIDv7 — the
 * browser echoes it back as Last-Event-ID on reconnect, which is exactly our
 * replay cursor. We deliberately do NOT set a named `event:` line: every frame
 * arrives as the default `message` event so a single `onmessage` handler sees
 * them all, and the client dispatches on the `type` field inside the data. The
 * body is the full event as JSON, terminated by a blank line per the spec.
 */
export function sseFrame(row: EventRow): string {
  const data: StreamEvent = {
    id: row.id,
    type: row.type,
    source: row.source,
    scope: row.scope ?? undefined,
    topic: row.topic ?? undefined,
    audience: row.audience ?? undefined,
    payload: row.payload,
  }
  return `id: ${row.id}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Which scopes does this connection want? The `topics` query param is a
 * comma-separated list of scopes (e.g. "public,session:s1"). Empty or missing
 * falls back to the public scope, so a bare connection still gets the open
 * channel and never the empty set.
 */
export function parseTopics(topics: string | null): string[] {
  const parsed = (topics ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return parsed.length ? parsed : [PUBLIC_SCOPE]
}
