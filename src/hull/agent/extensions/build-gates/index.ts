import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'
import { isToolCallEventType } from '@earendil-works/pi-coding-agent'

import {
  blockReason,
  checkPassed,
  isCommitCommand,
  needsSetup,
  setupLogMessage,
  shouldWarnUnpushed,
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

  // session-start: bootstrap a fresh worktree (idempotent). Check the result
  // so setup failures are visible, not swallowed — a worktree with no
  // node_modules makes every subsequent npm/gate command crash (#m5qt).
  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    // Only run setup if it's actually needed (node_modules missing), so we
    // don't slow down every session resume with redundant npm installs.
    if (!needsSetup(ctx.cwd)) {
      console.log('session_start: node_modules present, skipping setup')
      return
    }

    console.log('session_start: running ./scripts/setup...')
    const result = await pi.exec('./scripts/setup', [], { cwd: ctx.cwd })
    const message = setupLogMessage(result.code, result.stdout + result.stderr)
    console.log(message)

    // If setup failed, notify the agent through the UI so it knows something
    // went wrong and can report it rather than continuing blindly (#m5qt).
    if (result.code !== 0) {
      ctx.ui.notify(
        `Worktree setup failed — ./scripts/setup exited ${String(result.code)}. ` +
          `Check the logs and report this in the issue thread rather than proceeding.`,
        'error',
      )
    }
  })

  // landing-gate: at shutdown, warn about committed-but-unpushed work.
  pi.on('session_shutdown', async (_event, ctx: ExtensionContext) => {
    const result = await pi.exec('git', ['log', '@{u}..HEAD', '--oneline'], {
      cwd: ctx.cwd,
    })
    if (shouldWarnUnpushed(result.code, result.stdout)) {
      ctx.ui.notify(
        'Landing gate: this session has committed work that is not pushed/PRd. Push and open a PR before you call it shipped.',
        'warning',
      )
    }
  })
}

export default buildGates
/* v8 ignore stop */
