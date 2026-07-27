import { errorMessage } from './errors'

/**
 * A recurring background sweep: an unref'd interval that runs `tick(now())`
 * every `intervalMs`, swallowing (and logging) a tick's rejection so one bad
 * sweep never tears the timer down. Returns a `stop()` that cancels it.
 *
 * The clock and the timer are injected (defaulting to `Date.now` and an
 * unref'd `setInterval`), so the wiring is unit-tested without real time or a
 * real timer — a test hands in a `schedule` that captures the callback and a
 * `now` it controls, then fires ticks by hand. The live callers (files and
 * chat's live shells) take the defaults.
 *
 * arm-once is the CALLER's job (a module singleton owns the single timer per
 * process); this helper just wires one timer and hands back its canceller.
 */
export interface IntervalSweepDeps {
  /** How often to run the tick. */
  intervalMs: number
  /** The work each tick does, given the wall-clock ms — so a tick can be time-pure. */
  tick: (now: number) => Promise<unknown>
  /** Prefix for the console.error when a tick rejects. */
  label: string
  /** The clock; defaults to `Date.now`. Injected so a test can drive time. */
  now?: () => number
  /**
   * Arm a repeating timer and return its canceller; defaults to an unref'd
   * `setInterval`. Injected so a test can fire ticks by hand.
   */
  schedule?: (cb: () => void, ms: number) => () => void
}

export function startIntervalSweep(deps: IntervalSweepDeps): () => void {
  const now = deps.now ?? Date.now
  const schedule =
    deps.schedule ??
    /* v8 ignore start -- the real unref'd timer; tests inject a fake schedule */
    ((cb: () => void, ms: number): (() => void) => {
      const handle = setInterval(cb, ms)
      handle.unref()
      return () => {
        clearInterval(handle)
      }
    })
  /* v8 ignore stop */
  return schedule(() => {
    void Promise.resolve(deps.tick(now())).catch((err: unknown) => {
      console.error(`${deps.label}: sweep failed: ${errorMessage(err)}`)
    })
  }, deps.intervalMs)
}
