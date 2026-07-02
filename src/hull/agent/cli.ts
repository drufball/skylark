import { uuidv7 } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

import { systemDb } from '@hull/db/client'
import { isMain, runCli } from '@hull/lib/cli'
import { withCliActor } from '@hull/users/actor'

import {
  listExtensions,
  listProfiles,
  registerExtension,
  seedAndWireProfiles,
} from './profiles'
import { liveAgentMemoryLoader } from './fake-session'
import { toolExecutionDetail, truncate } from './progress'
import { createAgentRuntime, createPiSession, DEFAULT_MODEL } from './runtime'
import {
  createSession,
  getSession,
  listSessions,
  titleFromMessage,
} from './service'

// The default door onto the agent service: create a session, send a message to
// one (queued if it's mid-turn, booted from history if it's idle), list
// sessions, or cancel a running one. Run it with:
//   node --env-file=.env --import tsx src/hull/agent/cli.ts <command> …
// (or `npm run agent -- <command> …`). Needs Postgres up (`npm run db:up`) and
// ANTHROPIC_API_KEY in .env.

const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'

/** Render live agent events to the terminal as they stream. */
function renderEvent(event: AgentSessionEvent): void {
  switch (event.type) {
    case 'message_update': {
      const e = event.assistantMessageEvent
      if (e.type === 'thinking_start') process.stdout.write(`\n${DIM}💭 `)
      else if (e.type === 'thinking_delta') process.stdout.write(e.delta)
      else if (e.type === 'thinking_end') process.stdout.write(RESET)
      else if (e.type === 'text_start') process.stdout.write('\n')
      else if (e.type === 'text_delta') process.stdout.write(e.delta)
      break
    }
    case 'tool_execution_start': {
      const detail = toolExecutionDetail(event)
      if (detail) {
        process.stdout.write(
          `\n${CYAN}🔧 ${detail.name}${RESET} ${truncate(detail.detail)}\n`,
        )
      }
      break
    }
    case 'tool_execution_end':
      process.stdout.write(
        `${DIM}   → ${event.isError ? 'error' : 'ok'}${RESET}\n`,
      )
      break
    case 'turn_end':
      process.stdout.write('\n')
      break
    default:
      break
  }
}

/** Pull `--flag value` out of args, returning the value and the remaining args. */
function takeFlag(
  args: string[],
  flag: string,
): [string | undefined, string[]] {
  const i = args.indexOf(flag)
  if (i === -1) return [undefined, args]
  const value = args[i + 1]
  return [value, [...args.slice(0, i), ...args.slice(i + 2)]]
}

async function cmdNew(args: string[]): Promise<void> {
  const [model = DEFAULT_MODEL, rest] = takeFlag(args, '--model')
  const message = rest.join(' ').trim()
  if (!message) throw new Error('usage: agent new <message> [--model <id>]')

  const id = uuidv7()
  await withCliActor((tx) =>
    createSession(tx, { id, model, title: titleFromMessage(message) }),
  )
  process.stdout.write(`${DIM}session ${id} · ${model}${RESET}\n`)

  // The turn itself is long-lived system plumbing — it persists the transcript
  // for this one session — so it runs on systemDb, not wrapped in withCliActor
  // (a turn must not be a single long transaction; see runAsActor). Same posture
  // as the server's runtime.
  const runtime = createAgentRuntime({
    db: systemDb,
    factory: createPiSession,
    memory: liveAgentMemoryLoader(systemDb),
  })
  await runtime.runTurn(id, message, renderEvent)
  runtime.disposeAll()
}

async function cmdSend(args: string[]): Promise<void> {
  const [id, ...messageParts] = args
  const message = messageParts.join(' ').trim()
  if (!id || !message)
    throw new Error('usage: agent send <session-id> <message>')

  // Resolve under the actor: you can only send to a session your identity may
  // see (a private chat's backing session stays hidden, rather than reachable
  // via a permissive policy).
  const session = await withCliActor((tx) => getSession(tx, id))
  if (!session) throw new Error(`No such session: ${id}`)

  const runtime = createAgentRuntime({
    db: systemDb,
    factory: createPiSession,
    memory: liveAgentMemoryLoader(systemDb),
  })
  await runtime.runTurn(id, message, renderEvent)
  runtime.disposeAll()
}

async function cmdList(args: string[]): Promise<void> {
  let rest = args
  const running = rest.includes('--running') ? true : undefined
  rest = rest.filter((a) => a !== '--running')
  const [since] = takeFlag(rest, '--since')

  const sessions = await withCliActor((tx) =>
    listSessions(tx, {
      running,
      since: since ? new Date(since) : undefined,
    }),
  )

  if (sessions.length === 0) {
    process.stdout.write('No sessions.\n')
    return
  }
  for (const s of sessions) {
    const mark = s.status === 'running' ? '●' : s.status === 'error' ? '✗' : '○'
    const when = s.lastMessageAt.toISOString().slice(0, 16).replace('T', ' ')
    process.stdout.write(
      `${mark} ${DIM}${s.id}${RESET}  ${when}  ${s.title ?? '(untitled)'}\n`,
    )
  }
}

async function cmdCancel(args: string[]): Promise<void> {
  const [id] = args
  if (!id) throw new Error('usage: agent cancel <session-id>')

  // A fresh CLI process doesn't host the live turn (the web server does), so
  // this resets the stored status to idle. When the hosting process runs this
  // it also aborts the in-flight turn.
  const runtime = createAgentRuntime({
    db: systemDb,
    factory: createPiSession,
    memory: liveAgentMemoryLoader(systemDb),
  })
  await runtime.cancel(id)
  process.stdout.write(`Cancelled ${id}.\n`)
}

async function cmdSeed(): Promise<void> {
  const { profiles, exts } = await withCliActor(async (tx) => {
    await seedAndWireProfiles(tx)
    return { profiles: await listProfiles(tx), exts: await listExtensions(tx) }
  })
  process.stdout.write(
    `Seeded ${String(profiles.length)} profile(s), ${String(exts.length)} extension(s); agents → chat profile.\n`,
  )
}

async function cmdProfiles(): Promise<void> {
  const profiles = await withCliActor((tx) => listProfiles(tx))
  if (profiles.length === 0) {
    process.stdout.write('No profiles — run `npm run agent seed`.\n')
    return
  }
  for (const p of profiles) {
    const tools = p.tools ? p.tools.join(',') : 'default-coding'
    process.stdout.write(
      `${p.name}  ${DIM}tools=${tools} ctx=${String(p.readContextFiles)} skills=${String(p.useRepoSkills)} ext=${String(p.extensionIds.length)} · ${p.id}${RESET}\n`,
    )
  }
}

async function cmdExtensions(args: string[]): Promise<void> {
  // `agent extensions register <name> <path> [description…]`
  if (args[0] === 'register') {
    const [, name, path, ...descParts] = args
    if (!name || !path)
      throw new Error(
        'usage: agent extensions register <name> <path> [description]',
      )
    const row = await withCliActor((tx) =>
      registerExtension(tx, {
        name,
        path,
        description: descParts.join(' ') || name,
      }),
    )
    process.stdout.write(`Registered ${row.name} ${DIM}${row.id}${RESET}\n`)
    return
  }
  const exts = await withCliActor((tx) => listExtensions(tx))
  if (exts.length === 0) {
    process.stdout.write('No extensions — run `npm run agent seed`.\n')
    return
  }
  for (const e of exts) {
    process.stdout.write(`${e.name}  ${DIM}${e.path} · ${e.id}${RESET}\n`)
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'new':
      return cmdNew(args)
    case 'send':
      return cmdSend(args)
    case 'list':
      return cmdList(args)
    case 'cancel':
      return cmdCancel(args)
    case 'seed':
      return cmdSeed()
    case 'profiles':
      return cmdProfiles()
    case 'extensions':
      return cmdExtensions(args)
    default:
      process.stdout.write(
        'usage: agent <new|send|list|cancel|seed|profiles|extensions> …\n' +
          '  new <message> [--model <id>]   start a session and send the first message\n' +
          '  send <session-id> <message>    send a message (queued if mid-turn)\n' +
          '  list [--running] [--since D]   list sessions, newest first\n' +
          '  cancel <session-id>            cancel a running session\n' +
          '  seed                           seed the standard profiles + extensions\n' +
          '  profiles                       list agent profiles\n' +
          '  extensions [register …]        list or register extensions\n',
      )
      process.exitCode = command ? 1 : 0
  }
}

if (isMain(import.meta.url)) runCli(main)
