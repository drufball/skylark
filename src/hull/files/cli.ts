import { readFileSync } from 'node:fs'

import { isMain, runCli } from '@hull/lib/cli'
import { withCliActor } from '@hull/users/actor'

import { liveFilesService } from './live'

// The default door onto the files service — shared documents, drivable from a
// terminal or an agent's bash tool. Run it with:
//   node --env-file=.env --import tsx src/hull/files/cli.ts <command> …
// (or `npm run files -- <command> …`). Needs Postgres up (`npm run db:up`).
//
// Every write attributes to cliActor(): an explicit SKYLARK_ACTOR=<userId> wins
// (how an agent's identity flows into its tool environment), else the operator.
// Writes land on the staging branch; the server's sweeper merges them to main
// once they've sat quiet.

async function cmdList(): Promise<void> {
  const paths = await liveFilesService().list()
  if (paths.length === 0) {
    process.stdout.write('No files — write one with `npm run files write`.\n')
    return
  }
  for (const path of paths) process.stdout.write(`${path}\n`)
}

async function cmdRead(args: string[]): Promise<void> {
  const [path] = args
  if (!path) throw new Error('usage: files read <path>')
  const content = await liveFilesService().read(path)
  if (content === null) throw new Error(`No such file: ${path}`)
  process.stdout.write(content)
}

async function cmdWrite(args: string[]): Promise<void> {
  const [path, ...rest] = args
  if (!path) throw new Error('usage: files write <path> [content|--stdin]')
  const content =
    rest[0] === '--stdin' || rest.length === 0
      ? readFileSync(0, 'utf8')
      : rest.join(' ')
  const me = await withCliActor((_tx, actor) => Promise.resolve(actor))
  await liveFilesService().write({
    path,
    content,
    actor: { id: me.id, handle: me.handle },
  })
  process.stdout.write(`Staged ${path} as @${me.handle}.\n`)
}

async function cmdRm(args: string[]): Promise<void> {
  const [path] = args
  if (!path) throw new Error('usage: files rm <path>')
  const me = await withCliActor((_tx, actor) => Promise.resolve(actor))
  await liveFilesService().remove({
    path,
    actor: { id: me.id, handle: me.handle },
  })
  process.stdout.write(`Staged delete of ${path} as @${me.handle}.\n`)
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'list':
      return cmdList()
    case 'read':
      return cmdRead(args)
    case 'write':
      return cmdWrite(args)
    case 'rm':
      return cmdRm(args)
    default:
      process.stdout.write(
        'usage: files <list|read|write|rm> …\n' +
          '  list                          every shared file\n' +
          '  read <path>                   print a file\n' +
          '  write <path> [text|--stdin]   create or update a file (stdin when no text)\n' +
          '  rm <path>                     delete a file\n',
      )
      process.exitCode = command ? 1 : 0
  }
}

if (isMain(import.meta.url)) runCli(main)
