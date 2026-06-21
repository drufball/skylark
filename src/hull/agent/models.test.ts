import { getModels } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_OLLAMA_BASE_URL,
  findAnthropicModel,
  ollamaBaseUrl,
  parseModelRef,
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

describe('ollamaBaseUrl', () => {
  it('defaults to the loopback Ollama OpenAI endpoint', () => {
    expect(ollamaBaseUrl({})).toBe('http://127.0.0.1:11434/v1')
    expect(DEFAULT_OLLAMA_BASE_URL).toBe('http://127.0.0.1:11434/v1')
  })

  it('honors an explicit OLLAMA_BASE_URL, trimming whitespace', () => {
    expect(
      ollamaBaseUrl({ OLLAMA_BASE_URL: '  http://gpu-box:1234/v1  ' }),
    ).toBe('http://gpu-box:1234/v1')
  })

  it('normalizes a bare host[:port] OLLAMA_HOST into an http /v1 url', () => {
    expect(ollamaBaseUrl({ OLLAMA_HOST: '  10.0.0.5:11434  ' })).toBe(
      'http://10.0.0.5:11434/v1',
    )
  })

  it('keeps an http(s) scheme already on OLLAMA_HOST', () => {
    expect(ollamaBaseUrl({ OLLAMA_HOST: 'http://box:11434' })).toBe(
      'http://box:11434/v1',
    )
    expect(ollamaBaseUrl({ OLLAMA_HOST: 'https://ollama.lan' })).toBe(
      'https://ollama.lan/v1',
    )
  })

  it('strips all trailing slashes before appending /v1', () => {
    expect(ollamaBaseUrl({ OLLAMA_HOST: 'https://ollama.lan//' })).toBe(
      'https://ollama.lan/v1',
    )
  })

  it('prefers OLLAMA_BASE_URL over OLLAMA_HOST', () => {
    expect(
      ollamaBaseUrl({
        OLLAMA_BASE_URL: 'http://explicit/v1',
        OLLAMA_HOST: '10.0.0.5:11434',
      }),
    ).toBe('http://explicit/v1')
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

  it('ignores a non-positive or junk context-window override', () => {
    const model = resolveModel('ollama/qwen3:8b', {
      OLLAMA_CONTEXT_WINDOW: 'lots',
    })
    expect(model.contextWindow).toBe(32768)
  })

  it('throws on an unknown Anthropic model', () => {
    expect(() => resolveModel('anthropic/not-a-real-model')).toThrow(
      /unknown anthropic model/i,
    )
  })

  it('throws on an unknown provider', () => {
    expect(() => resolveModel('weirdprovider/foo')).toThrow(/provider/i)
  })
})

describe('findAnthropicModel', () => {
  it('returns the first candidate id that exists, in order', () => {
    const known = getModels('anthropic')[0]
    expect(findAnthropicModel(['not-real', known.id])).toEqual(known)
  })

  it('returns undefined when no candidate matches (tolerant callers degrade)', () => {
    expect(findAnthropicModel(['nope', 'also-nope'])).toBeUndefined()
    expect(findAnthropicModel([])).toBeUndefined()
  })
})
