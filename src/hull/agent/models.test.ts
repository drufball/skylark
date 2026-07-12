import { describe, expect, it } from 'vitest'

import {
  defaultModelRef,
  FALLBACK_DEFAULT_MODEL,
  gatewayApiKey,
  gatewayBaseUrl,
  gatewayUiUrl,
  parseGatewayModels,
  resolveModel,
} from './models'

describe('defaultModelRef', () => {
  it('falls back to the strong hosted default when unset', () => {
    expect(defaultModelRef({})).toBe(FALLBACK_DEFAULT_MODEL)
    expect(FALLBACK_DEFAULT_MODEL).toBe('claude-sonnet-5')
  })

  it('honors SKYLARK_DEFAULT_MODEL', () => {
    expect(defaultModelRef({ SKYLARK_DEFAULT_MODEL: 'claude-haiku-4-5' })).toBe(
      'claude-haiku-4-5',
    )
  })

  it('trims the override and falls back when it is blank', () => {
    expect(defaultModelRef({ SKYLARK_DEFAULT_MODEL: '  gpt-5  ' })).toBe(
      'gpt-5',
    )
    expect(defaultModelRef({ SKYLARK_DEFAULT_MODEL: '   ' })).toBe(
      FALLBACK_DEFAULT_MODEL,
    )
  })
})

describe('gatewayBaseUrl', () => {
  it('defaults to the local LiteLLM proxy', () => {
    expect(gatewayBaseUrl({})).toBe('http://localhost:4000/v1')
  })

  it('honors SKYLARK_GATEWAY_URL, normalizing to a /v1 endpoint', () => {
    expect(gatewayBaseUrl({ SKYLARK_GATEWAY_URL: 'http://box:9000' })).toBe(
      'http://box:9000/v1',
    )
    expect(gatewayBaseUrl({ SKYLARK_GATEWAY_URL: 'http://box:9000/' })).toBe(
      'http://box:9000/v1',
    )
    // An explicit /v1 isn't doubled.
    expect(gatewayBaseUrl({ SKYLARK_GATEWAY_URL: 'http://box:9000/v1' })).toBe(
      'http://box:9000/v1',
    )
  })

  it('treats a blank override as unset', () => {
    expect(gatewayBaseUrl({ SKYLARK_GATEWAY_URL: '   ' })).toBe(
      'http://localhost:4000/v1',
    )
  })
})

describe('gatewayUiUrl', () => {
  it('defaults to the local gateway admin UI', () => {
    expect(gatewayUiUrl({})).toBe('http://localhost:4000/ui')
  })

  it('derives from SKYLARK_GATEWAY_URL, with or without its /v1 suffix', () => {
    expect(gatewayUiUrl({ SKYLARK_GATEWAY_URL: 'http://box:9000' })).toBe(
      'http://box:9000/ui',
    )
    expect(gatewayUiUrl({ SKYLARK_GATEWAY_URL: 'http://box:9000/v1' })).toBe(
      'http://box:9000/ui',
    )
  })

  it('honors SKYLARK_GATEWAY_UI_URL verbatim — a tunnel hostname differs from the local one', () => {
    expect(
      gatewayUiUrl({
        SKYLARK_GATEWAY_UI_URL: 'https://llm.example.com/ui',
        SKYLARK_GATEWAY_URL: 'http://box:9000',
      }),
    ).toBe('https://llm.example.com/ui')
  })

  it('treats a blank override as unset', () => {
    expect(gatewayUiUrl({ SKYLARK_GATEWAY_UI_URL: '  ' })).toBe(
      'http://localhost:4000/ui',
    )
  })
})

describe('gatewayApiKey', () => {
  it('uses the LiteLLM master key when set', () => {
    expect(gatewayApiKey({ LITELLM_MASTER_KEY: 'sk-1234' })).toBe('sk-1234')
  })

  it('falls back to the compose default so app and gateway agree by construction', () => {
    expect(gatewayApiKey({})).toBe('sk-litellm')
    expect(gatewayApiKey({ LITELLM_MASTER_KEY: '  ' })).toBe('sk-litellm')
  })
})

describe('resolveModel', () => {
  it('builds an OpenAI-compatible model pointed at the gateway', () => {
    const model = resolveModel('claude-sonnet-5', {})
    expect(model).toEqual({
      id: 'claude-sonnet-5',
      name: 'claude-sonnet-5',
      api: 'openai-completions',
      provider: 'litellm',
      baseUrl: 'http://localhost:4000/v1',
      reasoning: false,
      input: ['text'],
      // The gateway does the per-provider accounting; the app never bills.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 32768,
      // OpenAI-platform-only features the gateway's providers may not
      // implement, off so they don't break requests or tool calls.
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
      },
    })
  })

  it('passes the ref through verbatim — the gateway config owns model names', () => {
    // Legacy refs stored before the gateway ("anthropic/claude-sonnet-4-5")
    // keep working through the config's anthropic/* wildcard route.
    const model = resolveModel('anthropic/claude-sonnet-4-5', {})
    expect(model.id).toBe('anthropic/claude-sonnet-4-5')
  })

  it('points at the configured gateway', () => {
    const model = resolveModel('claude-sonnet-5', {
      SKYLARK_GATEWAY_URL: 'http://gpu-box:4000',
    })
    expect(model.baseUrl).toBe('http://gpu-box:4000/v1')
  })

  it('lets the context window be overridden (it drives compaction)', () => {
    const model = resolveModel('claude-sonnet-5', {
      SKYLARK_MODEL_CONTEXT_WINDOW: '32768',
      SKYLARK_MODEL_MAX_TOKENS: '8192',
    })
    expect(model.contextWindow).toBe(32768)
    expect(model.maxTokens).toBe(8192)
  })

  it('ignores a junk, zero, or negative window override', () => {
    for (const bad of ['lots', '0', '-5']) {
      expect(
        resolveModel('claude-sonnet-5', { SKYLARK_MODEL_CONTEXT_WINDOW: bad })
          .contextWindow,
      ).toBe(200000)
    }
  })

  it('rejects an empty id', () => {
    expect(() => resolveModel('', {})).toThrow(/empty/i)
    expect(() => resolveModel('   ', {})).toThrow(/empty/i)
  })
})

describe('parseGatewayModels', () => {
  it('reads model ids from a /v1/models response', () => {
    expect(
      parseGatewayModels({
        data: [{ id: 'claude-sonnet-5' }, { id: 'claude-haiku-4-5' }],
      }),
    ).toEqual(['claude-sonnet-5', 'claude-haiku-4-5'])
  })

  it('drops malformed entries and tolerates junk payloads', () => {
    expect(
      parseGatewayModels({ data: [{ id: 'ok' }, { id: 7 }, 'junk', null] }),
    ).toEqual(['ok'])
    expect(parseGatewayModels(null)).toEqual([])
    expect(parseGatewayModels('nope')).toEqual([])
    expect(parseGatewayModels({ data: 'nope' })).toEqual([])
  })
})
