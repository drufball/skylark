import { afterEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_DEFAULT_MODEL, PREFERRED_CHAT_MODEL } from './models'

// The live CHAT_MODEL wiring: chatModelRef's preference order is pure-tested in
// models.test.ts; what's pinned here is the boot-time seam runtime.ts adds on
// top — the AuthStorage probe detects a configured provider, and an auth-store
// failure degrades to the local default instead of crashing module init. Each
// case re-imports runtime.ts fresh with AuthStorage mocked, since CHAT_MODEL is
// resolved once at import.

/** Import a fresh runtime.ts with `getAuthStatus` behaving as given. */
async function chatModelWith(
  getAuthStatus: (provider: string) => { configured: boolean },
): Promise<string> {
  vi.resetModules()
  vi.doMock('@earendil-works/pi-coding-agent', async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@earendil-works/pi-coding-agent')
    >()),
    AuthStorage: { create: () => ({ getAuthStatus }) },
  }))
  const { CHAT_MODEL } = await import('./runtime')
  return CHAT_MODEL
}

describe('CHAT_MODEL boot wiring', () => {
  afterEach(() => {
    vi.doUnmock('@earendil-works/pi-coding-agent')
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('boots on the preferred model when the auth store has its provider key', async () => {
    vi.stubEnv('SKYLARK_CHAT_MODEL', '')
    const model = await chatModelWith((provider) => ({
      configured: provider === 'anthropic',
    }))
    expect(model).toBe(PREFERRED_CHAT_MODEL)
  })

  it('boots on the local default when no provider is configured', async () => {
    vi.stubEnv('SKYLARK_CHAT_MODEL', '')
    vi.stubEnv('SKYLARK_DEFAULT_MODEL', '')
    const model = await chatModelWith(() => ({ configured: false }))
    expect(model).toBe(FALLBACK_DEFAULT_MODEL)
  })

  it('degrades to the local default when the auth store throws (never crashes boot)', async () => {
    vi.stubEnv('SKYLARK_CHAT_MODEL', '')
    vi.stubEnv('SKYLARK_DEFAULT_MODEL', '')
    const model = await chatModelWith(() => {
      throw new Error('corrupt credential store')
    })
    expect(model).toBe(FALLBACK_DEFAULT_MODEL)
  })
})
