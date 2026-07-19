/**
 * The ship's second pulse: how many commits `origin/main` is ahead of the
 * serving checkout's HEAD (issue #f70a). Merging a PR doesn't deploy it — the
 * serving checkout only moves when someone (or the sibling auto-sync PR) pulls
 * — so this is the "silent staleness" signal the UI surfaces when it's > 0.
 *
 * Pure logic, driver-agnostic like `service.ts`'s `shipHealth`: the real
 * `git fetch` + `git rev-list --count` lives at the exec edge in server.ts,
 * injected here as `fetchBehindCount`, so this module is testable with a fake
 * clock and a fake fetch — no repo, no network, no timers.
 */

export const BEHIND_ORIGIN_CACHE_MS = 5 * 60 * 1000

export interface BehindOriginCache {
  /** The last count seen, or null if the last check came back unknown. */
  behind: number | null
  /** When that answer was produced (ms epoch, from `deps.now()`). */
  fetchedAt: number
}

export interface BehindOriginDeps {
  /** The current time (ms epoch); injected so tests control cache expiry. */
  now(): number
  /**
   * Runs `git fetch origin main` then `git rev-list --count HEAD..origin/main`
   * against the serving checkout and returns the parsed count. Rejects on any
   * git or network failure (including output that doesn't parse) — the caller
   * treats every rejection the same way: unknown.
   */
  fetchBehindCount(): Promise<number>
}

/** The live process's cache — one process, one clock, one shared answer. */
const moduleCache: { current?: BehindOriginCache } = {}

/**
 * How many commits `origin/main` is ahead of HEAD, or `null` for "unknown".
 * At most one real fetch happens per `BEHIND_ORIGIN_CACHE_MS`: a call inside
 * the window reuses the cached count instead of shelling out again. Never
 * throws — a git/network failure just reports unknown, and a slow real fetch
 * only ever happens once per window rather than blocking every page load.
 *
 * `cache` defaults to this module's own singleton (what the live server door
 * uses); tests pass their own object so no run leaks state into another.
 */
export async function behindOrigin(
  deps: BehindOriginDeps,
  cache: { current?: BehindOriginCache } = moduleCache,
): Promise<number | null> {
  const now = deps.now()
  if (cache.current && now - cache.current.fetchedAt < BEHIND_ORIGIN_CACHE_MS) {
    return cache.current.behind
  }

  let behind: number | null
  try {
    behind = await deps.fetchBehindCount()
  } catch {
    behind = null
  }
  cache.current = { behind, fetchedAt: now }
  return behind
}
