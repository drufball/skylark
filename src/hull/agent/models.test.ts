import { getModels } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'

import {
  chatModelRef,
  providerConfigured,
  providerEnvKey,
  defaultModelRef,
  FALLBACK_DEFAULT_MODEL,
  findHostedModel,
  parseModelRef,
  PREFERRED_CHAT_MODEL,
  resolveModel,
} from './models'

describe('parseModelRef', () => {
  it('treats a bare id as an Anthropic model (back-compat)', () => {
    // Stored sessions/profiles predate provider prefixes: "claude-sonnet-4-5".
    expect(parseModelRef('claude-sonnet-4-5')).toEqual({
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    })
  })

  it('trims surrounding whitespace', () => {
    expect(parseModelRef('  ollama/qwen3:8b  ')).toEqual({
      provider: 'ollama',
      modelId: 'qwen3:8b',
    })
  })

  it('splits provider/model on the first slash, keeping ollama tags intact', () => {
    // Ollama tags carry a colon (qwen3-coder:30b) but never a slash.
    expect(parseModelRef('ollama/qwen3-coder:30b')).toEqual({
      provider: 'ollama',
      modelId: 'qwen3-coder:30b',
    })
  })

  it('keeps later slashes in the model id (e.g. openrouter slugs)', () => {
    expect(parseModelRef('openrouter/qwen/qwen3-coder')).toEqual({
      provider: 'openrouter',
      modelId: 'qwen/qwen3-coder',
    })
  })

  it('rejects an empty id', () => {
    expect(() => parseModelRef('')).toThrow(/empty/i)
    expect(() => parseModelRef('   ')).toThrow(/empty/i)
  })

  it('rejects a malformed ref with an empty provider or model id', () => {
    expect(() => parseModelRef('ollama/')).toThrow(/malformed/i)
    expect(() => parseModelRef('/qwen3:8b')).toThrow(/malformed/i)
  })
})

describe('resolveModel', () => {
  it('resolves an Anthropic model from pi-ai, with or without the prefix', () => {
    const known = getModels('anthropic')[0]
    expect(resolveModel(known.id)).toEqual(known)
    expect(resolveModel(`anthropic/${known.id}`)).toEqual(known)
  })

  it('builds an Ollama model as an OpenAI-compatible, zero-cost local model', () => {
    const model = resolveModel('ollama/qwen3-coder:30b', {})
    expect(model).toEqual({
      id: 'qwen3-coder:30b',
      name: 'qwen3-coder:30b',
      api: 'openai-completions',
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      reasoning: false,
      input: ['text'],
      // Local inference is free — zero cost so usage accounting never bills.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 8192,
      // OpenAI-platform-only features Ollama doesn't implement, off so they
      // don't break requests or tool calls.
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
      },
    })
  })

  it('points the Ollama model at the configured endpoint', () => {
    const model = resolveModel('ollama/qwen3:8b', {
      OLLAMA_BASE_URL: 'http://gpu-box:1234/v1',
    })
    expect(model.baseUrl).toBe('http://gpu-box:1234/v1')
  })

  it('lets the Ollama context window be overridden (it drives compaction)', () => {
    const model = resolveModel('ollama/qwen3-coder:30b', {
      OLLAMA_CONTEXT_WINDOW: '131072',
      OLLAMA_MAX_TOKENS: '16384',
    })
    expect(model.contextWindow).toBe(131072)
    expect(model.maxTokens).toBe(16384)
  })

  it('trims whitespace around a context-window override', () => {
    const model = resolveModel('ollama/qwen3:8b', {
      OLLAMA_CONTEXT_WINDOW: '  65536  ',
    })
    expect(model.contextWindow).toBe(65536)
  })

  it('ignores a junk, zero, or negative context-window override', () => {
    expect(
      resolveModel('ollama/qwen3:8b', { OLLAMA_CONTEXT_WINDOW: 'lots' })
        .contextWindow,
    ).toBe(32768)
    expect(
      resolveModel('ollama/qwen3:8b', { OLLAMA_CONTEXT_WINDOW: '0' })
        .contextWindow,
    ).toBe(32768)
    expect(
      resolveModel('ollama/qwen3:8b', { OLLAMA_CONTEXT_WINDOW: '-5' })
        .contextWindow,
    ).toBe(32768)
  })

  it('resolves models from other hosted providers (OpenAI, Google) by prefix', () => {
    const openai = getModels('openai')[0]
    expect(resolveModel(`openai/${openai.id}`)).toEqual(openai)
    const google = getModels('google')[0]
    expect(resolveModel(`google/${google.id}`)).toEqual(google)
  })

  it('throws on an unknown model for a known provider', () => {
    expect(() => resolveModel('anthropic/not-a-real-model')).toThrow(
      /unknown anthropic model/i,
    )
  })

  it('throws on an unknown provider, naming what was typed', () => {
    expect(() => resolveModel('weirdprovider/foo')).toThrow(/provider/i)
    // The error keeps the original ref so a bad SKYLARK_DEFAULT_MODEL is debuggable.
    expect(() => resolveModel('weirdprovider/foo')).toThrow(
      /weirdprovider\/foo/,
    )
  })
})

describe('defaultModelRef', () => {
  it('falls back to a broadly-runnable local model when unset (local-first)', () => {
    expect(defaultModelRef({})).toBe(FALLBACK_DEFAULT_MODEL)
    expect(FALLBACK_DEFAULT_MODEL.startsWith('ollama/')).toBe(true)
  })

  it('honors SKYLARK_DEFAULT_MODEL (what hoist writes after selection)', () => {
    expect(
      defaultModelRef({ SKYLARK_DEFAULT_MODEL: 'ollama/qwen3-coder:30b' }),
    ).toBe('ollama/qwen3-coder:30b')
  })

  it('lets a crew member opt into a hosted model as their default', () => {
    expect(
      defaultModelRef({
        SKYLARK_DEFAULT_MODEL: '  anthropic/claude-sonnet-4-5  ',
      }),
    ).toBe('anthropic/claude-sonnet-4-5')
  })

  it('falls back when the override is blank', () => {
    expect(defaultModelRef({ SKYLARK_DEFAULT_MODEL: '   ' })).toBe(
      FALLBACK_DEFAULT_MODEL,
    )
  })
})

describe('providerConfigured', () => {
  it('trusts the credential store when it says yes', () => {
    expect(providerConfigured(() => true, 'anthropic', {})).toBe(true)
  })

  it("counts the conventional env key when the store says no — the '.env' promise", () => {
    expect(
      providerConfigured(() => false, 'anthropic', {
        ANTHROPIC_API_KEY: 'sk-test',
      }),
    ).toBe(true)
  })

  it('a broken credential store degrades to the env check, never throws', () => {
    const broken = () => {
      throw new Error('keychain locked')
    }
    expect(
      providerConfigured(broken, 'anthropic', { ANTHROPIC_API_KEY: 'sk-x' }),
    ).toBe(true)
    expect(providerConfigured(broken, 'anthropic', {})).toBe(false)
  })

  it('no store entry, no env key, blank env key: not configured', () => {
    expect(providerConfigured(() => false, 'anthropic', {})).toBe(false)
    expect(
      providerConfigured(() => false, 'anthropic', { ANTHROPIC_API_KEY: ' ' }),
    ).toBe(false)
  })

  it('maps the provider to its conventional env var name', () => {
    expect(providerEnvKey('anthropic')).toBe('ANTHROPIC_API_KEY')
    expect(providerEnvKey('z-ai')).toBe('Z_AI_API_KEY')
  })
})

describe('chatModelRef', () => {
  const anthropicConfigured = (provider: string) => provider === 'anthropic'
  const nothingConfigured = () => false

  it('prefers the strong hosted model when its provider has a key', () => {
    expect(chatModelRef(anthropicConfigured, {})).toBe(PREFERRED_CHAT_MODEL)
  })

  it('resolves against the pi-ai registry (the preferred model must exist)', () => {
    expect(() => resolveModel(PREFERRED_CHAT_MODEL)).not.toThrow()
  })

  it('falls back to the ship default when no key is configured (local-first)', () => {
    expect(chatModelRef(nothingConfigured, {})).toBe(FALLBACK_DEFAULT_MODEL)
    expect(
      chatModelRef(nothingConfigured, {
        SKYLARK_DEFAULT_MODEL: 'ollama/qwen3-coder:30b',
      }),
    ).toBe('ollama/qwen3-coder:30b')
  })

  it('honors SKYLARK_CHAT_MODEL above everything', () => {
    expect(
      chatModelRef(anthropicConfigured, {
        SKYLARK_CHAT_MODEL: 'anthropic/claude-sonnet-4-6',
      }),
    ).toBe('anthropic/claude-sonnet-4-6')
    // Even with no key configured — an explicit choice is the crew's to make.
    expect(
      chatModelRef(nothingConfigured, {
        SKYLARK_CHAT_MODEL: 'ollama/qwen3:8b',
      }),
    ).toBe('ollama/qwen3:8b')
  })

  it('treats a blank SKYLARK_CHAT_MODEL as unset', () => {
    expect(
      chatModelRef(anthropicConfigured, { SKYLARK_CHAT_MODEL: '   ' }),
    ).toBe(PREFERRED_CHAT_MODEL)
  })
})

describe('findHostedModel', () => {
  it('returns the first candidate id that exists, in order', () => {
    const known = getModels('anthropic')[0]
    expect(findHostedModel('anthropic', ['not-real', known.id])).toEqual(known)
  })

  it('returns undefined when no candidate matches (tolerant callers degrade)', () => {
    expect(findHostedModel('anthropic', ['nope', 'also-nope'])).toBeUndefined()
    expect(findHostedModel('anthropic', [])).toBeUndefined()
  })

  it('returns undefined for an unknown provider', () => {
    expect(findHostedModel('weirdprovider', ['anything'])).toBeUndefined()
  })
})
