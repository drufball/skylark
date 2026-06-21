import { createServerFn } from '@tanstack/react-start'

import { db } from '@hull/db/client'

import { currentActor } from './actor'
import { listUsers } from './service'

// The web doors onto the users service. `whoAmI` resolves the acting user for
// the current request (cookie override ?? operator); `listCrew` lists everyone
// aboard. Both run on the server and are called from routes like local fns.
//
// Forward-built in M1 and not yet wired to a route, so they read as unused.
// Kept intentionally; this whole file is on knip's ignore list (see knip.json)
// until the user-management UI work wires it (see board issue).

/** Who is the current request acting as? */
export const whoAmI = createServerFn({ method: 'GET' }).handler(() =>
  currentActor(),
)

/** Everyone aboard the ship. */
export const listCrew = createServerFn({ method: 'GET' }).handler(() =>
  listUsers(db),
)
