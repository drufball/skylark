import type { ComponentType, ReactNode } from 'react'
import {
  Anchor,
  Bell,
  Boxes,
  ChevronLeft,
  House,
  LogOut,
  MessageSquare,
  Users,
} from 'lucide-react'

import { TAP_TARGET } from '@rigging/lib/tap-target'
import { cn } from '@rigging/lib/utils'

// The rail: the ship's permanent, hardcoded navigation. Five entries — Home
// (your canvas), Chats (every conversation), Crew (people and agents), Models,
// Inbox (everything that needs you) — and a way out.
//
// **It is short and it is hardcoded on purpose.** Once the front door became
// your home canvas, navigation became DATA: which chats you're in, which pages
// you made, which tiles you kept. Data can be deleted, and a crew member can
// arrange their way into a corner where "where's my inbox?" turns into "which
// page had the inbox tile?" with no way back. The rail is the answer to that:
// it consults no row, it renders identically for a brand-new crew member with
// an empty home, and every other surface hangs off one of its five entries.
//
// Issues and Files are NOT here — each has a room (`rigging/rooms`), and the
// room links through to its richer view. Inbox left the rail the same way
// (#cse8) but comes BACK here now (#933f): a filtered `inbox` widget on a
// chat's canvas is a fine app-specific view of "this chat's unread", but
// "everything that needs me" is a different claim — a place you always go, not
// a thing you find by first opening a conversation — and that's what a
// permanent rail entry means. The Inbox ROOM (the @bix conversation) still
// exists and still carries the widget; it just no longer owns the route.
// Models stays for the same reason it always did: a settings surface is not a
// conversation, and the thesis is proven by what migrates well.
//
// Presentational and router-agnostic: the link element is injected so the rail
// is testable without a router and reusable across routes.

/** A surface with a place in the rail. A route without one highlights nothing. */
export type DockSection = 'home' | 'chats' | 'crew' | 'models' | 'inbox'

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
  { section: 'inbox', to: '/inbox', label: 'Inbox', Icon: Bell },
]

/** The most a rail badge ever spells out — past this it just says "a lot". */
const MAX_BADGE_COUNT = 99

/** "3", or "99+" once a count would otherwise grow the rail entry. */
function badgeText(count: number): string {
  return count > MAX_BADGE_COUNT ? `${String(MAX_BADGE_COUNT)}+` : String(count)
}

export interface DockProps {
  /**
   * The rail entry to highlight. Optional: `/issues` and `/files` are still
   * real surfaces you can be standing on, and neither one is a rail entry, so
   * they highlight nothing rather than lying.
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
   * The ROOM this surface belongs to, for the views that left the rail for a
   * room (`rigging/rooms`'s `roomForView`) — currently `/issues` and `/files`.
   * Undefined everywhere else, which is most places.
   *
   * It lives in the shell rather than in each view for the same reason the rail
   * does: it's the way OUT of a surface, so it has to be in the one place that's
   * always on screen, drawn identically, and impossible for a view to forget.
   * `/files` also settles the argument on its own — its header is inside a
   * sidebar that's a closed drawer on a phone, so a link put there would be
   * invisible on the device that needs it most.
   */
  room?: { to: string; label: string }
  /**
   * How many unread notifications are waiting — badged on the rail's Inbox
   * entry so a first-class destination can say how much is waiting without
   * being opened. `undefined`, `null`, or `0` all draw no badge; every route
   * but `/inbox` itself gets this live from `rigging/lib/use-unread-count`'s
   * `useUnreadCount` (backed by `hull/notifications/server.ts`'s
   * `unreadNotificationCount`), and `/inbox` passes its own loader's `unread`
   * straight through instead of subscribing twice.
   */
  unreadCount?: number | null
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
  unreadCount,
  children,
}: DockProps) {
  return (
    // h-dvh, not h-screen: 100vh is the LARGE viewport on a phone, which
    // would put the bottom rail behind the browser toolbar when visible.
    <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
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
        {/* The bottom padding is the safe-area inset when there is one (a phone
            installed to the home screen, viewport-fit=cover) so the rail's tap
            targets sit above the home indicator — never less than the normal
            gap. Explicit pt/pb rather than py so the md: override is
            unambiguous. */}
        <nav className="flex shrink-0 flex-row items-center gap-1 border-t bg-muted/30 px-1 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] md:w-16 md:flex-col md:items-center md:justify-start md:overflow-y-auto md:border-t-0 md:border-r md:px-0 md:pt-3 md:pb-3">
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
              badge={
                item.section === 'inbox' &&
                typeof unreadCount === 'number' &&
                unreadCount > 0
                  ? badgeText(unreadCount)
                  : null
              }
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
  badge,
}: {
  item: DockItem
  active: boolean
  Link: DockLink
  /** The rail badge's text, or null to draw none. */
  badge?: string | null
}) {
  const { Icon, label } = item

  return (
    <Link
      to={item.to}
      className={cn(
        RAIL_TARGET,
        'relative',
        'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        active && 'bg-accent text-accent-foreground',
      )}
    >
      <span className="relative">
        <Icon className="size-5" aria-current={active ? 'page' : undefined} />
        {badge && (
          <span
            data-testid="rail-badge"
            className="absolute -top-1.5 -right-2 rounded-full bg-primary px-1 text-[9px] leading-tight font-semibold text-primary-foreground"
          >
            {badge}
          </span>
        )}
      </span>
      {label}
    </Link>
  )
}
