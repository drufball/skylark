import type { ComponentType, ReactNode } from 'react'
import {
  Anchor,
  Boxes,
  ChevronLeft,
  House,
  LogOut,
  MessageSquare,
  Users,
} from 'lucide-react'

import { TAP_TARGET } from '@rigging/lib/tap-target'
import { cn } from '@rigging/lib/utils'

// The rail: the ship's permanent, hardcoded navigation. Four entries — Home
// (your canvas), Chats (every conversation), Crew (people and agents), Models —
// and a way out.
//
// **It is short and it is hardcoded on purpose.** Once the front door became
// your home canvas, navigation became DATA: which chats you're in, which pages
// you made, which tiles you kept. Data can be deleted, and a crew member can
// arrange their way into a corner where "where's my inbox?" turns into "which
// page had the inbox tile?" with no way back. The rail is the answer to that:
// it consults no row, it renders identically for a brand-new crew member with
// an empty home, and every other surface hangs off one of its four entries.
//
// Issues, Files and Inbox are NOT here any more — each has a room now
// (`rigging/rooms`), and the room links through to its richer view. That's the
// thesis: the apps were conversations. Models stays, because a settings surface
// is not a conversation and the thesis is proven by what migrates well.
//
// Presentational and router-agnostic: the link element is injected so the rail
// is testable without a router and reusable across routes.

/** A surface with a place in the rail. A route without one highlights nothing. */
export type DockSection = 'home' | 'chats' | 'crew' | 'models'

/** A navigation link, injected so the dock doesn't depend on a router. */
export type DockLink = ComponentType<{
  to: string
  className?: string
  children: ReactNode
}>

interface DockItem {
  section: DockSection
  to: string
  label: string
  Icon: typeof Anchor
}

/**
 * The rail, exported because it's a claim other tests check: `navigation.test.ts`
 * holds that every route in the ship is reachable from here or from a default
 * room, so no view can quietly become an orphan.
 */
export const RAIL: readonly DockItem[] = [
  { section: 'home', to: '/', label: 'Home', Icon: House },
  { section: 'chats', to: '/chat', label: 'Chats', Icon: MessageSquare },
  { section: 'crew', to: '/agents', label: 'Crew', Icon: Users },
  { section: 'models', to: '/models', label: 'Models', Icon: Boxes },
]

export interface DockProps {
  /**
   * The rail entry to highlight. Optional: `/issues`, `/files` and `/inbox` are
   * still real surfaces you can be standing on, and none of the four is where
   * you are, so they highlight nothing rather than lying.
   */
  active?: DockSection
  /** The router's Link component (or a stand-in in tests). */
  Link: DockLink
  /** Ends the session and returns to /login. */
  onLogout: () => void
  /**
   * How many commits `origin/main` is ahead of the serving checkout (issue
   * #f70a) — undefined, null, or 0 all mean "nothing to say," so the banner
   * renders only for a genuine positive count.
   */
  behindOrigin?: number | null
  /**
   * The ROOM this surface belongs to, for the three views that left the rail
   * (`rigging/rooms`'s `roomForView`). Undefined everywhere else, which is most
   * places.
   *
   * It lives in the shell rather than in each view for the same reason the rail
   * does: it's the way OUT of a surface, so it has to be in the one place that's
   * always on screen, drawn identically, and impossible for a view to forget.
   * `/files` also settles the argument on its own — its header is inside a
   * sidebar that's a closed drawer on a phone, so a link put there would be
   * invisible on the device that needs it most.
   */
  room?: { to: string; label: string }
  children: ReactNode
}

/** A rail target: thumb-sized on a phone, dense enough for a 64px column. */
const RAIL_TARGET =
  'flex min-h-14 flex-1 flex-col items-center justify-center gap-1 rounded-md px-1 text-[10px] font-medium md:w-14 md:flex-none'

/**
 * The app shell: the permanent rail plus the active surface. On a phone the
 * rail is a bar across the bottom, where a thumb already is and where it costs
 * height rather than a sixth of a 390px screen's width; from `md` up it's the
 * slim left column. One element, two layouts, decided in CSS rather than by
 * `useIsMobile` — the rail has to be right on the very first paint, and a
 * measured breakpoint isn't known until after mount.
 */
export function Dock({
  active,
  Link,
  onLogout,
  behindOrigin,
  room,
  children,
}: DockProps) {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {typeof behindOrigin === 'number' && behindOrigin > 0 && (
        <div className="flex shrink-0 items-center justify-center gap-1.5 border-b bg-amber-500/10 px-3 py-1 text-center text-xs text-amber-700 dark:text-amber-400">
          <span aria-hidden>⚓</span>
          <span>
            ship is {behindOrigin} commit{behindOrigin === 1 ? '' : 's'} behind
            origin — merged work isn&apos;t live yet
          </span>
        </div>
      )}
      {/* `flex-col-reverse` puts the nav (first in the DOM, so first in the tab
          order) visually last on a phone. */}
      <div className="flex min-h-0 flex-1 flex-col-reverse md:flex-row">
        <nav className="flex shrink-0 flex-row items-center gap-1 border-t bg-muted/30 px-1 py-1 md:w-16 md:flex-col md:items-center md:justify-start md:overflow-y-auto md:border-t-0 md:border-r md:px-0 md:py-3">
          <Anchor
            className="mb-3 hidden size-6 text-muted-foreground md:block"
            aria-label="Skylark"
          />
          {RAIL.map((item) => (
            <DockButton
              key={item.section}
              item={item}
              active={item.section === active}
              Link={Link}
            />
          ))}
          <button
            type="button"
            onClick={onLogout}
            className={cn(
              RAIL_TARGET,
              'md:mt-auto',
              'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <LogOut className="size-5" />
            Log out
          </button>
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {room && (
            <div className="flex shrink-0 items-center border-b bg-muted/20 px-1">
              <Link
                to={room.to}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 text-sm',
                  'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  TAP_TARGET,
                )}
              >
                <ChevronLeft className="size-4" />
                {room.label}
              </Link>
            </div>
          )}
          {/* overflow-y-auto is a fallback for a surface that manages no internal
              scroll of its own (e.g. Models) — a surface that fills this slot
              exactly (chat/issues/files/inbox, each already h-full + its own
              ScrollArea) never grows past it, so this never triggers for them. */}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

function DockButton({
  item,
  active,
  Link,
}: {
  item: DockItem
  active: boolean
  Link: DockLink
}) {
  const { Icon, label } = item

  return (
    <Link
      to={item.to}
      className={cn(
        RAIL_TARGET,
        'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        active && 'bg-accent text-accent-foreground',
      )}
    >
      <Icon className="size-5" aria-current={active ? 'page' : undefined} />
      {label}
    </Link>
  )
}
