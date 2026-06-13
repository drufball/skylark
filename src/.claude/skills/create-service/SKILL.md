---
name: create-service
description: Use when adding a new Skylark service — the native unit of data + logic + doors (web/CLI). Covers the folder shape, which deck it belongs in, wiring it to a view, testing it, and when to give it a zine.
---

# Creating a service

A **service** is Skylark's native unit of work: a slice of data, the logic over
it, and the doors onto it. The worked reference is `src/hull/health/`.

## 1. Pick the deck

Services live in `hull`, `rigging`, or `home`. Choose by **load-bearingness**:
if customizing it would cascade into breakage (core data, security), it's `hull`;
a starting point people freely tweak is `rigging`; your own stuff is `home`. (See
the Decisions in `src/zine.md`.)

## 2. Lay out the folder

```
<deck>/<name>/
  schema.ts    the Drizzle tables this service owns
  service.ts   pure logic — framework-free and database-agnostic
  server.ts    createServerFn doors — how the web reaches the logic
  cli.ts       how the terminal & agent reach the same logic (optional)
  zine.md      optional — only if you want this service to be shareable
```

## 3. Define the tables (`schema.ts`)

Drizzle tables, owned by this service. Then re-export them from `src/schema.ts`
(the schema barrel) so drizzle-kit sees them, and generate a migration:

```
npm run db:generate   # writes a migration from the schema change
npm run db:migrate    # applies it
```

A service reads and writes **only its own tables**. It learns about other
services through events, never by querying their tables.

## 4. Write the logic (`service.ts`)

Plain functions. Keep them **pure and database-agnostic** — take the database as
a parameter — so tests can drive them against PGlite and the live server can pass
the real connection. Query through the shared connection's API, passing your own
tables: `database.select().from(yourTable)`.

## 5. Add the doors

- **`server.ts`** — wrap the logic in `createServerFn`, passing the live `db`
  from `@hull/db/client`. This is what routes/views call.
- **`cli.ts`** — optional; call the same `service.ts` functions from the terminal.

## 6. Wire a view (if it has UI)

Routes are **thin mounts**. Put the view in a deck (usually `rigging`) and bind it
in `src/routes/<path>.tsx`: the route's `loader` calls your server function and
hands the data to the view as a prop. The view stays routing-agnostic.

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
