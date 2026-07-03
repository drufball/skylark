import { ensureChatVisible } from '@hull/chat/service'
import { isMain, runCli } from '@hull/lib/cli'
import { withCliActor } from '@hull/users/actor'
import { getUserById } from '@hull/users/service'

import {
  addComment,
  createIssue,
  listComments,
  listIssues,
  resolveIssueRef,
  resolveStatusWord,
  transitionIssue,
} from './service'
import type { IssueStatus } from './schema'

// The default door onto the issues service — the message board, drivable from a
// terminal or an agent's bash tool. Run it with:
//   node --env-file=.env --import tsx src/hull/issues/cli.ts <command> …
// (or `npm run issue -- <command> …`). Needs Postgres up (`npm run db:up`).
//
// Every action attributes to cliActor(): an explicit SKYLARK_ACTOR=<userId>
// wins (that's how the orchestrator injects a builder agent's identity into its
// tool environment, so the agent's comments and transitions show as the agent),
// else the operator. This is the door a building agent drives to report back —
// `issue comment <id> "…"`, `issue done <id>`, `issue open <id>`.

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const STATUS_MARK: Record<IssueStatus, string> = {
  open: '○',
  building: '●',
  done: '✓',
  closed: '✗',
}

/**
 * Parse `issue new`'s args: the title, plus optional `--body <text>` and
 * `--chat <id>` (the chat this issue was filed from — how notifications about
 * it route back to that conversation). A flag present without a value (or with
 * another flag where its value should be) is a loud usage error, not a
 * silently unrouted issue.
 */
export function parseNewArgs(args: string[]): {
  title: string
  body?: string
  originChatId?: string
} {
  const rest = [...args]
  const takeFlag = (flag: string): string | undefined => {
    const at = rest.indexOf(flag)
    if (at === -1) return undefined
    const value = rest.at(at + 1)
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`)
    }
    rest.splice(at, 2)
    return value
  }
  const body = takeFlag('--body')
  const originChatId = takeFlag('--chat')
  return { title: rest.join(' ').trim(), body, originChatId }
}

async function cmdNew(args: string[]): Promise<void> {
  const { title, body, originChatId } = parseNewArgs(args)
  if (!title)
    throw new Error('usage: issue new <title> [--body <text>] [--chat <id>]')
  const issue = await withCliActor(async (tx, me) => {
    // Provenance must be honest: the filer can only claim a chat they're in.
    // ensureChatVisible probes under the actor's RLS, so a forged or foreign
    // chat id reads as not-a-member — and the wake can't be routed into a
    // conversation the filer never saw.
    if (originChatId) await ensureChatVisible(tx, originChatId)
    return createIssue(tx, { title, body, originChatId, authorId: me.id })
  })
  process.stdout.write(
    `Opened #${issue.nano} ${DIM}${issue.id}${RESET}\n${issue.title}\n`,
  )
}

async function cmdList(): Promise<void> {
  const list = await withCliActor((tx) => listIssues(tx))
  if (list.length === 0) {
    process.stdout.write('No issues — open one with `npm run issue new`.\n')
    return
  }
  for (const i of list) {
    const line = i.statusLine ? `  ${DIM}— ${i.statusLine}${RESET}` : ''
    process.stdout.write(
      `${STATUS_MARK[i.status]} #${i.nano} ${i.title}${line}\n`,
    )
  }
}

async function cmdShow(args: string[]): Promise<void> {
  const [ref] = args
  if (!ref) throw new Error('usage: issue show <id>')
  await withCliActor(async (tx) => {
    const issue = await resolveIssueRef(tx, ref)
    if (!issue) throw new Error(`No such issue: ${ref}`)
    const author = await getUserById(tx, issue.authorId)
    process.stdout.write(
      `${STATUS_MARK[issue.status]} #${issue.nano} ${issue.title}  ${DIM}[${issue.status}]${RESET}\n` +
        `${DIM}by @${author?.handle ?? '?'} · ${issue.id}${RESET}\n`,
    )
    if (issue.branchName)
      process.stdout.write(`${DIM}branch ${issue.branchName}${RESET}\n`)
    if (issue.body) process.stdout.write(`\n${issue.body}\n`)
    const comments = await listComments(tx, issue.id)
    for (const c of comments) {
      const who = await getUserById(tx, c.authorId)
      process.stdout.write(
        `\n${DIM}@${who?.handle ?? '?'}:${RESET} ${c.body}\n`,
      )
    }
  })
}

async function cmdComment(args: string[]): Promise<void> {
  const [ref, ...bodyParts] = args
  const body = bodyParts.join(' ').trim()
  if (!ref || !body) throw new Error('usage: issue comment <id> <text>')
  const { nano, handle } = await withCliActor(async (tx, me) => {
    const issue = await resolveIssueRef(tx, ref)
    if (!issue) throw new Error(`No such issue: ${ref}`)
    await addComment(tx, { issueId: issue.id, authorId: me.id, body })
    return { nano: issue.nano, handle: me.handle }
  })
  process.stdout.write(`Commented on #${nano} as @${handle}.\n`)
}

/** Move an issue to a status. Shared by `status <id> <word>` and the verbs. */
async function transitionTo(ref: string, word: string): Promise<void> {
  const to = resolveStatusWord(word)
  if (!to) throw new Error(`Unknown status: ${word} (open|building|done|close)`)
  const { moved, handle } = await withCliActor(async (tx, me) => {
    const issue = await resolveIssueRef(tx, ref)
    if (!issue) throw new Error(`No such issue: ${ref}`)
    return {
      moved: await transitionIssue(tx, {
        issueId: issue.id,
        to,
        actorId: me.id,
      }),
      handle: me.handle,
    }
  })
  process.stdout.write(`#${moved.nano} → ${moved.status} (by @${handle})\n`)
}

async function cmdStatus(args: string[]): Promise<void> {
  const [ref, word] = args
  if (!ref || !word) throw new Error('usage: issue status <id> <state>')
  await transitionTo(ref, word)
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'new':
      return cmdNew(args)
    case 'list':
      return cmdList()
    case 'show':
      return cmdShow(args)
    case 'comment':
      return cmdComment(args)
    case 'status':
      return cmdStatus(args)
    // Friendly verbs: `issue building <id>`, `issue done <id>`, etc.
    case 'building':
    case 'open':
    case 'done':
    case 'close': {
      const [ref] = args
      if (!ref) throw new Error(`usage: issue ${command} <id>`)
      return transitionTo(ref, command)
    }
    default:
      process.stdout.write(
        'usage: issue <new|list|show|comment|status|building|open|done|close> …\n' +
          '  new <title> [--body <text>] [--chat <id>]   open an issue\n' +
          '  list                          list issues, newest first\n' +
          '  show <id>                     show an issue, its branch, and its thread\n' +
          '  comment <id> <text>           add a comment\n' +
          '  status <id> <state>           move status (open|building|done|close)\n' +
          '  building|open|done|close <id> move status (shorthand)\n',
      )
      process.exitCode = command ? 1 : 0
  }
}

if (isMain(import.meta.url)) runCli(main)
