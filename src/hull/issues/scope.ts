/**
 * The ship-log topic namespace for issues — the one piece of the issues
 * contract the BROWSER needs (the thread view subscribes to a single issue's
 * scope; the board subscribes to the wildcard over all of them).
 *
 * It lives in its own leaf module, free of server-only imports, on purpose:
 * service.ts pulls in node:crypto and pi-agent-core (whose truncate util
 * touches `Buffer`), so a route that reached the scope through service.ts would
 * drag that node code into the client bundle and die with "Buffer is not
 * defined". Both sides import the namespace from here — the server emitter
 * (service.ts) and the client subscribers (the thread + board routes) — so the
 * `issue:` prefix has exactly one home and can't drift between them.
 */

/** The prefix every issue topic carries. The single source of the namespace. */
export const ISSUE_SCOPE_PREFIX = 'issue:'

/**
 * The ship-log **topic** a single issue's events are published under (the thread
 * view subscribes to it). Named `*Scope` for historical reasons — the event
 * `scope` field is retired; this returns a topic string.
 */
export function issueScope(issueId: string): string {
  return `${ISSUE_SCOPE_PREFIX}${issueId}`
}

/** The topic pattern matching every issue's scope (the board subscribes here). */
export const ISSUE_SCOPE_PATTERN = `${ISSUE_SCOPE_PREFIX}*`
