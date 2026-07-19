import type {
  ExtensionContext,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_TOOL_BUDGET_MS,
  toolBudgetMs,
  withToolBudget,
  withToolBudgets,
} from './tool-budget'

// The wrapper only forwards the ExtensionContext; a marker object keeps the
// pass-through assertion honest without constructing a real one.
const ctx = { marker: 'ctx' } as unknown as ExtensionContext

const ok = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  details: undefined,
})

/** A fake tool whose execute we script per test. */
function fakeTool(
  execute: ToolDefinition['execute'],
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name: 'bash',
    label: 'Bash',
    description: 'a fake tool',
    promptSnippet: 'bash(command)',
    parameters: Type.Object({}),
    execute,
    ...overrides,
  }
}

/**
 * A tool that hangs until its signal aborts, then rejects the way pi's bash
 * tool does ("Command aborted") — the runaway `find /` in miniature.
 */
function hangingTool(seen: { signal?: AbortSignal }): ToolDefinition {
  return fakeTool(
    (_id, _params, signal) =>
      new Promise((_resolve, reject) => {
        seen.signal = signal
        signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('Command aborted'))
          },
          { once: true },
        )
      }),
  )
}

describe('toolBudgetMs', () => {
  it('defaults to 10 minutes', () => {
    expect(toolBudgetMs({})).toBe(10 * 60 * 1000)
    expect(DEFAULT_TOOL_BUDGET_MS).toBe(600_000)
  })

  it('honors SKYLARK_TOOL_BUDGET_MS', () => {
    expect(toolBudgetMs({ SKYLARK_TOOL_BUDGET_MS: '120000' })).toBe(120_000)
  })

  it.each(['nope', '0', '-5', ''])(
    'falls back to the default on invalid value %j',
    (raw) => {
      expect(toolBudgetMs({ SKYLARK_TOOL_BUDGET_MS: raw })).toBe(
        DEFAULT_TOOL_BUDGET_MS,
      )
    },
  )
})

describe('withToolBudget', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes a result through when the tool finishes under budget', async () => {
    const tool = withToolBudget(
      fakeTool((id) => Promise.resolve(ok(`ran ${id}`))),
      600_000,
    )
    await expect(
      tool.execute('call-1', {}, undefined, undefined, ctx),
    ).resolves.toEqual(ok('ran call-1'))
  })

  it('disarms the budget once the tool finishes (no late abort)', async () => {
    const seen: { signal?: AbortSignal } = {}
    const tool = withToolBudget(
      fakeTool((_id, _params, signal) => {
        seen.signal = signal
        return Promise.resolve(ok('done'))
      }),
      600_000,
    )
    await tool.execute('call-1', {}, undefined, undefined, ctx)
    await vi.advanceTimersByTimeAsync(600_001)
    expect(seen.signal?.aborted).toBe(false)
  })

  it('forwards toolCallId, params, onUpdate and ctx untouched', async () => {
    const calls: unknown[] = []
    const onUpdate = () => undefined
    const tool = withToolBudget(
      fakeTool((id, params, _signal, update, context) => {
        calls.push(id, params, update, context)
        return Promise.resolve(ok('done'))
      }),
      600_000,
    )
    await tool.execute('call-9', { command: 'ls' }, undefined, onUpdate, ctx)
    expect(calls).toEqual(['call-9', { command: 'ls' }, onUpdate, ctx])
  })

  it('kills a call past the budget: aborts the tool and rejects with teaching copy', async () => {
    const seen: { signal?: AbortSignal } = {}
    const tool = withToolBudget(hangingTool(seen), 600_000)
    const result = tool.execute('call-1', {}, undefined, undefined, ctx)
    const failure = expect(result).rejects.toThrow(
      /bash was killed after running past its 10m foreground budget[\s\S]*long-running commands belong in the `background` tool/i,
    )
    await vi.advanceTimersByTimeAsync(600_000)
    await failure
    expect(seen.signal?.aborted).toBe(true)
  })

  it('kills the call, not the turn: the turn signal stays un-aborted', async () => {
    const turn = new AbortController()
    const seen: { signal?: AbortSignal } = {}
    const tool = withToolBudget(hangingTool(seen), 1_000)
    const result = tool.execute('call-1', {}, turn.signal, undefined, ctx)
    const failure = expect(result).rejects.toThrow(/foreground budget/)
    await vi.advanceTimersByTimeAsync(1_000)
    await failure
    expect(turn.signal.aborted).toBe(false)
  })

  it('labels a non-minute budget in seconds', async () => {
    const tool = withToolBudget(hangingTool({}), 90_000)
    const result = tool.execute('call-1', {}, undefined, undefined, ctx)
    const failure = expect(result).rejects.toThrow(/90s foreground budget/)
    await vi.advanceTimersByTimeAsync(90_000)
    await failure
  })

  it('still relays a turn abort (cancel) to the tool, as the tool own error', async () => {
    const turn = new AbortController()
    const seen: { signal?: AbortSignal } = {}
    const tool = withToolBudget(hangingTool(seen), 600_000)
    const result = tool.execute('call-1', {}, turn.signal, undefined, ctx)
    const failure = expect(result).rejects.toThrow('Command aborted')
    turn.abort()
    await failure
    expect(seen.signal?.aborted).toBe(true)
  })

  it('starts aborted when the turn signal is already aborted', async () => {
    const turn = new AbortController()
    turn.abort()
    const seen: { signal?: AbortSignal } = {}
    const tool = withToolBudget(
      fakeTool((_id, _params, signal) => {
        seen.signal = signal
        return Promise.resolve(ok('done'))
      }),
      600_000,
    )
    await tool.execute('call-1', {}, turn.signal, undefined, ctx)
    expect(seen.signal?.aborted).toBe(true)
  })

  it('propagates a tool failure under budget unchanged', async () => {
    const tool = withToolBudget(
      fakeTool(() => Promise.reject(new Error('exit code 1'))),
      600_000,
    )
    await expect(
      tool.execute('call-1', {}, undefined, undefined, ctx),
    ).rejects.toThrow('exit code 1')
  })

  it('wraps a non-Error rejection into an Error', async () => {
    const tool = withToolBudget(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercising the non-Error branch on purpose
      fakeTool(() => Promise.reject('string failure')),
      600_000,
    )
    await expect(
      tool.execute('call-1', {}, undefined, undefined, ctx),
    ).rejects.toThrow('string failure')
  })

  it('keeps the tool metadata (name, schema, prompt copy) intact', () => {
    const base = fakeTool(() => Promise.resolve(ok('done')))
    const tool = withToolBudget(base, 600_000)
    expect(tool.name).toBe(base.name)
    expect(tool.label).toBe(base.label)
    expect(tool.description).toBe(base.description)
    expect(tool.promptSnippet).toBe(base.promptSnippet)
    expect(tool.parameters).toBe(base.parameters)
    // A fresh execute proves the tool was wrapped, not passed through.
    expect(tool.execute === base.execute).toBe(false)
  })
})

describe('withToolBudgets', () => {
  it('wraps every tool except `background` (exempt: it ends the turn by design)', () => {
    const bash = fakeTool(() => Promise.resolve(ok('done')))
    const background = fakeTool(() => Promise.resolve(ok('done')), {
      name: 'background',
    })
    const [wrappedBash, wrappedBackground] = withToolBudgets(
      [bash, background],
      600_000,
    )
    expect(wrappedBash.execute === bash.execute).toBe(false)
    expect(wrappedBackground).toBe(background)
  })
})
