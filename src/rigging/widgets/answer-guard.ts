import { useState } from 'react'

/**
 * Which widgets this crew member has already answered on this surface, so a
 * second tap can't fire a second answer the door would only refuse.
 *
 * The host's `busy` flag isn't enough on its own. It drops the moment the write
 * returns, but the answered tile is still on screen until the refetched loader
 * data lands — a window of a few dozen milliseconds with live buttons on a
 * widget that is already gone, which a thumb goes straight through. (Seen on a
 * phone as an uncaught "this widget has already been answered".)
 *
 * Shared by the stack and the canvas rather than copied into each, because the
 * two surfaces answer the SAME rows through the same door: a double tap has to
 * mean the same thing whichever one it lands on.
 */
export function useAnswerGuard(busy: boolean): {
  spent: (widgetId: string) => boolean
  mark: (widgetId: string) => void
} {
  const [answered, setAnswered] = useState<string[]>([])

  // Forget what's spent the moment the host stops being busy. On a successful
  // answer the widget has left the surface anyway; on a FAILED one it's still
  // here, and it has to be answerable again rather than sitting there with dead
  // buttons forever. Compared during render so the first paint after the request
  // settles is already right.
  const [wasBusy, setWasBusy] = useState(busy)
  if (wasBusy !== busy) {
    setWasBusy(busy)
    if (!busy) setAnswered([])
  }

  return {
    spent: (widgetId) => busy || answered.includes(widgetId),
    mark: (widgetId) => {
      setAnswered((ids) => [...ids, widgetId])
    },
  }
}
