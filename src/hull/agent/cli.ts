import { uuidv7 } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'

import { db } from '@hull/db/client'
import { errorMessage } from '@hull/lib/errors'
import { truncate } from '@hull/lib/text'

import {
  type AgentRuntime,
  createAgentRuntime,
  createPiSession,
  DEFAULT_MODEL,
} from './runtime'
import {
  createSession,
  getSession,
  listSessions,
  titleFromMessage,
} from './service'
import { stringifyArgs } from './transcript'

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
    case 'tool_execution_start':
      process.stdout.write(
        `\n${CYAN}🔧 ${event.toolName}${RESET} ${summarize(event.args)}\n`,
      )
      break
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

/** One-line preview of a tool call's args — the same stringify the transcript
 * uses (unserializable-safe), trimmed to a terminal-friendly width. */
function summarize(args: unknown): string {
  return truncate(stringifyArgs(args), 120)
}

/** A runtime wired to the live database and a real pi.dev session. */
function liveRuntime(): AgentRuntime {
  return createAgentRuntime({ db, factory: createPiSession })
}

/** Boot a one-shot runtime, stream a single turn to the terminal, dispose. */
async function runOneTurn(id: string, message: string): Promise<void> {
  const runtime = liveRuntime()
  try {
    await runtime.runTurn(id, message, renderEvent)
  } finally {
    runtime.disposeAll()
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
  await createSession(db, { id, model, title: titleFromMessage(message) })
  process.stdout.write(`${DIM}session ${id} · ${model}${RESET}\n`)

  await runOneTurn(id, message)
}

async function cmdSend(args: string[]): Promise<void> {
  const [id, ...messageParts] = args
  const message = messageParts.join(' ').trim()
  if (!id || !message)
    throw new Error('usage: agent send <session-id> <message>')

  const session = await getSession(db, id)
  if (!session) throw new Error(`No such session: ${id}`)

  await runOneTurn(id, message)
}

async function cmdList(args: string[]): Promise<void> {
  let rest = args
  const running = rest.includes('--running') ? true : undefined
  rest = rest.filter((a) => a !== '--running')
  const [since] = takeFlag(rest, '--since')

  const sessions = await listSessions(db, {
    running,
    since: since ? new Date(since) : undefined,
  })

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
  const runtime = liveRuntime()
  await runtime.cancel(id)
  process.stdout.write(`Cancelled ${id}.\n`)
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
    default:
      process.stdout.write(
        'usage: agent <new|send|list|cancel> …\n' +
          '  new <message> [--model <id>]   start a session and send the first message\n' +
          '  send <session-id> <message>    send a message (queued if mid-turn)\n' +
          '  list [--running] [--since D]   list sessions, newest first\n' +
          '  cancel <session-id>            cancel a running session\n',
      )
      process.exitCode = command ? 1 : 0
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err: unknown) => {
    process.stderr.write(`\n${errorMessage(err)}\n`)
    process.exit(1)
  })
