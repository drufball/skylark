import { describe, expect, it } from 'vitest'

import type { SessionToolsProvider } from '@hull/agent/runtime'

import { combineSessionTools } from './orchestrator-live'

// This file only tests `combineSessionTools` — the one bit of real decision
// logic in orchestrator-live.ts. Everything else in the file is the v8-ignored
// live wiring shell (real bus subscription, real pi runtime); see the
// `/* v8 ignore start */` comment there and STRYKER_ONLY_EXCLUDES in
// test-excludes.mjs.

function provider(tools: string[]): SessionToolsProvider {
  return () => Promise.resolve(tools as never)
}

describe('combineSessionTools', () => {
  it('concatenates what every provider contributes for a session', async () => {
    const combined = combineSessionTools([
      provider(['a', 'b']),
      provider(['c']),
    ])
    const result = await combined({
      sessionId: 's',
      agentUserId: 'u',
      cwd: '/repo',
    })
    expect(result).toEqual(['a', 'b', 'c'])
  })

  it('is empty when every provider is', async () => {
    const combined = combineSessionTools([provider([]), provider([])])
    const result = await combined({
      sessionId: 's',
      agentUserId: null,
      cwd: '/repo',
    })
    expect(result).toEqual([])
  })
})
