import { db } from '@hull/db/client'
import { isMain, runCli } from '@hull/lib/cli'

import { cliActor } from './actor'
import { listUsers, seedCrew } from './service'

// The default door onto the users service: list the crew, seed the standard
// crew, or print who the CLI is acting as. Run it with:
//   node --env-file=.env --import tsx src/hull/users/cli.ts <command>
// (or `npm run users -- <command>`). Needs Postgres up (`npm run db:up`).

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

async function cmdSeed(): Promise<void> {
  await seedCrew(db)
  const crew = await listUsers(db)
  process.stdout.write(`Seeded crew (${String(crew.length)} aboard).\n`)
}

async function cmdList(): Promise<void> {
  const crew = await listUsers(db)
  if (crew.length === 0) {
    process.stdout.write('No crew yet — run `npm run users seed`.\n')
    return
  }
  for (const u of crew) {
    const mark = u.type === 'agent' ? '🤖' : '🧑'
    process.stdout.write(
      `${mark} @${u.handle} ${DIM}${u.displayName} · ${u.id}${RESET}\n`,
    )
  }
}

async function cmdWhoami(): Promise<void> {
  const actor = await cliActor()
  if (!actor) {
    process.stdout.write(
      'No actor resolved (crew not seeded, or unknown id).\n',
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(`@${actor.handle} ${DIM}${actor.id}${RESET}\n`)
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2)
  switch (command) {
    case 'seed':
      return cmdSeed()
    case 'list':
      return cmdList()
    case 'whoami':
      return cmdWhoami()
    default:
      process.stdout.write(
        'usage: users <seed|list|whoami>\n' +
          '  seed     create the standard crew (idempotent)\n' +
          '  list     show everyone aboard\n' +
          '  whoami   show who this process acts as\n',
      )
      process.exitCode = command ? 1 : 0
  }
}

if (isMain(import.meta.url)) runCli(main)
