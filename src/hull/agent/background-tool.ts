import {
  defineTool,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import type { BackgroundJobs } from './background'

// The agent-facing half of background jobs: a custom tool that hands a long
// command to the jobs manager (background.ts) and, via `terminate: true`, ends
// the agent's turn. The session is re-invoked with the result when the command
// finishes (see runtime wiring). This is how a builder waits on CI without
// blocking its turn (which times out) or stopping forever (which stalls).
//
// Registered per session, so the closure carries the session's id + cwd.

const PARAMS = Type.Object({
  command: Type.String({
    description: 'The shell command to run in the background.',
  }),
  label: Type.String({
    description:
      'A short label for what you are waiting on (e.g. "PR #12 CI").',
  }),
})

export function createBackgroundTool(
  sessionId: string,
  cwd: string,
  jobs: BackgroundJobs,
): ToolDefinition {
  return defineTool({
    name: 'background',
    label: 'Background a command',
    description:
      'Run a long-running command (e.g. waiting on CI checks) in the background, then END YOUR TURN. You are automatically resumed with the command output when it finishes. Use this instead of blocking on, polling, or --watch-ing a slow command.',
    promptSnippet:
      'background(command, label) — run a long wait in the background and end your turn; you are resumed with the result.',
    promptGuidelines: [
      'To wait on anything slow (CI checks, a long build), call `background` with the command and a label, then STOP — do not poll, sleep-loop, or block a turn. You will be re-invoked automatically with the result.',
    ],
    parameters: PARAMS,
    execute: (_toolCallId, params) => {
      const jobId = jobs.start({
        sessionId,
        command: params.command,
        label: params.label,
        cwd,
      })
      return Promise.resolve({
        content: [
          {
            type: 'text' as const,
            text: `Backgrounded "${params.label}" (job ${jobId}). Ending your turn now — you'll be resumed automatically when it finishes.`,
          },
        ],
        details: { jobId },
        terminate: true,
      })
    },
  })
}
