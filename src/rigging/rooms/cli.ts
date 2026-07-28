import { withActor } from '@hull/db/client'
import { isMain, runCli } from '@hull/lib/cli'
import { listUsers } from '@hull/users/service'
import { withCliActor } from '@hull/users/actor'

import { DEFAULT_ROOMS } from './rooms'
import { seedHomes, seedRooms } from './seed'

// The door onto the ship's default rooms, mirroring `npm run users` exactly:
//   node --env-file=.env --import tsx src/rigging/rooms/cli.ts <command>
// (or `npm run rooms -- <command>`). Needs Postgres up (`npm run db:up`).
//
// It's on the RIGGING deck because the rooms are: which conversations a fresh
// ship opens, and what's arranged in them, is a starting point a crew is meant
// to change — and the widget kinds it arranges are this deck's meaning, which
// the hull is not allowed to know by name. `scripts/serve` runs `seed` on every
// boot, right after the crew seed it depends on.
//
// Everything runs under withCliActor, so the rooms are made by a PERSON under
// their own RLS context: the widgets it raises carry that person's name, which
// is the rule that only an actor with judgment raises one.

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

async function cmdSeed(): Promise<void> {
  const rooms = await withCliActor((tx, me) =>
    seedRooms(tx, { actorId: me.id }),
  )
  for (const room of rooms) {
    if (room.error) {
      process.stdout.write(`✗ ${room.title} ${DIM}${room.error}${RESET}\n`)
      process.exitCode = 1
      continue
    }
    const notes = [
      room.created ? 'opened' : 'already aboard',
      ...(room.membersAdded > 0 ? [`+${String(room.membersAdded)} crew`] : []),
      ...(room.widgetsAdded > 0
        ? [`+${String(room.widgetsAdded)} widget`]
        : []),
      ...(room.missingAgent ? [`no @${room.missingAgent} aboard`] : []),
    ]
    process.stdout.write(
      `✓ ${room.title} ${DIM}${room.id} · ${notes.join(' · ')}${RESET}\n`,
    )
  }

  // Then the homes. A separate pass, outside the operator's transaction, because
  // each one has to run under its OWNER's RLS context — nobody, operator
  // included, may write somebody else's home canvas.
  const crew = await withCliActor((tx) => listUsers(tx))
  for (const home of await seedHomes({ crew, asActor: withActor })) {
    if (home.error) {
      process.stdout.write(
        `✗ @${home.handle}'s home ${DIM}${home.error}${RESET}\n`,
      )
      process.exitCode = 1
      continue
    }
    const note =
      home.tilesAdded > 0
        ? `+${String(home.tilesAdded)} tile`
        : 'already arranged'
    process.stdout.write(`✓ @${home.handle}'s home ${DIM}${note}${RESET}\n`)
  }
}

function cmdList(): void {
  for (const room of DEFAULT_ROOMS) {
    const kinds = room.widgets.map((w) => w.kind).join(', ')
    process.stdout.write(
      `${room.title} ${DIM}${room.id} · @${room.agentHandle} · ${kinds}${RESET}\n`,
    )
  }
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2)
  if (command === 'seed') return cmdSeed()
  if (command === 'list') {
    cmdList()
    return
  }
  process.stdout.write(
    'usage: rooms <seed|list>\n' +
      '  seed   open the ship’s default rooms and put them on the crew’s home\n' +
      '         screens (idempotent, never clobbers)\n' +
      '  list   show the rooms this ship would open\n',
  )
  process.exitCode = command ? 1 : 0
}

if (isMain(import.meta.url)) runCli(main)
