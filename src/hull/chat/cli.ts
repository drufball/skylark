import { uuidv7 } from '@earendil-works/pi-agent-core'

import { isMain, runCli } from '@hull/lib/cli'
import { withCliActor } from '@hull/users/actor'

import {
  addMessage,
  ensureChatVisible,
  getChat,
  listChatSummaries,
  listMembers,
  listMessages,
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

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'list':
      return cmdList()
    case 'show':
      return cmdShow(args)
    case 'post':
      return cmdPost(args)
    default:
      process.stdout.write(
        'usage: chat <list|show|post> …\n' +
          '  list                      chats you are in, newest activity first\n' +
          '  show <chatId> [--limit N] recent messages (default 20)\n' +
          '  post <chatId> <message>   post a message as yourself\n',
      )
      process.exitCode = command ? 1 : 0
  }
}

if (isMain(import.meta.url)) runCli(main)
