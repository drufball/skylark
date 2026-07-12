import { useEffect, useState } from 'react'

// Below Tailwind's `md` breakpoint, the list+content views with a docked
// sidebar (chat, agent-chat, files — see CollapsibleSidebar) collapse it into
// an off-canvas drawer instead. This is the one place that breakpoint is
// decided, so every view agrees on where it falls.

/** Tailwind's `md` breakpoint in pixels. */
export const MOBILE_BREAKPOINT = 768

/**
 * Is the viewport narrower than the mobile breakpoint? Tracks the live width
 * via `resize`, so a rotated phone or a resized window flips it without a
 * reload. Reads `window.innerWidth` directly (rather than matchMedia, which
 * jsdom doesn't implement) so the same code path runs in tests and browsers.
 *
 * Starts `false` (desktop) rather than reading `window` during render — this
 * runs through TanStack Start's SSR pass, where there is no `window` yet —
 * and corrects itself in an effect right after mount, before the first paint
 * a user actually sees.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    function onResize() {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return isMobile
}
