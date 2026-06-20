import { db } from '@hull/db/client'
import { errorMessage } from '@hull/lib/errors'
import { cliActor } from '@hull/users/actor'
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

/** The acting user, or throw a friendly error if the crew isn't seeded. */
async function actor(): Promise<{ id: string; handle: string }> {
  const a = await cliActor()
  if (!a)
    throw new Error(
      'No actor resolved — seed the crew (`npm run users seed`) or set SKYLARK_ACTOR.',
    )
  return a
}

async function cmdNew(args: string[]): Promise<void> {
  const title = args.join(' ').trim()
  if (!title) throw new Error('usage: issue new <title>')
  const me = await actor()
  const issue = await createIssue(db, { title, authorId: me.id })
  process.stdout.write(
    `Opened #${issue.nano} ${DIM}${issue.id}${RESET}\n${issue.title}\n`,
  )
}

async function cmdList(): Promise<void> {
  const list = await listIssues(db)
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
  const issue = await resolveIssueRef(db, ref)
  if (!issue) throw new Error(`No such issue: ${ref}`)
  const author = await getUserById(db, issue.authorId)
  process.stdout.write(
    `${STATUS_MARK[issue.status]} #${issue.nano} ${issue.title}  ${DIM}[${issue.status}]${RESET}\n` +
      `${DIM}by @${author?.handle ?? '?'} · ${issue.id}${RESET}\n`,
  )
  if (issue.branchName)
    process.stdout.write(`${DIM}branch ${issue.branchName}${RESET}\n`)
  if (issue.body) process.stdout.write(`\n${issue.body}\n`)
  const comments = await listComments(db, issue.id)
  for (const c of comments) {
    const who = await getUserById(db, c.authorId)
    process.stdout.write(`\n${DIM}@${who?.handle ?? '?'}:${RESET} ${c.body}\n`)
  }
}

async function cmdComment(args: string[]): Promise<void> {
  const [ref, ...bodyParts] = args
  const body = bodyParts.join(' ').trim()
  if (!ref || !body) throw new Error('usage: issue comment <id> <text>')
  const issue = await resolveIssueRef(db, ref)
  if (!issue) throw new Error(`No such issue: ${ref}`)
  const me = await actor()
  await addComment(db, { issueId: issue.id, authorId: me.id, body })
  process.stdout.write(`Commented on #${issue.nano} as @${me.handle}.\n`)
}

/** Move an issue to a status. Shared by `status <id> <word>` and the verbs. */
async function transitionTo(ref: string, word: string): Promise<void> {
  const to = resolveStatusWord(word)
  if (!to) throw new Error(`Unknown status: ${word} (open|building|done|close)`)
  const issue = await resolveIssueRef(db, ref)
  if (!issue) throw new Error(`No such issue: ${ref}`)
  const me = await actor()
  const moved = await transitionIssue(db, {
    issueId: issue.id,
    to,
    actorId: me.id,
  })
  process.stdout.write(`#${moved.nano} → ${moved.status} (by @${me.handle})\n`)
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
          '  new <title>              open an issue\n' +
          '  list                     list issues, newest first\n' +
          '  show <id>                show an issue, its branch, and its thread\n' +
          '  comment <id> <text>      add a comment\n' +
          '  status <id> <state>      move status (open|building|done|close)\n' +
          '  building|open|done|close <id>   move status (shorthand)\n',
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
