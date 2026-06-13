---
name: create-service
description:
  Use when adding a new Skylark service — the native unit of data + logic +
  doors (web/CLI). Covers the folder shape, which deck it belongs in, wiring it
  to a view, testing it, and when to give it a zine.
---

# Creating a service

A **service** is Skylark's native unit of work: a slice of data, the logic over
it, and the doors onto it. (`src/hull/health/` shows the file layout, but it's a
special case — it answers a raw `select 1` rather than querying tables, so take
the query approach from step 4 below, not from health.)

## 1. Pick the deck

Services live in `hull`, `rigging`, or `home`. Choose by **load-bearingness**:
if customizing it would cascade into breakage (core data, security), it's
`hull`; a starting point people freely tweak is `rigging`; your own stuff is
`home`. (See the Decisions in `src/zine.md`.)

## 2. Lay out the folder

```
<deck>/<name>/
  schema.ts    the Drizzle tables this service owns
  service.ts   pure logic — framework-free and database-agnostic
  cli.ts       the default door — how the agent & terminal drive the service
  server.ts    the web door — added when the service grows a UI
  zine.md      optional — only if you want this service to be shareable
```

## 3. Define the tables (`schema.ts`)

Drizzle tables, owned by this service. drizzle-kit discovers every
`src/**/schema.ts` automatically (see `drizzle.config.ts`) — there's no barrel
to re-export into and nothing to forget. Generate and apply the migration:

```
npm run db:generate   # writes a migration from the schema change
npm run db:migrate    # applies it
```

A service reads and writes **only its own tables**. It learns about other
services through events, never by querying their tables.

## 4. Write the logic (`service.ts`)

Plain functions, kept **pure and database-agnostic**: take the database as a
parameter typed `Database` (from `@hull/db/client`). Both the live connection
and the in-memory PGlite client used in tests satisfy that type, so the same
logic runs in tests and in production. Query with the builder, passing your own
tables:

```ts
import type { Database } from '@hull/db/client'

import { widgets } from './schema'

export function listWidgets(db: Database) {
  return db.select().from(widgets)
}
```

## 5. Add the doors

Skylark is agent-first: a service's first door is its CLI.

- **`cli.ts`** — the default door. Call the `service.ts` functions from the
  terminal so the agent (and you) can drive the service the moment it exists.
- **`server.ts`** — the web door, added when the service grows a UI: wrap the
  logic in `createServerFn`, passing the live `db` from `@hull/db/client`. This
  is what routes/views call.

## 6. Wire a view (if it has UI)

Routes are **thin mounts**. Put the view in a deck (usually `rigging`) and bind
it in `src/routes/<path>.tsx`: the route's `loader` calls your server function
and hands the data to the view as a prop. The view stays routing-agnostic.

## 7. Test it

Drive `service.ts` directly against in-memory PGlite — no external database:

```ts
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
// push your schema, seed, call your service functions, assert.
```

## 8. Share it (optional)

If the service is worth handing to another crew, give it a `zine.md`. Use the
**author-zine** skill.
