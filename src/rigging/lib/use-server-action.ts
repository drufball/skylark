import { useCallback, useRef, useState } from 'react'

/**
 * Manages the busy/try/finally lifecycle for server actions.
 *
 * Returns a `busy` flag and a `run` function that wraps any async action with:
 * - busy state management (setBusy(true) → action → setBusy(false))
 * - guarantees busy resets even if the action throws
 * - prevents concurrent execution (ignores new calls while busy)
 *
 * @example
 * const { busy, run } = useServerAction()
 *
 * async function save() {
 *   await run(() => saveData({ data }))
 * }
 */
export function useServerAction() {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const run = useCallback(
    async <T>(action: () => Promise<T>): Promise<T | undefined> => {
      if (busyRef.current) return undefined
      busyRef.current = true
      setBusy(true)
      try {
        return await action()
      } finally {
        busyRef.current = false
        setBusy(false)
      }
    },
    [],
  )

  return { busy, run }
}
