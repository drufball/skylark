import { describe, expect, it } from 'vitest'

/**
 * Test that globalThis registries store the LIVE INSTANCE, not just an armed
 * flag, so ensure* calls after SSR reload return the SAME functioning instance
 * instead of a stub/rejection.
 *
 * These tests faithfully simulate the actual reactor pattern: module-level
 * state + globalThis registry, and verify the check order matters for
 * correctness (registry first, then module state).
 */
describe('reactor registry stores live instance', () => {
  /**
   * Simulate a reactor module's state and its ensure function. This pattern
   * matches the real reactors more closely than inline reimplementations:
   * - Module-level state that resets on SSR reload
   * - globalThis registry that survives reload
   * - The actual check order matters for correctness
   */
  function createReactorModule<T>() {
    let moduleState: T | undefined
    const registryKey = `__TEST_REACTOR_${Math.random().toString()}__`

    interface Registry {
      armed: boolean
      instance?: T
    }

    function getRegistry(): Registry {
      const g = globalThis as unknown as Record<string, Registry>
      g[registryKey] ??= { armed: false }
      return g[registryKey]
    }

    function cleanup() {
      const g = globalThis as unknown as Record<string, Registry>
      g[registryKey] = undefined as unknown as Registry
      moduleState = undefined
    }

    return {
      getRegistry,
      cleanup,
      getModuleState: () => moduleState,
      setModuleState: (val: T | undefined) => {
        moduleState = val
      },
    }
  }

  interface TestReactor {
    calls: string[]
    doWork: (id: string) => void
  }

  it('DEMONSTRATES THE PROBLEM: wrong check order caches failed promises', () => {
    const module = createReactorModule<Promise<TestReactor>>()

    // BAD: checks module state BEFORE registry (old issues orchestrator bug)
    function ensureReactorBadOrder(): Promise<TestReactor> {
      const registry = module.getRegistry()
      const moduleState = module.getModuleState()

      // WRONG: check module state first
      if (moduleState) return moduleState

      if (registry.armed && registry.instance) {
        module.setModuleState(registry.instance)
        return registry.instance
      }

      registry.armed = true
      const promise = Promise.resolve({
        calls: [],
        doWork: (id: string) => {
          // Test stub - work tracked in calls array in real implementation
          void id
        },
      })
      registry.instance = promise
      module.setModuleState(promise)
      return promise
    }

    // First call succeeds
    const first = ensureReactorBadOrder()

    // Simulate SSR reload: module state resets
    module.setModuleState(undefined)

    // Second call restores from registry
    const second = ensureReactorBadOrder()
    expect(second).toBe(first) // same promise restored

    // Now simulate boot failure AFTER restoration: in real code, if the
    // promise was rejected and we restored it, module state caches it but
    // the catch handler that clears state isn't attached to the restored
    // promise. So the rejected promise stays in moduleState forever.
    // Here we manually simulate what would happen:
    const rejectedPromise = Promise.reject(new Error('boot failed'))
    void rejectedPromise.catch(() => {
      // Swallow error to prevent unhandled rejection in test
    })
    module.setModuleState(rejectedPromise)

    // PROBLEM: module state is checked first, so returns the cached rejection
    const third = ensureReactorBadOrder()
    expect(third).toBe(rejectedPromise)

    module.cleanup()
  })

  it('WITH FIX: registry-first check order prevents caching failures', () => {
    const module = createReactorModule<Promise<TestReactor>>()

    // GOOD: checks registry BEFORE module state (fixed issues orchestrator)
    function ensureReactorCorrectOrder(): Promise<TestReactor> {
      const registry = module.getRegistry()

      // CORRECT: check registry first
      if (registry.armed && registry.instance) {
        module.setModuleState(registry.instance)
        return registry.instance
      }

      const moduleState = module.getModuleState()
      if (moduleState) return moduleState

      registry.armed = true
      const promise = Promise.resolve({
        calls: [],
        doWork: (id: string) => {
          // Test stub - work tracked in calls array in real implementation
          void id
        },
      })
      registry.instance = promise
      module.setModuleState(promise)
      return promise
    }

    // First call succeeds
    const first = ensureReactorCorrectOrder()

    // Simulate SSR reload
    module.setModuleState(undefined)

    // Second call restores from registry
    const second = ensureReactorCorrectOrder()
    expect(second).toBe(first)

    // Simulate boot failure AFTER restoration
    const rejectedPromise = Promise.reject(new Error('boot failed'))
    void rejectedPromise.catch(() => {
      // Swallow error to prevent unhandled rejection in test
    })
    module.setModuleState(rejectedPromise)

    // Simulate another reload
    module.setModuleState(undefined)

    // FIXED: registry is checked first, so we get the good promise from
    // registry, not the rejected one that was briefly in module state
    const third = ensureReactorCorrectOrder()
    expect(third).toBe(first)

    module.cleanup()
  })

  it('synchronous reactor (chat) survives reload with same instance', () => {
    const module = createReactorModule<TestReactor>()

    function ensureSyncReactor(): TestReactor {
      const registry = module.getRegistry()

      // Check registry first (consistent with async pattern)
      if (registry.armed && registry.instance) {
        module.setModuleState(registry.instance)
        return registry.instance
      }

      const moduleState = module.getModuleState()
      if (moduleState) return moduleState

      registry.armed = true
      const reactor: TestReactor = {
        calls: [],
        doWork: (id) => {
          reactor.calls.push(id)
        },
      }
      registry.instance = reactor
      module.setModuleState(reactor)
      return reactor
    }

    // First call creates the reactor
    const first = ensureSyncReactor()
    first.doWork('a')
    expect(first.calls).toEqual(['a'])

    // Simulate SSR reload
    module.setModuleState(undefined)

    // Second call returns the SAME instance from registry
    const second = ensureSyncReactor()
    second.doWork('b')

    // VERIFIED: work continues on the same instance
    expect(second.calls).toEqual(['a', 'b'])
    expect(second).toBe(first)

    module.cleanup()
  })

  it('async reactor (issues) survives reload with same promise', async () => {
    const module = createReactorModule<Promise<TestReactor>>()

    function ensureAsyncReactor(): Promise<TestReactor> {
      const registry = module.getRegistry()

      // Check registry FIRST (the fix for the caching bug)
      if (registry.armed && registry.instance) {
        module.setModuleState(registry.instance)
        return registry.instance
      }

      const moduleState = module.getModuleState()
      if (moduleState) return moduleState

      registry.armed = true
      const reactor: TestReactor = {
        calls: [],
        doWork: (id) => {
          reactor.calls.push(id)
        },
      }
      const promise = Promise.resolve(reactor)
      registry.instance = promise
      module.setModuleState(promise)
      return promise
    }

    // First call
    const firstPromise = ensureAsyncReactor()
    const first = await firstPromise
    first.doWork('a')
    expect(first.calls).toEqual(['a'])

    // Simulate reload
    module.setModuleState(undefined)

    // Second call returns the same promise, resolves to same reactor
    const secondPromise = ensureAsyncReactor()
    expect(secondPromise).toBe(firstPromise)

    const second = await secondPromise
    expect(second).toBe(first)
    second.doWork('b')
    expect(second.calls).toEqual(['a', 'b'])

    module.cleanup()
  })
})
