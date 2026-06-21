import { getModels } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_OLLAMA_BASE_URL,
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

  it('rejects an empty provider or model id', () => {
    expect(() => parseModelRef('')).toThrow()
    expect(() => parseModelRef('ollama/')).toThrow()
    expect(() => parseModelRef('/qwen3:8b')).toThrow()
  })
})

describe('ollamaBaseUrl', () => {
  it('defaults to the local Ollama OpenAI endpoint', () => {
    expect(ollamaBaseUrl({})).toBe(DEFAULT_OLLAMA_BASE_URL)
  })

  it('honors an explicit OLLAMA_BASE_URL', () => {
    expect(ollamaBaseUrl({ OLLAMA_BASE_URL: 'http://gpu-box:1234/v1' })).toBe(
      'http://gpu-box:1234/v1',
    )
  })

  it('normalizes OLLAMA_HOST (Ollama’s own env) into an OpenAI /v1 url', () => {
    expect(ollamaBaseUrl({ OLLAMA_HOST: '10.0.0.5:11434' })).toBe(
      'http://10.0.0.5:11434/v1',
    )
    expect(ollamaBaseUrl({ OLLAMA_HOST: 'https://ollama.lan/' })).toBe(
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
    expect(model.provider).toBe('ollama')
    expect(model.api).toBe('openai-completions')
    expect(model.id).toBe('qwen3-coder:30b')
    expect(model.baseUrl).toBe(DEFAULT_OLLAMA_BASE_URL)
    // Local inference is free — cost stays zero so usage accounting never bills.
    expect(model.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('points the Ollama model at the configured endpoint', () => {
    const model = resolveModel('ollama/qwen3:8b', {
      OLLAMA_BASE_URL: 'http://gpu-box:1234/v1',
    })
    expect(model.baseUrl).toBe('http://gpu-box:1234/v1')
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
