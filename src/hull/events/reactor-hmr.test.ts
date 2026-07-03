import { describe, expect, it } from 'vitest'

import { InProcessBus, type ShipLogReactor } from './bus'

/**
 * Test demonstrating the reactor stacking problem on HMR reload and the fix.
 *
 * When Vite does hot module reload, a reactor's module re-executes with fresh
 * state, but the old subscriptions persist in the InProcessBus (which lives in
 * a different module that may not reload). So one reload → 2x subscriptions,
 * two reloads → 3x, and one published event → N deliveries to the same reactor.
 *
 * The same problem applies to delivery hook arrays: if chat/orchestrator-live.ts
 * reloads but notifications/live.ts doesn't, the deliveryHooks array persists
 * and accumulates hooks on each reload.
 */
describe('reactor HMR stacking', () => {
  /** Wait for the microtask queue so handler rejections settle. */
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  const reactor = (over: Partial<ShipLogReactor> = {}): ShipLogReactor => ({
    handleBusNote: () => Promise.resolve(),
    reconcile: () => Promise.resolve(),
    ...over,
  })

  it('delivers one event to a reactor once when not reloaded', async () => {
    const bus = new InProcessBus()
    const seen: string[] = []

    // Subscribe to this bus (not the global one)
    bus.subscribe((n) => {
      void reactor({
        handleBusNote: (n) => {
          seen.push(n.id)
          return Promise.resolve()
        },
      }).handleBusNote(n)
    })

    bus.publish({ id: 'a', type: 't', topic: undefined, audience: undefined })
    await settle()
    expect(seen).toEqual(['a'])
  })

  it('DEMONSTRATES THE BUG: simulated reload stacks subscriptions → N deliveries', async () => {
    const bus = new InProcessBus()
    const deliveries: string[] = []

    // Simulate what happens on HMR: module re-executes, subscribes to the bus
    // again, but the old subscription is still there (module state resets but
    // the InProcessBus is in a different module that didn't reload).
    const ensureReactor = () => {
      // Each call adds another subscriber to the same bus
      bus.subscribe((n) => {
        void reactor({
          handleBusNote: (n) => {
            deliveries.push(n.id)
            return Promise.resolve()
          },
        }).handleBusNote(n)
      })
    }

    ensureReactor() // initial load
    ensureReactor() // reload #1
    ensureReactor() // reload #2

    bus.publish({ id: 'x', type: 't', topic: undefined, audience: undefined })
    await settle()

    // BUG: the same reactor got the event THREE times
    expect(deliveries).toEqual(['x', 'x', 'x'])
  })

  it('WITH FIX: cleanup on disposal prevents stacking', async () => {
    const bus = new InProcessBus()
    const deliveries: string[] = []

    // Simulate the fix: store the unsubscribe and call it on reload
    let cleanup: (() => void) | undefined

    const ensureReactor = () => {
      // Clean up the old subscription if this is a reload
      cleanup?.()

      // Subscribe and save the unsubscribe callback
      cleanup = bus.subscribe((n) => {
        void reactor({
          handleBusNote: (n) => {
            deliveries.push(n.id)
            return Promise.resolve()
          },
        }).handleBusNote(n)
      })
    }

    ensureReactor() // initial load
    ensureReactor() // reload #1 (cleans up the old one first)
    ensureReactor() // reload #2 (cleans up the old one first)

    bus.publish({ id: 'y', type: 't', topic: undefined, audience: undefined })
    await settle()

    // FIXED: only the current (3rd) reactor receives the event
    expect(deliveries).toEqual(['y'])
  })

  it('DEMONSTRATES hook stacking: delivery hooks accumulate on reload', () => {
    const hooks: ((n: number) => void)[] = []
    const deliveries: number[] = []

    // Simulate onNotificationDelivered: just pushes onto the array
    const registerHook = (hook: (n: number) => void) => {
      hooks.push(hook)
    }

    // Simulate ensureChatOrchestrator: registers a hook each time
    const ensureOrchestrator = () => {
      registerHook((n) => {
        deliveries.push(n)
      })
    }

    ensureOrchestrator() // initial
    ensureOrchestrator() // reload #1
    ensureOrchestrator() // reload #2

    // Deliver a notification to all hooks
    for (const hook of hooks) {
      hook(42)
    }

    // BUG: 3 hooks registered, so 3 deliveries
    expect(deliveries).toEqual([42, 42, 42])
  })

  it('WITH FIX: returning unsubscribe prevents hook stacking', () => {
    const hooks: ((n: number) => void)[] = []
    const deliveries: number[] = []

    // Fixed: return an unsubscribe function
    const registerHook = (hook: (n: number) => void): (() => void) => {
      hooks.push(hook)
      return () => {
        const idx = hooks.indexOf(hook)
        if (idx !== -1) hooks.splice(idx, 1)
      }
    }

    let unsubscribe: (() => void) | undefined

    const ensureOrchestrator = () => {
      // Clean up the old hook before registering a new one
      unsubscribe?.()
      unsubscribe = registerHook((n) => {
        deliveries.push(n)
      })
    }

    ensureOrchestrator() // initial
    ensureOrchestrator() // reload #1 (cleans up old hook)
    ensureOrchestrator() // reload #2 (cleans up old hook)

    // Deliver a notification to all hooks
    for (const hook of hooks) {
      hook(42)
    }

    // FIXED: only 1 hook remains after cleanup
    expect(deliveries).toEqual([42])
  })
})
