import { describe, expect, it } from 'vitest'

import {
  HOSTED_PROVIDERS,
  isHostedProvider,
  providersWithStatus,
} from './providers'

describe('HOSTED_PROVIDERS', () => {
  it('covers the providers a crew member can add a key for', () => {
    const ids = HOSTED_PROVIDERS.map((p) => p.id)
    expect(ids).toEqual(['anthropic', 'openai', 'google', 'openrouter'])
  })

  it('does not include ollama (local needs no key)', () => {
    expect(isHostedProvider('ollama')).toBe(false)
    expect(isHostedProvider('anthropic')).toBe(true)
  })
})

describe('providersWithStatus', () => {
  it('marks each provider configured per the injected predicate', () => {
    const statuses = providersWithStatus((id) => id === 'anthropic')
    const byId = Object.fromEntries(statuses.map((s) => [s.id, s.configured]))
    expect(byId).toEqual({
      anthropic: true,
      openai: false,
      google: false,
      openrouter: false,
    })
  })

  it('preserves the provider metadata (label, console url)', () => {
    const anthropic = providersWithStatus(() => false).find(
      (p) => p.id === 'anthropic',
    )
    expect(anthropic?.label).toContain('Anthropic')
    expect(anthropic?.consoleUrl).toMatch(/^https:\/\//)
  })
})
