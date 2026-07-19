/**
 * Eager boot: arm all reactors at server start (crash-only recovery).
 *
 * DECISION (#lo0x): Server reloads are routine (HMR on merged code, the
 * done-refresh, the files sweep) and the notification/session mechanics must
 * survive them via CRASH-ONLY recovery, not a cooperative drain protocol.
 * Reloads are frequent and involuntary; a drain path would be bypassed by the
 * common case and is a second lifecycle to maintain.
 *
 * TWO PIECES:
 *
 * 1. EAGER BOOT — arm the issues orchestrator, chat orchestrator, notifications
 *    reactor, and files sweep at server START from this composition-root boot
 *    module, instead of lazily on first door use. After every reload, reconcile
 *    runs immediately and the deaf window is ~0.
 *
 * 2. ARM-ONCE without HMR cooperation — use globalThis-keyed registry to
 *    prevent duplicate subscriptions that survive module re-execution. The
 *    #xwh2 residual proved import.meta.hot.dispose hooks DON'T fire for SSR
 *    module reloads (post-#91 forced reload still delivered one message 3x).
 *
 * HMR LIMITATION: Changes to reactor code (orchestrator-live.ts modules) won't
 * be picked up by Vite HMR until a full server restart. This is the tradeoff of
 * crash-only design: we arm once via globalThis (survives module reload) to
 * prevent subscription stacking, which means HMR can't re-arm with updated code.
 * Restart the dev server (`npm run dev`) to see reactor code changes.
 *
 * This module is server-only and must be imported only from server.ts files.
 */

import { ensureChatOrchestrator } from '@hull/chat/orchestrator-live'
import { ensureOrchestrator } from '@hull/issues/orchestrator-live'
import { ensureNotificationsReactor } from '@hull/notifications/live'
import { liveFilesService } from '@hull/files/live'

/* v8 ignore start -- live wiring exercised by the running app */

// Server-only guard: this module imports server-only reactor code, so it must
// never run in the client bundle. The caller (a server.ts file) is responsible
// for only importing this on the server side.
if (typeof window !== 'undefined') {
  throw new Error(
    'boot.ts is server-only (imports reactor code) but was loaded in client bundle',
  )
}

/**
 * globalThis registry for arm-once protection. Survives module re-execution
 * (SSR reload resets module state but globalThis persists), so we can prevent
 * subscription stacking without cooperation from the dying module.
 */
interface BootRegistry {
  booted: boolean
}

interface GlobalWithBoot {
  __SKYLARK_BOOT__?: BootRegistry
}

function getBootRegistry(): BootRegistry {
  const g = globalThis as GlobalWithBoot
  g.__SKYLARK_BOOT__ ??= { booted: false }
  return g.__SKYLARK_BOOT__
}

/**
 * Boot all reactors: issues orchestrator, chat orchestrator, notifications
 * reactor, and files service. Idempotent via globalThis registry — safe to
 * call on every module execution, but only arms once.
 *
 * After a server reload, reconcile runs immediately for all orchestrators, so
 * the "deaf window" (time between reload and re-arming) is ~0.
 */
export function bootAllReactors(): void {
  const registry = getBootRegistry()
  if (registry.booted) return
  registry.booted = true

  // Issues orchestrator: reconcile marooned builds, react to ship-log events.
  // Its reconcile also sweeps background jobs stranded by the reload (#v6ft),
  // resuming each owed session with a "job lost" message — deliberately THERE,
  // at the tail of the issues reconcile on its runtime instance, not as a
  // separate call here: the ordering vs the stranded-'running' cancels is the
  // point (see reconcile() in @hull/issues/orchestrator).
  void ensureOrchestrator().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`boot: issues orchestrator failed: ${message}`)
  })

  // Chat orchestrator: reconcile pending agent replies, wake agents on notifications
  ensureChatOrchestrator()

  // Notifications reactor: fan out ship-log events to user inboxes
  ensureNotificationsReactor()

  // Files service: sweep staging branch to main on idle
  liveFilesService()
}

/**
 * Disarm the boot registry (for tests only). Allows re-booting in the same
 * process to verify arm-once behavior.
 */
export function disarmForTests(): void {
  const g = globalThis as GlobalWithBoot
  if (g.__SKYLARK_BOOT__) {
    g.__SKYLARK_BOOT__.booted = false
  }
}

/* v8 ignore stop */
