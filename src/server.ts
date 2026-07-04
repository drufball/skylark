import {
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server'

import { bootAllReactors } from '@/boot'

import type { Register } from '@tanstack/react-router'
import type { RequestHandler } from '@tanstack/react-start/server'

/**
 * The custom TanStack Start server entry — the ONE module that runs only in
 * the server process, never in the client bundle. That makes it the home of
 * the eager reactor boot (#lo0x): arming reactors from a client-reachable
 * module (as PR #92 briefly did, via hull/chat/server.ts) drags the hull —
 * node builtins included — into the client graph and breaks the browser.
 * architecture.test.ts enforces that only this file imports @/boot.
 */
void bootAllReactors()

/* v8 ignore start -- live server wiring; request handling is TanStack's */
const fetch = createStartHandler(defaultStreamHandler)

const entry: { fetch: RequestHandler<Register> } = { fetch }

export default entry
/* v8 ignore stop */
