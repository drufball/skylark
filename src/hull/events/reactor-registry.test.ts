import { describe, expect, it, beforeEach } from 'vitest'

/**
 * Test that globalThis registries store the LIVE INSTANCE, not just an armed
 * flag, so ensure* calls after SSR reload return the SAME functioning instance
 * instead of a stub/rejection.
 *
 * Background: when registry.armed is true but module-level state was reset by
 * an SSR reload, the current implementation has three inconsistent behaviors:
 * - chat: returns a do-nothing stub
 * - issues: returns a rejected promise
 * - notifications: bare return (void)
 *
 * The problem: if a future caller actually uses the returned orchestrator
 * post-reload, they get silently black-holed messages/wakes. "Arm-once" must
 * mean "one armed instance shared across module executions", not "first
 * execution wins, everyone else gets a dummy".
 */
describe('reactor registry stores live instance', () => {
  // Simulate a reactor with its globalThis registry
  interface TestReactor {
    calls: string[]
    doWork: (id: string) => void
  }

  interface GlobalWithTestReactor {
    __TEST_REACTOR__?: {
      armed: boolean
      instance?: TestReactor
    }
  }

  function getRegistry(): { armed: boolean; instance?: TestReactor } {
    const g = globalThis as GlobalWithTestReactor
    g.__TEST_REACTOR__ ??= { armed: false }
    return g.__TEST_REACTOR__
  }

  beforeEach(() => {
    // Clear the registry between tests
    const g = globalThis as GlobalWithTestReactor
    delete g.__TEST_REACTOR__
  })

  it('DEMONSTRATES THE PROBLEM: armed-but-lost returns a stub', () => {
    let moduleState: TestReactor | undefined

    // First implementation: returns a stub when armed but module state lost
    function ensureReactorStub(): TestReactor {
      const registry = getRegistry()
      if (moduleState) return moduleState

      if (registry.armed) {
        // Module state lost but registry says armed → return stub
        return {
          calls: [],
          // eslint-disable-next-line @typescript-eslint/no-empty-function
          doWork: () => {}, // no-op
        }
      }

      registry.armed = true
      const reactor: TestReactor = {
        calls: [],
        doWork: (id) => {
          reactor.calls.push(id)
        },
      }
      moduleState = reactor
      return reactor
    }

    // First call: creates and arms the reactor
    const first = ensureReactorStub()
    first.doWork('a')
    expect(first.calls).toEqual(['a'])

    // Simulate SSR reload: module state resets but registry persists
    moduleState = undefined

    // Second call: returns a stub because armed-but-lost
    const second = ensureReactorStub()
    second.doWork('b')

    // PROBLEM: the stub silently drops work
    expect(second.calls).toEqual([])
    // The live instance and stub are different objects
    expect(second).not.toBe(first)
  })

  it('WITH FIX: armed-but-lost returns the same live instance', () => {
    let moduleState: TestReactor | undefined

    // Fixed implementation: stores instance in registry, returns it on reload
    function ensureReactorFixed(): TestReactor {
      const registry = getRegistry()

      // If we have module state, return it
      if (moduleState) return moduleState

      // If armed but module state lost, return the stored instance
      if (registry.armed && registry.instance) {
        moduleState = registry.instance
        return registry.instance
      }

      // First time: create, store in both places
      registry.armed = true
      const reactor: TestReactor = {
        calls: [],
        doWork: (id) => {
          reactor.calls.push(id)
        },
      }
      registry.instance = reactor
      moduleState = reactor
      return reactor
    }

    // First call: creates and arms the reactor
    const first = ensureReactorFixed()
    first.doWork('a')
    expect(first.calls).toEqual(['a'])

    // Simulate SSR reload: module state resets but registry persists
    moduleState = undefined

    // Second call: returns the SAME live instance from the registry
    const second = ensureReactorFixed()
    second.doWork('b')

    // FIXED: work continues on the same instance
    expect(second.calls).toEqual(['a', 'b'])
    // The instances are the SAME object
    expect(second).toBe(first)
  })

  it('WITH FIX: issues orchestrator promise survives reload', async () => {
    let moduleState: Promise<TestReactor> | undefined

    interface RegistryWithPromise {
      armed: boolean
      instance?: Promise<TestReactor>
    }

    function getPromiseRegistry(): RegistryWithPromise {
      const g = globalThis as { __TEST_ASYNC_REACTOR__?: RegistryWithPromise }
      g.__TEST_ASYNC_REACTOR__ ??= { armed: false }
      return g.__TEST_ASYNC_REACTOR__
    }

    async function ensureAsyncReactor(): Promise<TestReactor> {
      const registry = getPromiseRegistry()

      // If we have module state, return it
      if (moduleState) return moduleState

      // If armed but module state lost, return the stored promise
      if (registry.armed && registry.instance) {
        moduleState = registry.instance
        return registry.instance
      }

      // First boot: create the promise, store it
      registry.armed = true
      const reactor: TestReactor = {
        calls: [],
        doWork: (id) => {
          reactor.calls.push(id)
        },
      }
      const promise = Promise.resolve(reactor)
      registry.instance = promise
      moduleState = promise
      return promise
    }

    // First call
    const first = await ensureAsyncReactor()
    first.doWork('a')

    // Simulate reload
    moduleState = undefined

    // Second call returns the same promise, not a rejection
    const second = await ensureAsyncReactor()
    expect(second).toBe(first)

    // Clean up this test's registry
    delete (globalThis as { __TEST_ASYNC_REACTOR__?: RegistryWithPromise })
      .__TEST_ASYNC_REACTOR__
  })
})
