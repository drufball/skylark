import { systemDb } from '@hull/db/client'
import { ensureOrchestrator } from '@hull/issues/orchestrator-live'
import { startIntervalSweep } from '@hull/lib/interval-sweep'

import { resolveWatchConfig, runWatchSweep } from './service'

/* v8 ignore start -- live wiring: the unref'd timer, the globalThis arm-once,
   and the bridge to the issues orchestrator's runtime. The watch's DECISIONS
   and its whole sweep are unit-tested against PGlite with a fake clock and an
   injected driveTurn in service.test.ts; this file only connects them to the
   running ship, exactly as the chat/files live shells are treated. */

/**
 * The night watch's live shell: a ~60s sweep that nudges stalled builds and
 * health-checks long background waits. Armed once per process from
 * bootAllReactors, AFTER the issues orchestrator so the first tick never fires
 * on pre-reconcile state (the sweep's interval floor makes "after reconcile" a
 * non-issue in practice — the async reconcile has long settled by the first
 * tick 60s in).
 *
 * Every drive goes through the issues orchestrator's OWN runtime
 * (`ensureOrchestrator()` returns the same memoized instance boot armed), never
 * a fresh one — issue-backed sessions may only be driven from the runtime that
 * owns them (#69iz), and that runtime's queue is what keeps a nudge from
 * double-driving a session mid-turn.
 */

let stopSweep: (() => void) | undefined

interface GlobalWithWatch {
  __SKYLARK_WATCH__?: { armed: boolean }
}

function getRegistry(): { armed: boolean } {
  const g = globalThis as GlobalWithWatch
  g.__SKYLARK_WATCH__ ??= { armed: false }
  return g.__SKYLARK_WATCH__
}

/**
 * Boot the watch sweep into this process (idempotent). Arm-once via a
 * globalThis registry that survives module re-execution (SSR reload resets
 * module state but globalThis persists), so the timer never stacks even without
 * import.meta.hot.dispose cooperation — the same pattern the orchestrators use.
 */
export function ensureWatchService(): void {
  const registry = getRegistry()
  if (registry.armed) return
  registry.armed = true

  // On HMR reload, module state resets but a prior interval may still be live;
  // cancel it before arming a fresh one.
  stopSweep?.()

  const config = resolveWatchConfig(process.env)
  stopSweep = startIntervalSweep({
    intervalMs: config.sweepMs,
    label: 'night watch',
    tick: async (now) => {
      // Get the SAME orchestrator boot armed — its runtime owns issue sessions.
      const orch = await ensureOrchestrator()
      await runWatchSweep(systemDb, {
        now: new Date(now),
        config,
        driveTurn: (issueId, sessionId, text) => {
          orch.driveTurn(issueId, sessionId, text)
        },
      })
    },
  })
}
/* v8 ignore stop */
