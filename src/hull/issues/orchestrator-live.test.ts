import { describe, expect, it, beforeEach, afterEach } from 'vitest'

/**
 * Test the issues orchestrator's registry pattern to ensure stale local
 * 'started' never shadows a fresh boot after the registry self-heals.
 *
 * Residual from #2wkv: if an execution restores a promise from the registry
 * and that promise later rejects, the catch handler heals the registry but
 * the RESTORING execution's local 'started' caches the rejection. If the next
 * call is on that execution, the bare 'if (started) return started' check
 * returns the cached rejection forever even though the registry self-healed.
 */
describe('orchestrator-live registry self-healing', () => {
  const REGISTRY_KEY = '__SKYLARK_ISSUES_ORCHESTRATOR__'

  interface Registry {
    armed: boolean
    instance?: Promise<unknown>
  }

  function getRegistry(): Registry {
    const g = globalThis as unknown as Record<string, Registry>
    g[REGISTRY_KEY] ??= { armed: false }
    return g[REGISTRY_KEY]
  }

  function clearRegistry() {
    const g = globalThis as unknown as Record<string, Registry>
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete g[REGISTRY_KEY]
  }

  beforeEach(() => {
    clearRegistry()
  })

  afterEach(() => {
    clearRegistry()
  })

  it('DEMONSTRATES THE PROBLEM: bare started check caches rejection after registry heals', async () => {
    // Simulate TWO SEPARATE module executions with their own local state
    let startedE1: Promise<unknown> | undefined
    let startedE2: Promise<unknown> | undefined

    // E1's ensure function (first module execution)
    function ensureE1(): Promise<unknown> {
      const registry = getRegistry()

      if (registry.armed && registry.instance) {
        startedE1 = registry.instance
        return registry.instance
      }

      // PROBLEM: bare check doesn't verify registry.armed
      if (startedE1) return startedE1

      registry.armed = true
      let bootAttempts = 0
      const promise = (() => {
        bootAttempts++
        if (bootAttempts === 1) {
          return Promise.reject(new Error('Postgres asleep'))
        }
        return Promise.resolve({ mock: 'orchestrator' })
      })()
      startedE1 = promise.catch((err: unknown) => {
        registry.armed = false
        startedE1 = undefined // Clears E1's started but NOT E2's
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete registry.instance
        throw err
      })
      registry.instance = startedE1
      return startedE1
    }

    // E2's ensure function (second module execution after SSR reload)
    function ensureE2(): Promise<unknown> {
      const registry = getRegistry()

      if (registry.armed && registry.instance) {
        startedE2 = registry.instance // E2 caches the promise
        return registry.instance
      }

      // PROBLEM: bare check doesn't verify registry.armed
      if (startedE2) return startedE2 // Returns stale cached rejection

      registry.armed = true
      const promise = Promise.resolve({ mock: 'orchestrator' })
      startedE2 = promise.catch((err: unknown) => {
        registry.armed = false
        startedE2 = undefined
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete registry.instance
        throw err
      })
      registry.instance = startedE2
      return startedE2
    }

    // E1: first call creates boot promise that will reject
    const firstPromise = ensureE1()
    await expect(firstPromise).rejects.toThrow('Postgres asleep')

    // Registry should be healed by E1's catch handler
    const registry1 = getRegistry()
    expect(registry1.armed).toBe(false)
    expect(registry1.instance).toBeUndefined()
    expect(startedE1).toBeUndefined() // E1's started cleared

    // E2: simulate SSR reload - E2 has fresh state, calls ensure for first time
    // Registry is healed but let's put a rejection in E2's cache directly to
    // simulate the race: E2 restored the promise BEFORE it rejected
    startedE2 = firstPromise

    // PROBLEM: E2 calls again, hits bare 'if (startedE2)' check
    // Registry is healed (armed=false) but E2's cache holds rejection
    const secondPromise = ensureE2()
    expect(secondPromise).toBe(firstPromise) // BUG: returns stale rejection
    await expect(secondPromise).rejects.toThrow('Postgres asleep')
  })

  it('WITH FIX: guards started check with registry.armed', async () => {
    let startedE1: Promise<unknown> | undefined
    let startedE2: Promise<unknown> | undefined

    // E1's ensure function with the FIX
    function ensureE1Fixed(): Promise<unknown> {
      const registry = getRegistry()

      if (registry.armed && registry.instance) {
        startedE1 = registry.instance
        return registry.instance
      }

      // FIX: guard with registry.armed
      if (startedE1 && registry.armed) return startedE1

      registry.armed = true
      let bootAttempts = 0
      const promise = (() => {
        bootAttempts++
        if (bootAttempts === 1) {
          return Promise.reject(new Error('Postgres asleep'))
        }
        return Promise.resolve({ mock: 'orchestrator', attempt: bootAttempts })
      })()
      startedE1 = promise.catch((err: unknown) => {
        registry.armed = false
        startedE1 = undefined
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete registry.instance
        throw err
      })
      registry.instance = startedE1
      return startedE1
    }

    // E2's ensure function with the FIX
    function ensureE2Fixed(): Promise<unknown> {
      const registry = getRegistry()

      if (registry.armed && registry.instance) {
        startedE2 = registry.instance
        return registry.instance
      }

      // FIX: guard with registry.armed
      if (startedE2 && registry.armed) return startedE2 // Skips when healed!

      registry.armed = true
      const promise = Promise.resolve({ mock: 'orchestrator', fresh: true })
      startedE2 = promise.catch((err: unknown) => {
        registry.armed = false
        startedE2 = undefined
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete registry.instance
        throw err
      })
      registry.instance = startedE2
      return startedE2
    }

    // E1: first call rejects
    const firstPromise = ensureE1Fixed()
    await expect(firstPromise).rejects.toThrow('Postgres asleep')

    // Registry healed
    expect(getRegistry().armed).toBe(false)
    expect(startedE1).toBeUndefined()

    // E2: simulate E2 had cached the rejection before it failed
    startedE2 = firstPromise

    // FIXED: E2 calls again, the guarded check sees registry.armed is false,
    // skips the stale cache, creates fresh boot
    const secondPromise = ensureE2Fixed()
    expect(secondPromise).not.toBe(firstPromise) // fresh promise!
    await expect(secondPromise).resolves.toMatchObject({ fresh: true })
  })

  it('ALTERNATIVE FIX: delete the bare fallback (registry is single source of truth)', async () => {
    let startedE1: Promise<unknown> | undefined
    let startedE2: Promise<unknown> | undefined

    function ensureE1NoFallback(): Promise<unknown> {
      const registry = getRegistry()

      if (registry.armed && registry.instance) {
        startedE1 = registry.instance
        return registry.instance
      }

      // ALTERNATIVE: no bare fallback at all

      registry.armed = true
      let bootAttempts = 0
      const promise = (() => {
        bootAttempts++
        if (bootAttempts === 1) {
          return Promise.reject(new Error('Postgres asleep'))
        }
        return Promise.resolve({ mock: 'orchestrator', attempt: bootAttempts })
      })()
      startedE1 = promise.catch((err: unknown) => {
        registry.armed = false
        startedE1 = undefined
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete registry.instance
        throw err
      })
      registry.instance = startedE1
      return startedE1
    }

    function ensureE2NoFallback(): Promise<unknown> {
      const registry = getRegistry()

      if (registry.armed && registry.instance) {
        startedE2 = registry.instance
        return registry.instance
      }

      // ALTERNATIVE: no bare fallback

      registry.armed = true
      const promise = Promise.resolve({ mock: 'orchestrator', fresh: true })
      startedE2 = promise.catch((err: unknown) => {
        registry.armed = false
        startedE2 = undefined
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete registry.instance
        throw err
      })
      registry.instance = startedE2
      return startedE2
    }

    // E1: rejects
    await expect(ensureE1NoFallback()).rejects.toThrow('Postgres asleep')
    expect(getRegistry().armed).toBe(false)

    // E2: has stale cache
    startedE2 = Promise.reject(new Error('Postgres asleep'))
    void startedE2.catch(() => {
      // Swallow rejection
    })

    // FIXED: no fallback, so E2 always checks registry first, creates fresh
    const secondPromise = ensureE2NoFallback()
    await expect(secondPromise).resolves.toMatchObject({ fresh: true })
  })

  it('realistic scenario: restore → reject → retry succeeds', async () => {
    let started: Promise<unknown> | undefined
    let bootAttempts = 0

    function ensureOrchestrator(): Promise<unknown> {
      const registry = getRegistry()

      if (registry.armed && registry.instance) {
        started = registry.instance
        return registry.instance
      }

      // Fixed: guard with registry.armed
      if (started && registry.armed) return started

      registry.armed = true

      // Mock boot that fails once then succeeds
      const promise = (() => {
        bootAttempts++
        if (bootAttempts === 1) {
          return Promise.reject(new Error('Postgres asleep'))
        }
        return Promise.resolve({ mock: 'orchestrator', bootAttempts })
      })()

      started = promise.catch((err: unknown) => {
        registry.armed = false
        started = undefined
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete registry.instance
        throw err
      })

      registry.instance = started
      return started
    }

    // First call fails
    await expect(ensureOrchestrator()).rejects.toThrow('Postgres asleep')
    expect(bootAttempts).toBe(1)

    // Registry should be healed
    const registry = getRegistry()
    expect(registry.armed).toBe(false)
    expect(registry.instance).toBeUndefined()
    expect(started).toBeUndefined() // Catch handler cleared it

    // Second call retries and succeeds
    const result = await ensureOrchestrator()
    expect(result).toMatchObject({ mock: 'orchestrator', bootAttempts: 2 })
    expect(bootAttempts).toBe(2)

    // Registry should be armed with the successful instance
    const registry2 = getRegistry()
    expect(registry2.armed).toBe(true)
    expect(registry2.instance).toBeDefined()
  })
})
