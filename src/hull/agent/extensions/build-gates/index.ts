import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { isToolCallEventType } from '@earendil-works/pi-coding-agent'

import {
  blockReason,
  checkPassed,
  hasUnpushedCommits,
  isCommitCommand,
} from './gates'

/* v8 ignore start -- live pi.dev extension wiring; the decisions are unit-tested in gates.test.ts */

/**
 * The build-gates extension: pi.dev's answer to Skylark's Claude Code hooks,
 * for builder agents. The human's harness runs shell hooks (scripts/commit-gate,
 * scripts/landing-gate, scripts/setup); pi's equivalent is a TS extension that
 * intercepts the agent's lifecycle. This mirrors all three:
 *
 * - **commit-gate** — before a `git add`/`git commit` bash call, run
 *   `npm run check`; if it fails, block the commit and hand back the errors.
 * - **session-start** — run `./scripts/setup` so a fresh worktree has deps.
 * - **landing-gate** — at session shutdown, warn if commits are unpushed.
 *   (pi's shutdown hook can't veto, so this is best-effort: a loud notify, the
 *   strongest signal the extension model offers at end-of-session.)
 *
 * The pure decisions (is this a commit? did check pass?) live in gates.ts and
 * are unit-tested there; this file is the impure shell that calls pi and shell.
 */
const buildGates = (pi: ExtensionAPI): void => {
  // commit-gate: gate `git add`/`git commit` on a clean `npm run check`.
  pi.on('tool_call', async (event, ctx: ExtensionContext) => {
    if (!isToolCallEventType('bash', event)) return
    if (!isCommitCommand(event.input.command)) return

    const result = await pi.exec('npm', ['run', 'check'], { cwd: ctx.cwd })
    if (checkPassed(result.code)) return

    return {
      block: true,
      reason: blockReason(event.input.command, result.stdout + result.stderr),
    }
  })

  // session-start: bootstrap a fresh worktree (idempotent).
  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    await pi.exec('./scripts/setup', [], { cwd: ctx.cwd })
  })

  // landing-gate: at shutdown, warn about committed-but-unpushed work.
  pi.on('session_shutdown', async (_event, ctx: ExtensionContext) => {
    const result = await pi.exec('git', ['log', '@{u}..HEAD', '--oneline'], {
      cwd: ctx.cwd,
    })
    // A nonzero code usually means no upstream is set — also worth flagging.
    if (result.code !== 0 || hasUnpushedCommits(result.stdout)) {
      ctx.ui.notify(
        'Landing gate: this session has committed work that is not pushed/PRd. Push and open a PR before you call it shipped.',
        'warning',
      )
    }
  })
}

export default buildGates
/* v8 ignore stop */
