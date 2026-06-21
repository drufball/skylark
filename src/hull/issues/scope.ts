/**
 * The ship-log scope a single issue's events are published under — the one piece
 * of the issues contract the BROWSER needs (the thread view subscribes to it).
 *
 * It lives in its own leaf module, free of server-only imports, on purpose:
 * service.ts pulls in node:crypto and pi-agent-core (which touches `Buffer`), so
 * a route that imported the scope from there would drag that node code into the
 * client bundle and die with "Buffer is not defined". Both sides — the server
 * emitter (service.ts) and the client subscriber (the route) — import it here.
 */
export function issueScope(issueId: string): string {
  return `issue:${issueId}`
}
