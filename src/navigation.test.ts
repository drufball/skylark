import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_ROOMS } from '@rigging/rooms/rooms'
import { RAIL } from '@rigging/views/dock'

/**
 * **No route is an orphan.**
 *
 * Navigation in this ship is mostly DATA now — the chats you're in, the pages
 * you made, the tiles you kept — and the whole reason the rail is short and
 * hardcoded is that data can be deleted. That guarantee is worth only as much
 * as the claim underneath it: every surface the ship serves is reachable from
 * something that cannot be deleted.
 *
 * There are exactly two such things:
 *
 * 1. **The rail** (`rigging/views/dock`) — four entries, on every screen, for a
 *    crew member with zero pages and zero tiles.
 * 2. **A default room** (`rigging/rooms`) — `/issues`, `/files` and `/inbox`
 *    left the rail when the rooms arrived, and each room links through to the
 *    view it's the room for. A room can be renamed or left, but the rail's
 *    Chats entry always reaches it and the seed reopens it on boot.
 *
 * A route that is neither is a page nobody can find, which is how a good
 * working view gets quietly deleted a slice later. Adding one to this file's
 * exemption list is a decision, not a formality — the diff on it is the review.
 *
 * **Reachable is half a claim; the other half is a way back.** #cse7 linked a
 * room OUT to its view and gave the view nothing in return, so `/issues`,
 * `/files` and `/inbox` were one-way doors: the browser's back button was the
 * only exit, which is a rescue rather than navigation, and it strands anybody
 * who arrived by typing the URL or following a link an agent posted months ago.
 * So this file now pins the round trip too.
 */

/**
 * Routes that legitimately have no entry point of their own.
 *
 * - `/` is the rail's own first entry, and the file that defines it.
 * - `login` / `signup` are what you see when there IS no ship yet; the root
 *   route redirects to them and the dock isn't rendered.
 * - `home` is a redirect kept alive for the slice that had `/home` as the home
 *   canvas — it has no surface of its own.
 * - `status` is the machine-readable health endpoint, linked from nothing on
 *   purpose (it's for a monitor, not a person).
 * - `issues.$id` is a thread you reach from the board, which is itself reached
 *   from the Issues room.
 */
const NOT_DESTINATIONS = new Set([
  '/',
  '/login',
  '/signup',
  '/home',
  '/status',
  '/issues/$id',
])

const ROUTES_DIR = join(import.meta.dirname, 'routes')

/** Every route the ship serves: its path in TanStack notation, and its file. */
function routeFiles(): { path: string; file: string }[] {
  return readdirSync(ROUTES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.tsx'))
    .filter((entry) => entry.name !== '__root.tsx')
    .map((entry) => {
      // `index.tsx` is `/`; `issues.index.tsx` is `/issues`; `issues.$id.tsx`
      // is `/issues/$id`.
      const path = entry.name
        .replace(/\.tsx$/, '')
        .replace(/(^|\.)index$/, '')
        .split('.')
        .join('/')
      return { path: `/${path}`, file: entry.name }
    })
}

/** Every route path `src/routes` serves, in TanStack's file-route notation. */
function routePaths(): string[] {
  return routeFiles().map((route) => route.path)
}

describe('navigation: nothing the ship serves is unreachable', () => {
  it('reaches every destination route from the rail or a default room', () => {
    const reachable = new Set([
      ...RAIL.map((item) => item.to),
      ...DEFAULT_ROOMS.map((room) => room.view.to),
    ])
    const orphans = routePaths().filter(
      (path) => !NOT_DESTINATIONS.has(path) && !reachable.has(path),
    )
    expect(
      orphans,
      orphans.length > 0
        ? `unreachable: ${orphans.join(', ')} — put it in the rail (rigging/views/dock), ` +
            `link it from a default room (rigging/rooms/rooms.ts), or say why it isn't a ` +
            `destination in navigation.test.ts`
        : '',
    ).toEqual([])
  })

  it('keeps the three surfaces that left the rail alive as routes', () => {
    // Deleting a good working view in the same slice that moved the front door
    // would be two irreversible things at once. The rooms are the way IN; the
    // views themselves are untouched.
    const served = new Set(routePaths())
    for (const room of DEFAULT_ROOMS) {
      expect(served.has(room.view.to), room.view.to).toBe(true)
    }
  })

  it('gives every one of those surfaces a way back to its room', () => {
    // The route is where the two halves meet, so the route is what this checks:
    // each of the three mounts the shell with the room `roomForView` resolves.
    // A view that quietly dropped it would still render, still be reachable,
    // and still be a one-way door — which is exactly how it shipped last time.
    const byPath = new Map(routeFiles().map((r) => [r.path, r.file]))
    for (const room of DEFAULT_ROOMS) {
      const file = byPath.get(room.view.to)
      expect(file, room.view.to).toBeDefined()
      const source = readFileSync(join(ROUTES_DIR, file ?? ''), 'utf8')
      expect(source, room.view.to).toContain(`roomForView('${room.view.to}')`)
    }
  })

  it('never lists a surface twice — the rail and the rooms do not overlap', () => {
    // Two doors onto one view is how "which one is the real one?" starts. A
    // surface that earns a rail entry should lose its room link, and vice versa.
    const all = [
      ...RAIL.map((item) => item.to),
      ...DEFAULT_ROOMS.map((room) => room.view.to),
    ]
    expect(new Set(all).size).toBe(all.length)
  })
})
