import { describe, expect, it, vi } from 'vitest'

import {
  listInstalledModels,
  modelPickerOptions,
  pullModel,
} from './ollama-client'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response
}

describe('listInstalledModels', () => {
  it('maps Ollama /api/tags into name + size, newest API shape', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          models: [
            { name: 'qwen3-coder:30b', size: 19_000_000_000 },
            { name: 'qwen3:0.6b', size: 522_000_000 },
          ],
        }),
      ),
    )
    const models = await listInstalledModels(fetchImpl, {})
    expect(models).toEqual([
      { name: 'qwen3-coder:30b', sizeBytes: 19_000_000_000 },
      { name: 'qwen3:0.6b', sizeBytes: 522_000_000 },
    ])
    // hits the native /api root (not the /v1 OpenAI endpoint)
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags')
  })

  it('returns [] when Ollama reports no models', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({})))
    expect(await listInstalledModels(fetchImpl, {})).toEqual([])
  })

  it('honors the configured Ollama host', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({ models: [] })))
    await listInstalledModels(fetchImpl, { OLLAMA_HOST: 'gpu-box:11434' })
    expect(fetchImpl).toHaveBeenCalledWith('http://gpu-box:11434/api/tags')
  })

  it('throws when the daemon is unreachable / errors', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({}, false, 500)))
    await expect(listInstalledModels(fetchImpl, {})).rejects.toThrow(/500/)
  })
})

describe('pullModel', () => {
  it('POSTs the model to /api/pull', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(jsonResponse({ status: 'success' })),
    )
    await pullModel('qwen3:8b', fetchImpl, {})
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/api/pull',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3:8b', stream: false }),
      }),
    )
  })

  it('throws on a failed pull', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(jsonResponse({}, false, 404)))
    await expect(pullModel('nope:1b', fetchImpl, {})).rejects.toThrow(/404/)
  })
})

describe('modelPickerOptions', () => {
  it('lists the default first, then installed local models as refs', () => {
    expect(
      modelPickerOptions('ollama/qwen3:8b', [
        { name: 'qwen3:8b', sizeBytes: 1 },
        { name: 'qwen3-coder:30b', sizeBytes: 2 },
      ]),
    ).toEqual(['ollama/qwen3:8b', 'ollama/qwen3-coder:30b'])
  })

  it('keeps a hosted default and dedups it from the installed set', () => {
    expect(
      modelPickerOptions('anthropic/claude-sonnet-4-5', [
        { name: 'qwen3:8b', sizeBytes: 1 },
      ]),
    ).toEqual(['anthropic/claude-sonnet-4-5', 'ollama/qwen3:8b'])
  })
})
