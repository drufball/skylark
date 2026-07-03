import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_OLLAMA_BASE_URL, ollamaApiRoot, ollamaBaseUrl } from './ollama'

afterEach(() => {
  vi.unstubAllEnvs()
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

  it('uses an explicit override verbatim — no /v1 appended to a custom path', () => {
    // A proxy or gateway endpoint may not end in /v1; the override must be
    // returned as typed, not rebuilt from the root with /v1 bolted on.
    expect(ollamaBaseUrl({ OLLAMA_BASE_URL: 'http://proxy.lan/ollama' })).toBe(
      'http://proxy.lan/ollama',
    )
  })

  it('reads the override from process.env by default', () => {
    vi.stubEnv('OLLAMA_BASE_URL', 'http://stubbed.lan/ollama')
    expect(ollamaBaseUrl()).toBe('http://stubbed.lan/ollama')
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
