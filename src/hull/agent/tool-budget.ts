import type { ToolDefinition } from '@earendil-works/pi-coding-agent'

// A wall-clock budget for foreground tool calls (issue #83ph). A hung call —
// a runaway `find /`, a vitest run that never exits — used to keep a session
// `running` forever, because nothing in the runtime bounded a tool's duration.
//
// This module is the pure decision: what the budget is (default 10 minutes,
// `SKYLARK_TOOL_BUDGET_MS` overrides), which tools it covers (every foreground
// tool; `background` is exempt — it ends the turn by design and has its own
// health-check story, #q9d9), and what happens at the deadline (abort the
// call's own AbortSignal — pi's bash tool kills its whole process tree on
// abort — and reject with copy that teaches the escape hatch).
//
// Rejecting is the contract: pi's agent loop catches a throwing `execute` and
// feeds the error message back to the model as an `isError` tool result, then
// carries on — so the TURN RETURNS and the agent can react (self-recovery),
// instead of the session hanging. Crucially the budget aborts a per-call
// controller, never the turn's own signal: kill the call, not the turn.
//
// The live wiring — wrapping the real coding tools at session construction —
// lives in runtime.ts (`createPiSession`).

/** The default per-call budget: 10 minutes of wall-clock time. */
export const DEFAULT_TOOL_BUDGET_MS = 10 * 60 * 1000

/**
 * Tools exempt from the budget. `background` hands the wait to the jobs
 * manager and terminates the turn — bounding it would defeat its purpose.
 */
const EXEMPT_TOOL_NAMES = new Set(['background'])

/**
 * The budget in milliseconds: `SKYLARK_TOOL_BUDGET_MS` when it's a positive
 * number, else the 10-minute default. Injectable env for tests.
 */
export function toolBudgetMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SKYLARK_TOOL_BUDGET_MS
  if (!raw) return DEFAULT_TOOL_BUDGET_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOOL_BUDGET_MS
}

/** 600000 → "10m", 90000 → "90s", 1500 → "1500ms" — for the error copy. */
function formatBudget(ms: number): string {
  if (ms % 60_000 === 0) return `${String(ms / 60_000)}m`
  if (ms % 1_000 === 0) return `${String(ms / 1_000)}s`
  return `${String(ms)}ms`
}

/**
 * The error the model sees after a budget kill. It must teach the escape
 * hatch, not just report the death: long waits belong in `background`.
 */
function budgetKillMessage(toolName: string, budgetMs: number): string {
  return (
    `${toolName} was killed after running past its ${formatBudget(budgetMs)} ` +
    'foreground budget. Long-running commands belong in the `background` ' +
    'tool: call it with the command and a label, then end your turn — you ' +
    'are resumed automatically with the result.'
  )
}

/**
 * Wrap a tool so its execute runs under a wall-clock budget. Past the budget
 * the call's private AbortSignal fires (pi's tools kill their work on abort —
 * bash reaps its whole process tree) and the call rejects with the teaching
 * copy. A turn-level abort (cancel) still reaches the tool through the same
 * private signal; the tool's own abort error propagates unchanged.
 *
 * If a tool ignored its signal entirely, the rejection alone still ends the
 * call from the loop's point of view — the dangling promise is settled or
 * leaked by the tool, but the turn is no longer hostage to it.
 */
export function withToolBudget(
  tool: ToolDefinition,
  budgetMs: number,
): ToolDefinition {
  return {
    ...tool,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      return new Promise((resolve, reject) => {
        // One controller per call: the budget aborts THIS call's work without
        // touching the turn's signal, so the turn survives the kill.
        const call = new AbortController()
        const forwardAbort = () => {
          call.abort()
        }
        if (signal?.aborted) call.abort()
        else signal?.addEventListener('abort', forwardAbort, { once: true })

        const deadline = setTimeout(() => {
          call.abort() // bash kills its process tree synchronously on abort
          reject(new Error(budgetKillMessage(tool.name, budgetMs)))
        }, budgetMs)
        const disarm = () => {
          clearTimeout(deadline)
          signal?.removeEventListener('abort', forwardAbort)
        }

        tool.execute(toolCallId, params, call.signal, onUpdate, ctx).then(
          (result) => {
            disarm()
            resolve(result)
          },
          (err: unknown) => {
            disarm()
            // After a budget kill this promise is already rejected; settling
            // again is a no-op, and the handler keeps the tool's own late
            // rejection ("Command aborted") from going unhandled.
            reject(err instanceof Error ? err : new Error(String(err)))
          },
        )
      })
    },
  }
}

/** Budget-wrap a set of tools, leaving the exempt ones untouched. */
export function withToolBudgets(
  tools: ToolDefinition[],
  budgetMs: number,
): ToolDefinition[] {
  return tools.map((tool) =>
    EXEMPT_TOOL_NAMES.has(tool.name) ? tool : withToolBudget(tool, budgetMs),
  )
}
