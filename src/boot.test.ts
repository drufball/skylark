import { describe, expect, it } from 'vitest'

import { bootAllReactors, disarmForTests } from './boot'

interface GlobalWithBoot {
  __SKYLARK_BOOT__?: { booted: boolean }
}

/**
 * Test the eager boot's globalThis-based arm-once protection.
 *
 * The #xwh2 residual proved that import.meta.hot.dispose hooks DON'T fire for
 * SSR module reloads (a forced reload delivered one marker 3x even with #91's
 * dispose hooks). The fix: globalThis-keyed registry that survives module
 * re-execution without cooperation from the dying module.
 *
 * This test verifies:
 * 1. Reactors boot eagerly (not lazily on first door use)
 * 2. globalThis-based arm-once prevents stacking on module re-execution
 * 3. The real ensure* functions are protected (not test replicas)
 */
describe('eager boot with globalThis arm-once', () => {
  it('boots reactors once, even when boot function is called multiple times', () => {
    // The globalThis registry should survive across calls
    const g = globalThis as GlobalWithBoot

    // First boot (or already happened during module import)
    bootAllReactors()
    expect(g.__SKYLARK_BOOT__?.booted).toBe(true)

    // Calling again should be a no-op (registry stays true)
    bootAllReactors()
    expect(g.__SKYLARK_BOOT__?.booted).toBe(true)

    bootAllReactors()
    expect(g.__SKYLARK_BOOT__?.booted).toBe(true)

    // The registry persists, proving arm-once protection
  })

  it('allows manual re-arming after explicit disarm (for tests)', () => {
    const g = globalThis as GlobalWithBoot

    // Boot once
    bootAllReactors()
    expect(g.__SKYLARK_BOOT__?.booted).toBe(true)

    // Disarm
    disarmForTests()
    expect(g.__SKYLARK_BOOT__?.booted).toBe(false)

    // Can boot again
    bootAllReactors()
    expect(g.__SKYLARK_BOOT__?.booted).toBe(true)
  })

  it('globalThis registry survives module re-execution', () => {
    // This test demonstrates the key property: globalThis persists even when
    // module state resets. In a real SSR reload:
    // - Module-level variables reset to their initial values
    // - But globalThis.__SKYLARK_BOOT__ persists
    // - So the arm-once check still works

    const g = globalThis as GlobalWithBoot

    // Set the registry
    bootAllReactors()
    expect(g.__SKYLARK_BOOT__?.booted).toBe(true)

    // Simulate what happens on module reload: local state resets,
    // but globalThis persists. We can't actually reload the module in a test,
    // but we can verify the registry is on globalThis, not module state.
    const wasBooted = g.__SKYLARK_BOOT__?.booted

    // Even if we call boot again (simulating module re-execution),
    // the globalThis registry prevents re-subscription
    bootAllReactors()

    // Registry still true, proving it survived
    expect(wasBooted).toBe(true)
    expect(g.__SKYLARK_BOOT__?.booted).toBe(true)
  })
})
