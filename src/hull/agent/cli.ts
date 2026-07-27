import { uuidv7 } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

import { systemDb } from '@hull/db/client'
import { isMain, runCli } from '@hull/lib/cli'
import { withCliActor } from '@hull/users/actor'
import { getUsersByIds } from '@hull/users/service'

import {
  listExtensions,
  registerExtension,
  seedAgentConfig,
} from './agent-config'
import { liveAgentMemoryLoader } from './server-runtime'
import { toolExecutionDetail, truncate } from './progress'
import { createAgentRuntime, createPiSession, DEFAULT_MODEL } from './runtime'
import {
  createSession,
  getMessages,
  getSession,
  listFleet,
  listSessions,
  resolveSessionRef,
  titleFromMessage,
} from './service'
import { sessionStats, toChatItems } from './transcript'

// The default door onto the agent service: create a session, send a message to
// one (queued if it's mid-turn, booted from history if it's idle), list
// sessions, or cancel a running one. Run it with:
//   node --env-file=.env --import tsx src/hull/agent/cli.ts <command> …
// (or `npm run agent -- <command> …`). Needs Postgres and the gateway up
// (`npm run gateway:up`), with a provider key added in the gateway UI.

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

/**
 * Render the age of a timestamp as a short "Nm ago" string, relative to `now`
 * (a parameter so it's testable without faking the clock). Clamps negative
 * deltas (clock skew) to zero rather than printing a nonsensical "-5s ago".
 */
export function formatAge(date: Date, now: Date = new Date()): string {
  const seconds = Math.max(
    0,
    Math.floor((now.getTime() - date.getTime()) / 1000),
  )
  if (seconds < 60) return `${String(seconds)}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)}h ago`
  const days = Math.floor(hours / 24)
  return `${String(days)}d ago`
}

const RUNNING_CAVEAT =
  "a crash can leave a session stuck on running — can't confirm from the DB alone that it's still alive"

/**
 * One view of every agent session, sorted by most-recent activity — the query
 * the night watch used to run by hand (issue #7an8, part of #q5ia): status,
 * agent handle (or "unattributed"), title, cwd, how long since it last spoke,
 * and any outstanding background jobs. `running` rows carry an explicit
 * caveat rather than a guess at liveness — see `RUNNING_CAVEAT`. Read-only.
 */
async function cmdFleet(): Promise<void> {
  const { fleet, handleById } = await withCliActor(async (tx) => {
    const fleet = await listFleet(tx)
    const agentIds = [
      ...new Set(
        fleet
          .map((f) => f.session.agentUserId)
          .filter((id): id is string => id !== null),
      ),
    ]
    const users = await getUsersByIds(tx, agentIds)
    return {
      fleet,
      handleById: new Map(users.map((u) => [u.id, u.handle])),
    }
  })

  if (fleet.length === 0) {
    process.stdout.write('No sessions.\n')
    return
  }

  const now = new Date()
  for (const { session, jobs } of fleet) {
    const mark =
      session.status === 'running'
        ? '●'
        : session.status === 'error'
          ? '✗'
          : '○'
    const who = session.agentUserId
      ? `@${handleById.get(session.agentUserId) ?? '?'}`
      : '(unattributed)'
    const cwd = session.cwd ?? '(repo root)'
    process.stdout.write(
      `${mark} ${who}  ${session.title ?? '(untitled)'}  ` +
        `${DIM}${cwd} · ${formatAge(session.lastMessageAt, now)}${RESET}\n`,
    )
    if (session.status === 'running')
      process.stdout.write(`  ${DIM}⚠ ${RUNNING_CAVEAT}${RESET}\n`)
    if (session.status === 'error' && session.error)
      process.stdout.write(`  ${DIM}error: ${session.error}${RESET}\n`)
    for (const job of jobs) {
      process.stdout.write(
        `  ${DIM}job: ${job.label} · ${job.command} · ${formatAge(job.createdAt, now)}${RESET}\n`,
      )
    }
  }
}

const DEFAULT_SHOW_TAIL = 10

/** Parse `show`'s args: a session ref, plus an optional `--tail N`. */
export function parseShowArgs(args: string[]): {
  ref?: string
  tail: number
} {
  const rest = [...args]
  const at = rest.indexOf('--tail')
  let tail = DEFAULT_SHOW_TAIL
  if (at !== -1) {
    const value = rest.at(at + 1)
    const parsed = value ? Number.parseInt(value, 10) : NaN
    if (!value || Number.isNaN(parsed) || parsed <= 0)
      throw new Error('--tail requires a positive number')
    tail = parsed
    rest.splice(at, 2)
  }
  return { ref: rest.at(0), tail }
}

const ROLE_LABEL: Record<string, string> = {
  user: 'user',
  assistant: 'assistant',
  toolResult: 'tool',
}

/** One line per chat item, for the transcript tail. */
function renderChatItem(item: ReturnType<typeof toChatItems>[number]): string {
  switch (item.kind) {
    case 'user':
      return `user: ${truncate(item.text)}`
    case 'assistant':
      return `assistant: ${truncate(item.text)}`
    case 'thinking':
      return `${DIM}thinking: ${truncate(item.text)}${RESET}`
    case 'toolCall':
      return `${CYAN}tool call: ${item.name}(${truncate(item.args, 80)})${RESET}`
    case 'toolResult':
      return `${DIM}tool result (${item.name}${item.isError ? ', error' : ''}): ${truncate(item.text, 200)}${RESET}`
  }
}

/**
 * Inspect a session without hand-writing SQL: header (title/status/last
 * activity/error), message + tool-call counts, and a transcript tail — the
 * fleet-triage door issue #4mna's stalled-build tracing had to do by hand.
 * Read-only: no mutation surface.
 */
async function cmdShow(args: string[]): Promise<void> {
  const { ref, tail } = parseShowArgs(args)
  if (!ref) throw new Error('usage: agent show <session-id> [--tail N]')

  const { session, messages } = await withCliActor(async (tx) => {
    const session = await resolveSessionRef(tx, ref)
    if (!session) throw new Error(`No such session: ${ref}`)
    const messages = await getMessages(tx, session.id)
    return { session, messages }
  })

  const mark =
    session.status === 'running' ? '●' : session.status === 'error' ? '✗' : '○'
  process.stdout.write(
    `${mark} ${session.title ?? '(untitled)'}  ${DIM}${session.id}${RESET}\n` +
      `  status: ${session.status}  ${DIM}last activity ${session.lastMessageAt.toISOString()}${RESET}\n`,
  )
  if (session.error) process.stdout.write(`  error: ${session.error}\n`)

  const stats = sessionStats(messages.map((m) => m.message))
  const roleCounts = Object.entries(stats.byRole)
    .map(([role, n]) => `${String(n)} ${ROLE_LABEL[role] ?? role}`)
    .join(', ')
  process.stdout.write(
    `  ${String(stats.total)} messages (${roleCounts || 'none'}) · ${String(stats.toolCalls)} tool calls\n\n`,
  )

  const items = toChatItems(messages.map((m) => m.message))
  for (const item of items.slice(-tail)) {
    process.stdout.write(`${renderChatItem(item)}\n`)
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
  const exts = await withCliActor(async (tx) => {
    await seedAgentConfig(tx)
    return listExtensions(tx)
  })
  process.stdout.write(
    `Seeded agent config; ${String(exts.length)} extension(s) registered.\n`,
  )
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
    case 'fleet':
      return cmdFleet()
    case 'show':
      return cmdShow(args)
    case 'cancel':
      return cmdCancel(args)
    case 'seed':
      return cmdSeed()
    case 'extensions':
      return cmdExtensions(args)
    default:
      process.stdout.write(
        'usage: agent <new|send|list|fleet|show|cancel|seed|extensions> …\n' +
          '  new <message> [--model <id>]   start a session and send the first message\n' +
          '  send <session-id> <message>    send a message (queued if mid-turn)\n' +
          '  list [--running] [--since D]   list sessions, newest first\n' +
          '  fleet                          every session: status, agent, title, cwd,\n' +
          '                                  last activity, and outstanding background jobs\n' +
          '  show <session-id> [--tail N]   header, counts, and a transcript tail (default 10)\n' +
          '  cancel <session-id>            cancel a running session\n' +
          '  seed                           seed the standard agent config + extensions\n' +
          '  extensions [register …]        list or register extensions\n',
      )
      process.exitCode = command ? 1 : 0
  }
}

if (isMain(import.meta.url)) runCli(main)
