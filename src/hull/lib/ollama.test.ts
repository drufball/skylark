import { describe, expect, it } from 'vitest'

import { DEFAULT_OLLAMA_BASE_URL, ollamaApiRoot, ollamaBaseUrl } from './ollama'

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

  it('strips trailing slashes on OLLAMA_HOST before appending /v1', () => {
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

describe('ollamaApiRoot', () => {
  it('defaults to the loopback root (no /v1) for the native /api endpoints', () => {
    expect(ollamaApiRoot({})).toBe('http://127.0.0.1:11434')
  })

  it('strips /v1 from an explicit OLLAMA_BASE_URL', () => {
    expect(ollamaApiRoot({ OLLAMA_BASE_URL: 'http://gpu-box:1234/v1' })).toBe(
      'http://gpu-box:1234',
    )
    // trailing slash after /v1 too
    expect(ollamaApiRoot({ OLLAMA_BASE_URL: 'http://gpu-box:1234/v1/' })).toBe(
      'http://gpu-box:1234',
    )
  })

  it('normalizes OLLAMA_HOST into a root url with no path', () => {
    expect(ollamaApiRoot({ OLLAMA_HOST: '10.0.0.5:11434' })).toBe(
      'http://10.0.0.5:11434',
    )
    expect(ollamaApiRoot({ OLLAMA_HOST: 'https://ollama.lan/' })).toBe(
      'https://ollama.lan',
    )
  })

  it('prefers OLLAMA_BASE_URL over OLLAMA_HOST', () => {
    expect(
      ollamaApiRoot({
        OLLAMA_BASE_URL: 'http://explicit/v1',
        OLLAMA_HOST: '10.0.0.5:11434',
      }),
    ).toBe('http://explicit')
  })
})
