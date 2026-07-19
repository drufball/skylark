import { uuidv7 } from '@earendil-works/pi-agent-core'

import { isMain, runCli } from '@hull/lib/cli'
import { withCliActor } from '@hull/users/actor'

import {
  addMessage,
  canAuthorSchedule,
  createSchedule,
  deleteSchedule,
  ensureChatVisible,
  getChat,
  getSchedule,
  listChatSummaries,
  listMembers,
  listMessages,
  listSchedules,
  scheduleTiming,
} from './service'

// The default door onto the chat service for an agent's own bash tool — how an
// agent woken on its inbox session (hull/chat/orchestrator.ts `wake`) finds the
// chat an update belongs in and posts it there, mirroring `npm run issue`'s
// conventions exactly:
//   node --env-file=.env --import tsx src/hull/chat/cli.ts <command> …
// (or `npm run chat -- <command> …`). Needs Postgres up (`npm run db:up`).
//
// Every action attributes to cliActor(): an explicit SKYLARK_ACTOR=<userId>
// wins (how the waker's wake turn posts as the agent itself), else the
// operator. Every door runs under withCliActor, so RLS filters reads and gates
// writes to the actor's own chats — the same membership-is-visibility policy
// the web door rides.

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const DEFAULT_SHOW_LIMIT = 20

async function cmdList(): Promise<void> {
  const chats = await withCliActor((tx, me) => listChatSummaries(tx, me.id))
  if (chats.length === 0) {
    process.stdout.write('No chats — start one from the app.\n')
    return
  }
  for (const chat of chats) {
    const label =
      chat.title ?? chat.memberHandles.map((h) => `@${h}`).join(', ')
    process.stdout.write(
      `${chat.id}  ${label}\n` +
        `  ${DIM}last activity ${chat.lastMessageAt.toISOString()}${RESET}\n`,
    )
  }
}

/** Parse `show`'s args: the chat id, plus an optional `--limit N`. */
export function parseShowArgs(args: string[]): {
  chatId?: string
  limit: number
} {
  const rest = [...args]
  const at = rest.indexOf('--limit')
  let limit = DEFAULT_SHOW_LIMIT
  if (at !== -1) {
    const value = rest.at(at + 1)
    const parsed = value ? Number.parseInt(value, 10) : NaN
    if (!value || Number.isNaN(parsed) || parsed <= 0)
      throw new Error('--limit requires a positive number')
    limit = parsed
    rest.splice(at, 2)
  }
  return { chatId: rest.at(0), limit }
}

async function cmdShow(args: string[]): Promise<void> {
  const { chatId, limit } = parseShowArgs(args)
  if (!chatId) throw new Error('usage: chat show <chatId> [--limit N]')
  await withCliActor(async (tx) => {
    await ensureChatVisible(tx, chatId)
    const chat = await getChat(tx, chatId)
    const members = await listMembers(tx, chatId)
    const label = chat?.title ?? members.map((m) => `@${m.handle}`).join(', ')
    process.stdout.write(`${chatId}  ${label}\n`)
    const messages = await listMessages(tx, chatId)
    for (const m of messages.slice(-limit)) {
      process.stdout.write(`@${m.authorHandle}: ${m.body}\n`)
    }
  })
}

async function cmdPost(args: string[]): Promise<void> {
  const [chatId, ...bodyParts] = args
  const body = bodyParts.join(' ').trim()
  if (!chatId || !body) throw new Error('usage: chat post <chatId> <message>')
  const { handle } = await withCliActor(async (tx, me) => {
    await ensureChatVisible(tx, chatId)
    // Reuse the same addMessage the web door calls: it emits
    // chat.message_posted exactly once, so the durable row + pg_notify reach
    // the running server's SSE stream and orchestrator subscription — a CLI
    // post is heard the same way a browser post is.
    await addMessage(tx, { id: uuidv7(), chatId, authorId: me.id, body })
    return { handle: me.handle }
  })
  process.stdout.write(`Posted to ${chatId} as @${handle}.\n`)
}

/**
 * Parse `schedule new`'s args: the chat id + message body (positional), plus
 * the timing/author flags. `--at <iso>` and `--every <minutes>` are the one-shot
 * vs recurring choice (the service enforces exactly-one); `--as <handle>` posts
 * as a chat member other than you (an agent). Pure + exported so it's tested
 * directly, like `parseShowArgs`.
 */
export function parseScheduleNewArgs(args: string[]): {
  chatId?: string
  at?: string
  every?: number
  as?: string
  body: string
} {
  const rest = [...args]
  function takeFlag(name: string): string | undefined {
    const at = rest.indexOf(name)
    if (at === -1) return undefined
    const value = rest.at(at + 1)
    if (!value) throw new Error(`${name} requires a value`)
    rest.splice(at, 2)
    return value
  }
  const at = takeFlag('--at')
  const everyRaw = takeFlag('--every')
  const as = takeFlag('--as')
  let every: number | undefined
  if (everyRaw !== undefined) {
    const parsed = Number.parseInt(everyRaw, 10)
    if (Number.isNaN(parsed))
      throw new Error('--every requires a number of minutes')
    every = parsed
  }
  const [chatId, ...bodyParts] = rest
  return { chatId, at, every, as, body: bodyParts.join(' ').trim() }
}

async function cmdScheduleNew(args: string[]): Promise<void> {
  const { chatId, at, every, as, body } = parseScheduleNewArgs(args)
  if (!chatId || !body)
    throw new Error(
      'usage: chat schedule new <chatId> (--at <iso> | --every <minutes>) [--as <handle>] <message>',
    )
  const fireAt = at ? new Date(at) : null
  if (fireAt && Number.isNaN(fireAt.getTime()))
    throw new Error(`invalid --at time: ${at ?? ''}`)

  const scheduleId = await withCliActor(async (tx, me) => {
    await ensureChatVisible(tx, chatId)
    const members = await listMembers(tx, chatId)
    let authorId = me.id
    if (as) {
      const handle = as.replace(/^@/, '').toLowerCase()
      const member = members.find((m) => m.handle.toLowerCase() === handle)
      if (!member) throw new Error(`no member @${handle} in this chat`)
      authorId = member.userId
    }
    if (!canAuthorSchedule({ actorId: me.id, authorId, members }))
      throw new Error(
        'a schedule may post only as yourself or an agent in this chat',
      )
    const timing = scheduleTiming({
      now: new Date(),
      fireAt,
      intervalMinutes: every ?? null,
    })
    const row = await createSchedule(tx, {
      id: uuidv7(),
      chatId,
      authorId,
      body,
      createdById: me.id,
      ...timing,
    })
    return row.id
  })
  process.stdout.write(`Scheduled ${scheduleId} in ${chatId}.\n`)
}

async function cmdScheduleList(args: string[]): Promise<void> {
  const chatId = args.at(0)
  if (!chatId) throw new Error('usage: chat schedule list <chatId>')
  await withCliActor(async (tx) => {
    await ensureChatVisible(tx, chatId)
    const rows = await listSchedules(tx, chatId)
    if (rows.length === 0) {
      process.stdout.write('No schedules.\n')
      return
    }
    for (const s of rows) {
      const when =
        s.intervalMinutes != null
          ? `every ${String(s.intervalMinutes)}m, next ${s.nextFireAt?.toISOString() ?? '—'}`
          : `once at ${s.fireAt?.toISOString() ?? '—'}`
      const state = s.enabled ? '' : ' (off)'
      process.stdout.write(
        `${s.id}  @${s.authorHandle}${state}\n` +
          `  ${DIM}${when}${RESET}\n` +
          `  ${s.body}\n`,
      )
    }
  })
}

async function cmdScheduleRm(args: string[]): Promise<void> {
  const scheduleId = args.at(0)
  if (!scheduleId) throw new Error('usage: chat schedule rm <scheduleId>')
  await withCliActor(async (tx) => {
    if (!(await getSchedule(tx, scheduleId)))
      throw new Error('no such schedule (or not a member of its chat)')
    await deleteSchedule(tx, scheduleId)
  })
  process.stdout.write(`Removed ${scheduleId}.\n`)
}

async function cmdSchedule(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  switch (sub) {
    case 'new':
      return cmdScheduleNew(rest)
    case 'list':
      return cmdScheduleList(rest)
    case 'rm':
      return cmdScheduleRm(rest)
    default:
      throw new Error(
        'usage: chat schedule <new|list|rm> …\n' +
          '  new <chatId> (--at <iso> | --every <minutes>) [--as <handle>] <message>\n' +
          '  list <chatId>             schedules on a chat\n' +
          '  rm <scheduleId>           delete a schedule',
      )
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'list':
      return cmdList()
    case 'show':
      return cmdShow(args)
    case 'post':
      return cmdPost(args)
    case 'schedule':
      return cmdSchedule(args)
    default:
      process.stdout.write(
        'usage: chat <list|show|post|schedule> …\n' +
          '  list                      chats you are in, newest activity first\n' +
          '  show <chatId> [--limit N] recent messages (default 20)\n' +
          '  post <chatId> <message>   post a message as yourself\n' +
          '  schedule <new|list|rm> …  manage scheduled messages\n',
      )
      process.exitCode = command ? 1 : 0
  }
}

if (isMain(import.meta.url)) runCli(main)
