import { systemDb } from '@hull/db/client'
import { isMain, runCli } from '@hull/lib/cli'
import { getIssue } from '@hull/issues/service'

import { listJobCheckRows, listNudgeRows, resolveWatchConfig } from './service'

// The default door onto the night watch — READ-ONLY by design. The watch acts
// only from the server process's own sweep, through the issues orchestrator's
// runtime; a CLI in a SEPARATE process must never drive a turn, since that
// would spin up a fresh runtime and double-drive a session the server already
// owns (the #69iz ownership caveat). So this door only INSPECTS: the config the
// sweep runs with, and the watch's memory of what it has already done.
//
//   node --env-file=.env --import tsx src/hull/watch/cli.ts status
//   (or `npm run watch -- status`). Needs Postgres up (`npm run db:up`).

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

function minutes(ms: number): string {
  return `${String(Math.round(ms / 60_000))}m`
}

function when(at: Date | null): string {
  return at ? at.toISOString() : '—'
}

async function cmdStatus(): Promise<void> {
  const config = resolveWatchConfig(process.env)
  process.stdout.write(
    `night watch\n` +
      `${DIM}sweep every ${minutes(config.sweepMs)} · stall after ` +
      `${minutes(config.stallThresholdMs)} · background check-in every ` +
      `${minutes(config.jobCheckIntervalMs)} (per-job override wins)${RESET}\n\n`,
  )

  const nudges = await listNudgeRows(systemDb)
  process.stdout.write(`stall nudges (${String(nudges.length)})\n`)
  if (nudges.length === 0) {
    process.stdout.write(`${DIM}  none — no build has stalled${RESET}\n`)
  }
  for (const row of nudges) {
    const issue = await getIssue(systemDb, row.issueId)
    const ref = issue ? `#${issue.nano} ${issue.title}` : row.issueId
    const stage =
      row.nudgeCount >= 3
        ? 'escalated to owner'
        : `${String(row.nudgeCount)} nudge(s)`
    process.stdout.write(
      `  ${ref}\n${DIM}    ${stage} · last ${when(row.lastNudgeAt)}${RESET}\n`,
    )
  }

  const checks = await listJobCheckRows(systemDb)
  process.stdout.write(
    `\nbackground health checks (${String(checks.length)})\n`,
  )
  if (checks.length === 0) {
    process.stdout.write(`${DIM}  none — no long background wait${RESET}\n`)
  }
  for (const row of checks) {
    process.stdout.write(
      `  job ${row.jobId}\n${DIM}    ${String(row.checkCount)} check(s) · ` +
        `last ${when(row.lastCheckedAt)}${RESET}\n`,
    )
  }
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2)
  switch (command) {
    case 'status':
      return cmdStatus()
    default:
      process.stdout.write(
        'usage: watch <status>\n' +
          '  status   the sweep config + the watch memory (nudges, health checks)\n',
      )
      process.exitCode = command ? 1 : 0
  }
}

if (isMain(import.meta.url)) runCli(main)
