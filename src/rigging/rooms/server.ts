import { createServerFn } from '@tanstack/react-start'

import { withActor } from '@hull/db/client'
import { currentActor, operatorHandle } from '@hull/users/actor'
import { getUserByHandle, listUsers } from '@hull/users/service'

import { seedHomes, seedRooms } from './seed'

// The one web door onto the rooms: **welcome somebody aboard**.
//
// `scripts/serve` runs `npm run rooms seed` on every boot, and that is what
// converges the ship for the crew who are already here. It is not enough for
// somebody who signs up at four in the afternoon: until the next restart
// they're in no rooms and their home is a blank grid — which, now that home IS
// the front door, is the first and only thing they'd see. This door closes that
// window by running the same idempotent seed the CLI runs, at the one moment it
// matters.
//
// **Why two actors.** A newcomer cannot add themselves to a room: chat
// membership is visibility, enforced by RLS, and a non-member's write is
// refused by the policy (as it should be). So the room pass runs as the ship's
// OPERATOR — exactly who runs it on boot — and only then does the home pass run
// as the newcomer, who can by then see the rooms they've just been brought
// into. The escalation is deliberately narrow and worth naming: any logged-in
// crew member can cause the ship to perform its own boot seed, with the fixed
// DEFAULT_ROOMS list and no input of their own. Every effect is one the ship
// already performs unattended on every restart, and it is a no-op once
// converged.

/**
 * Bring the caller into the ship's default rooms and arrange their home screen
 * with them. Idempotent and non-clobbering (see `seed.ts`): a returning crew
 * member's rooms and arrangement are untouched.
 *
 * Called from the signup route. Best-effort by design — the caller must not
 * fail a signup over it; a boot will converge them anyway.
 */
export const welcomeAboard = createServerFn({ method: 'POST' }).handler(
  async () => {
    const me = await currentActor()
    const operator = await withActor(me.id, (tx) =>
      getUserByHandle(tx, operatorHandle()),
    )
    // No operator seeded yet (a ship mid-bootstrap) — nothing to converge into,
    // and inventing an authority here would be worse than waiting for the boot.
    if (!operator) return { rooms: 0, tiles: 0 }

    const rooms = await withActor(operator.id, (tx) =>
      seedRooms(tx, { actorId: operator.id }),
    )
    const crew = await withActor(operator.id, (tx) => listUsers(tx))
    const homes = await seedHomes({
      // Only the newcomer's own home: the rest of the crew's is the boot seed's
      // business, and one person's signup should not be a write across everyone.
      crew: crew.filter((user) => user.id === me.id),
      asActor: withActor,
    })
    return {
      rooms: rooms.filter((room) => room.error === null).length,
      tiles: homes.reduce((total, home) => total + home.tilesAdded, 0),
    }
  },
)
