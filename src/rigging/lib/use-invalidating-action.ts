import { useCallback } from 'react'
import { useRouter } from '@tanstack/react-router'

import { useServerAction } from './use-server-action'

/**
 * `useServerAction` plus the router refresh most actions end with: `act` runs
 * a door and then re-runs the loader, all inside the one busy window.
 *
 * The refresh is PART of the action, not something after it — `busy` has to
 * stay on until the loader has re-run and the change is on screen, or the
 * control re-arms for the tens of milliseconds the invalidate is in flight
 * and a second tap reaches a door that can only refuse it.
 *
 * `run` and `busy` come along for the actions whose refresh is different
 * (navigate instead of invalidate, or none at all).
 *
 * @example
 * const { busy, act } = useInvalidatingAction()
 * onDismiss={(id) => void act(() => dismissChatWidget({ data: { id } }))}
 */
export function useInvalidatingAction() {
  const { busy, run } = useServerAction()
  const router = useRouter()

  const act = useCallback(
    <T>(action: () => Promise<T>): Promise<T | undefined> =>
      run(async () => {
        const result = await action()
        await router.invalidate()
        return result
      }),
    [run, router],
  )

  return { busy, run, act }
}
